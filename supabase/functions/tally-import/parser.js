/**
 * Pure Tally XML → staged-row parser.
 *
 * Kept free of Deno/npm: imports so it can be unit-tested in Node. The edge
 * function injects fast-xml-parser (`deps`) and DB-derived context (`options`).
 *
 * Sign convention used by Tally's XML export (and relied on below):
 *   - Debit  amounts are NEGATIVE, credit amounts are POSITIVE.
 *   - Ledger balances therefore also arrive Dr = negative, Cr = positive.
 *
 * Stored convention (what the rest of the app sees):
 *   - Ledger / party balances are "natural": positive = the balance sits on the
 *     ledger's normal side (assets & expenses: Dr, liabilities & income: Cr).
 *     A negative value means the opposite side (bank overdraft, customer advance).
 *   - Voucher ledger_entries keep magnitude + an explicit is_debit flag.
 */

export const asArray = (value) => (value == null ? [] : Array.isArray(value) ? value : [value])

export const val = (value) => {
  if (value == null) return ''
  if (typeof value === 'object') return '#text' in value ? String(value['#text'] ?? '').trim() : ''
  return String(value).trim()
}

const NUMBER_RE = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)/

/** First number in the text, magnitude only (quantities, rates). "10 Nos" → 10. */
export const magnitude = (value) => {
  const raw = val(value)
  if (!raw) return 0
  const match = raw.replace(/,/g, '').match(NUMBER_RE)
  if (!match) return 0
  const parsed = Math.abs(Number(match[0]))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Signed amount in Tally's convention (Dr negative, Cr positive).
 * Understands plain signed numbers, "(1,234.00)", and "1,234.00 Dr/Cr" suffixes.
 */
export const signedAmount = (value) => {
  const raw = val(value)
  if (!raw) return 0
  const cleaned = raw.replace(/,/g, '')
  const match = cleaned.match(NUMBER_RE)
  if (!match) return 0
  let parsed = Number(match[0])
  if (!Number.isFinite(parsed)) return 0
  if (/\bDr\.?\s*$/i.test(cleaned)) parsed = -Math.abs(parsed)
  else if (/\bCr\.?\s*$/i.test(cleaned)) parsed = Math.abs(parsed)
  else if (/^\(.*\)$/.test(cleaned.trim())) parsed = -Math.abs(parsed)
  return parsed
}

export const maybeSigned = (value) => (val(value) === '' ? null : signedAmount(value))

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const validIsoDate = (value) => {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export const normalDate = (value) => {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : val(value)
  if (/^\d{8}$/.test(raw)) {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    return validIsoDate(iso) ? iso : ''
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validIsoDate(raw) ? raw : ''
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(raw)) {
    const parts = raw.split(/[-/]/)
    const iso = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`
    return validIsoDate(iso) ? iso : ''
  }
  const named = raw.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]*(\d{4})$/)
  if (named) {
    const month = MONTHS.indexOf(named[2].toLowerCase()) + 1
    if (month > 0) {
      const iso = `${named[3]}-${String(month).padStart(2, '0')}-${named[1].padStart(2, '0')}`
      return validIsoDate(iso) ? iso : ''
    }
  }
  return ''
}

export const digest = async (input) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const collectNamed = (object, wanted, output = []) => {
  if (!object || typeof object !== 'object') return output
  if (Array.isArray(object)) { for (const item of object) collectNamed(item, wanted, output); return output }
  for (const [key, child] of Object.entries(object)) {
    if (key.toUpperCase() === wanted.toUpperCase()) output.push(...asArray(child))
    if (child && typeof child === 'object') collectNamed(child, wanted, output)
  }
  return output
}

export const first = (object, keys) => {
  for (const key of keys) if (object?.[key] != null && val(object[key]) !== '') return object[key]
  return ''
}

const isYes = (value) => /^yes$/i.test(val(value))

// ─── Voucher types ───────────────────────────────────────────────────────────

/** Types that never touch the books (orders, delivery/receipt notes, memos, stock-only vouchers). */
const NON_ACCOUNTING = /(order|delivery note|receipt note|rejection|stock journal|physical stock|material (in|out)|memorandum|reversing journal|job work|manufacturing)/i

/**
 * Classify a Tally voucher-type name.
 * Returns { type, ignore }. `ignore` = valid Tally voucher that must not be imported.
 * `type` is '' (and ignore false) when the name is unrecognised → staged as an error.
 */
export function classifyVoucherType(name) {
  const type = val(name).toLowerCase()
  if (!type) return { type: '', ignore: false }
  if (NON_ACCOUNTING.test(type)) return { type: '', ignore: true }
  if (/credit note|sales return/.test(type)) return { type: 'credit_note', ignore: false }
  if (/debit note|purchase return/.test(type)) return { type: 'debit_note', ignore: false }
  if (type.includes('sale')) return { type: 'sales', ignore: false }
  if (type.includes('purchase')) return { type: 'purchase', ignore: false }
  if (type.includes('receipt')) return { type: 'receipt', ignore: false }
  if (type.includes('payment')) return { type: 'payment', ignore: false }
  if (type.includes('contra')) return { type: 'contra', ignore: false }
  if (type.includes('journal')) return { type: 'journal', ignore: false }
  return { type: '', ignore: false }
}

// ─── Account groups ──────────────────────────────────────────────────────────

const clean = (text) => val(text).replace(/[\u0000-\u001f]/g, '').trim()

/** Walk a group up to its primary (reserved) group using a {name: parent} map. */
export function resolveRootGroup(group, groupParents = {}) {
  const lookup = new Map(Object.entries(groupParents).map(([name, parent]) => [clean(name).toLowerCase(), clean(parent)]))
  let current = clean(group)
  for (let hops = 0; hops < 25; hops += 1) {
    const parent = lookup.get(current.toLowerCase())
    if (!parent || /^primary$/i.test(parent) || parent.toLowerCase() === current.toLowerCase()) return current
    current = parent
  }
  return current
}

const EXACT_CATEGORY = new Map([
  ['direct expenses', 'expense'], ['indirect expenses', 'expense'], ['purchase accounts', 'expense'],
  ['direct incomes', 'income'], ['indirect incomes', 'income'], ['sales accounts', 'income'],
  ['capital account', 'liability'], ['reserves & surplus', 'liability'], ['current liabilities', 'liability'],
  ['duties & taxes', 'liability'], ['provisions', 'liability'], ['sundry creditors', 'liability'],
  ['loans (liability)', 'liability'], ['secured loans', 'liability'], ['unsecured loans', 'liability'],
  ['bank od a/c', 'liability'], ['retained earnings', 'liability'],
  ['bank accounts', 'asset'], ['cash-in-hand', 'asset'], ['current assets', 'asset'], ['deposits (asset)', 'asset'],
  ['fixed assets', 'asset'], ['investments', 'asset'], ['loans & advances (asset)', 'asset'],
  ['stock-in-hand', 'asset'], ['sundry debtors', 'asset'], ['misc. expenses (asset)', 'asset'],
  ['branch / divisions', 'asset'], ['suspense a/c', 'asset'],
])

/** Mirror of src/lib/tallyLedgerCategory.js — a test keeps the two identical. */
export function categoryForGroup(group) {
  const name = clean(group).toLowerCase()
  if (EXACT_CATEGORY.has(name)) return EXACT_CATEGORY.get(name)
  if (name.includes('expense') || name.includes('purchase account')) return 'expense'
  if (name.includes('income') || name.includes('sales account')) return 'income'
  if (/\(asset\)|advance|deposit|debtor|customer|bank account|cash|stock|fixed asset|investment|current asset/.test(name)) return 'asset'
  if (/liabilit|creditor|supplier|capital|loan|provision|duties|tax|reserve|surplus|bank od|overdraft/.test(name)) return 'liability'
  if (/rent|maintenance|salaries|salary|staff|welfare|brokerage|electricity|stationary|stationery|depreciation/.test(name)) return 'expense'
  return 'asset'
}

export const partyTypeForGroup = (rootGroup) => {
  const name = clean(rootGroup).toLowerCase()
  if (name === 'sundry debtors' || name.includes('debtor') || name.includes('customer')) return 'debtor'
  if (name === 'sundry creditors' || name.includes('creditor') || name.includes('supplier')) return 'creditor'
  return ''
}

/** Dr-normal categories store balance = -tallyValue; Cr-normal store +tallyValue. */
const naturalBalance = (tallyValue, category) =>
  tallyValue === null ? null : (category === 'asset' || category === 'expense' ? -tallyValue : tallyValue)

// ─── Vouchers ────────────────────────────────────────────────────────────────

const CASH_NAME = /^(counter\s+)?cash(\s+(in\s+hand|a\/c|account|sales?))?$|^petty\s+cash$/i

function voucherLines(voucher) {
  // Tally can expose the same posting under both ALLLEDGERENTRIES.LIST and
  // LEDGERENTRIES.LIST. Never union them: that double-counts every posting.
  const allLedger = asArray(voucher['ALLLEDGERENTRIES.LIST'])
  const ledgerList = allLedger.length ? allLedger : asArray(voucher['LEDGERENTRIES.LIST'])
  const allInventory = asArray(voucher['ALLINVENTORYENTRIES.LIST'])
  const inventoryEntries = allInventory.length ? allInventory : asArray(voucher['INVENTORYENTRIES.LIST'])
  const allocations = inventoryEntries.flatMap((item) => asArray(item['ACCOUNTINGALLOCATIONS.LIST']))
  return { ledgerList: [...ledgerList, ...allocations], inventoryEntries }
}

export async function buildVoucherPayload(voucher, company, { cashLedgerNames = new Set() } = {}) {
  const classification = classifyVoucherType(first(voucher, ['@_VCHTYPE', 'VOUCHERTYPENAME', 'VOUCHERTYPE']))
  const { ledgerList, inventoryEntries } = voucherLines(voucher)

  const ledgerEntries = ledgerList.map((entry) => {
    const signed = signedAmount(entry.AMOUNT)
    return {
      ledger_name: val(first(entry, ['LEDGERNAME'])),
      amount: Math.abs(signed),
      // The sign is authoritative; ISDEEMEDPOSITIVE only breaks ties on zero lines.
      is_debit: signed !== 0 ? signed < 0 : isYes(entry.ISDEEMEDPOSITIVE),
      signed,
    }
  }).filter((entry) => entry.ledger_name && entry.amount > 0)

  const items = inventoryEntries.map((item) => ({
    name: val(first(item, ['STOCKITEMNAME', 'NAME'])),
    qty: magnitude(first(item, ['BILLEDQTY', 'ACTUALQTY'])),
    rate: magnitude(item.RATE),
    amount: Math.abs(signedAmount(item.AMOUNT)),
  })).filter((item) => item.name)

  const partyName = val(first(voucher, ['PARTYLEDGERNAME', 'PARTYNAME'])) || 'Cash'
  const partyKey = partyName.toLowerCase()
  const isCashParty = CASH_NAME.test(partyName) || cashLedgerNames.has(partyKey)
  const type = classification.type

  const debitTotal = ledgerEntries.filter((e) => e.is_debit).reduce((s, e) => s + e.amount, 0)
  const creditTotal = ledgerEntries.filter((e) => !e.is_debit).reduce((s, e) => s + e.amount, 0)
  const inventoryTotal = items.reduce((s, i) => s + i.amount, 0)
  // A balanced voucher has debits == credits; the larger side is the voucher value
  // (guards against partially exported postings). Item totals are only a last resort
  // because discounts/taxes make them differ from what the party actually owes.
  const amount = Math.max(debitTotal, creditTotal) || Math.abs(signedAmount(first(voucher, ['AMOUNT']))) || inventoryTotal

  const partyNet = ledgerEntries.filter((e) => e.ledger_name.toLowerCase() === partyKey).reduce((s, e) => s + e.signed, 0)
  const hasPostings = ledgerEntries.length > 0
  let due = 0
  if (type === 'sales' && !isCashParty) {
    due = hasPostings ? (partyNet < 0 ? Math.min(amount, -partyNet) : 0) : amount
  } else if (type === 'purchase' && !isCashParty) {
    due = hasPostings ? (partyNet > 0 ? Math.min(amount, partyNet) : 0) : amount
  }
  const paid = type === 'sales' || type === 'purchase' ? Math.max(0, amount - due)
    : type === 'receipt' || type === 'payment' ? amount : 0

  const payload = {
    voucher_no: val(first(voucher, ['VOUCHERNUMBER', 'VOUCHERNO', 'MASTERID'])),
    voucher_type: type,
    date: normalDate(first(voucher, ['DATE', 'EFFECTIVEDATE'])),
    party_name: partyName,
    party_uid: '',
    amount, paid_amount: paid, due_amount: due,
    payment_mode: 'Tally import',
    items,
    ledger_entries: ledgerEntries.map(({ signed: _signed, ...entry }) => entry),
    narration: val(voucher.NARRATION),
    reference_no: val(first(voucher, ['REFERENCE', 'REFERENCEID'])),
    source_voucher_guid: val(first(voucher, ['GUID', 'MASTERID'])),
    source_company: company || 'default',
    source_system: 'tally',
  }
  payload.source_hash = await digest(JSON.stringify(payload))
  return payload
}

// ─── Document ────────────────────────────────────────────────────────────────

/**
 * @param {string} text   Tally XML
 * @param {string} company
 * @param {{XMLParser: any, XMLValidator: any}} deps
 * @param {{groupParents?: Record<string,string>, cashLedgerNames?: Set<string>}} [options]
 * @returns {Promise<{rows: Array, ignored: {nonAccounting: number, cancelled: number, optional: number}}>}
 */
export async function parseTallyXml(text, company, deps, options = {}) {
  const { XMLParser, XMLValidator } = deps
  const groupParents = options.groupParents || {}
  const validation = XMLValidator.validate(text)
  if (validation !== true) throw new Error('Invalid XML: ' + (validation.err?.msg || 'document validation failed'))
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true }).parse(text)
  const rows = []
  const ignored = { nonAccounting: 0, cancelled: 0, optional: 0 }

  for (const voucher of collectNamed(parsed, 'VOUCHER')) {
    if (isYes(voucher.ISCANCELLED)) { ignored.cancelled += 1; continue }
    if (isYes(voucher.ISOPTIONAL)) { ignored.optional += 1; continue }
    const kind = classifyVoucherType(first(voucher, ['@_VCHTYPE', 'VOUCHERTYPENAME', 'VOUCHERTYPE']))
    if (kind.ignore) { ignored.nonAccounting += 1; continue }
    rows.push({ rowType: 'voucher', payload: await buildVoucherPayload(voucher, company, options) })
  }

  for (const ledger of collectNamed(parsed, 'LEDGER')) {
    const name = val(first(ledger, ['@_NAME', 'NAME']))
    if (!name) continue
    const group = val(first(ledger, ['PARENT'])) || 'General'
    const rootGroup = resolveRootGroup(group, groupParents)
    const category = categoryForGroup(rootGroup)
    const opening = maybeSigned(first(ledger, ['OPENINGBALANCE']))
    const closing = maybeSigned(first(ledger, ['CLOSINGBALANCE']))
    const openingNatural = naturalBalance(opening, category) ?? 0
    const closingNatural = naturalBalance(closing, category)
    const type = partyTypeForGroup(rootGroup)
    const payload = {
      name, group, primary_group: rootGroup, category,
      opening_balance: openingNatural,
      current_balance: closingNatural ?? openingNatural,
      closing_balance: closingNatural,
      phone: val(first(ledger, ['LEDGERPHONE', 'PHONE'])), email: val(first(ledger, ['EMAIL'])), address: val(first(ledger, ['ADDRESS'])),
    }
    rows.push({ rowType: type ? 'party' : 'ledger', payload: type ? { ...payload, type } : payload })
  }

  const skuFor = async (name) => 'TALLY-' + (await digest(name.toLowerCase())).slice(0, 12).toUpperCase()

  for (const stock of collectNamed(parsed, 'STOCKITEM')) {
    const name = val(first(stock, ['@_NAME', 'NAME']))
    if (!name) continue
    const closingQty = maybeSigned(first(stock, ['CLOSINGBALANCE']))
    const openingQty = maybeSigned(first(stock, ['OPENINGBALANCE']))
    const closingValue = maybeSigned(first(stock, ['CLOSINGVALUE']))
    const closingRate = val(first(stock, ['CLOSINGRATE'])) === '' ? null : magnitude(first(stock, ['CLOSINGRATE']))
    const openingRate = val(first(stock, ['OPENINGRATE'])) === '' ? null : magnitude(first(stock, ['OPENINGRATE']))
    const salesRate = val(first(stock, ['BASESELLPRICE', 'SALEPRICE'])) === '' ? null : magnitude(first(stock, ['BASESELLPRICE', 'SALEPRICE']))
    const currentQty = closingQty ?? openingQty
    rows.push({ rowType: 'stock_item', payload: {
      name, sku: await skuFor(name),
      category: val(first(stock, ['PARENT'])) || 'General', unit: val(first(stock, ['BASEUNITS'])) || 'pcs',
      // Tally allows negative stock; keep the sign so oversold items are not shown as healthy.
      ...(currentQty !== null ? { current_qty: currentQty } : {}),
      ...(closingValue !== null ? { current_value: closingValue } : {}),
      ...(closingRate !== null || openingRate !== null ? { purchase_rate: closingRate ?? openingRate } : {}),
      ...(salesRate !== null ? { sales_rate: salesRate } : {}),
    } })
  }

  // Item-wise Stock Summary: live quantity / average rate / value.
  const summaryNames = collectNamed(parsed, 'DSPACCNAME')
  const summaryInfo = collectNamed(parsed, 'DSPSTKINFO')
  for (let index = 0; index < Math.min(summaryNames.length, summaryInfo.length); index += 1) {
    const name = val(first(summaryNames[index], ['DSPDISPNAME']))
    if (!name) continue
    const closing = first(summaryInfo[index], ['DSPSTKCL'])
    if (!closing || typeof closing !== 'object') continue
    const quantityText = val(first(closing, ['DSPCLQTY']))
    const quantity = maybeSigned(quantityText)
    const rateText = val(first(closing, ['DSPCLRATE']))
    const value = maybeSigned(first(closing, ['DSPCLAMTA']))
    const unit = quantityText.match(/\s+([\p{L}][\p{L} ._-]*)\s*$/u)?.[1]?.trim()
    rows.push({ rowType: 'stock_item', payload: {
      name, sku: await skuFor(name),
      ...(unit ? { unit } : {}),
      ...(quantity !== null ? { current_qty: quantity } : {}),
      ...(rateText !== '' ? { purchase_rate: magnitude(rateText) } : {}),
      ...(value !== null ? { current_value: value } : {}),
    } })
  }

  return { rows, ignored }
}
