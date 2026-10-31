/**
 * Pure, testable Tally XML parser shared by the Supabase Edge Function and Node unit tests.
 */

export const val = (value) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim()

export const num = (value) => {
  const cleaned = val(value).replace(/,/g, '')
  const match = cleaned.match(/[+-]?\d+(?:\.\d+)?/)
  const parsed = match ? Number(match[0]) : 0
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Parse a signed Tally amount.
 * In Tally XML:
 *  - Debit entries/balances are negative (or have ISDEEMEDPOSITIVE="Yes", trailing "Dr", or parentheses "(200.00)").
 *  - Credit entries/balances are positive (or have ISDEEMEDPOSITIVE="No" or trailing "Cr").
 */
export function signedAmount(value, isDeemedPositive = null) {
  const raw = val(value).replace(/,/g, '')
  if (!raw) return 0
  const isParen = /^\s*\(.*\)\s*$/.test(raw)
  const match = raw.match(/([+-])?\s*\d+(?:\.\d+)?/)
  if (!match) return 0
  const magnitude = Math.abs(Number(match[0].replace(/\s+/g, '')))
  if (!Number.isFinite(magnitude) || magnitude === 0) return 0

  const hasMinus = isParen || match[1] === '-' || /^\s*-/.test(raw)
  const hasDr = /\bdr\.?\s*$/i.test(raw)
  const hasCr = /\bcr\.?\s*$/i.test(raw)
  const deemedYes = typeof isDeemedPositive === 'string' && /^yes$/i.test(isDeemedPositive.trim())
  const deemedNo = typeof isDeemedPositive === 'string' && /^no$/i.test(isDeemedPositive.trim())

  if (hasMinus || hasDr) return -magnitude
  if (hasCr) return magnitude
  if (deemedYes) return -magnitude
  if (deemedNo) return magnitude
  return magnitude
}

/**
 * Convert a Tally signed balance (negative = Debit, positive = Credit) into the natural
 * balance convention of its category:
 *  - asset / expense: normal balance is Debit -> multiply by -1 (so Debit is + and Credit is -)
 *  - liability / income: normal balance is Credit -> multiply by +1 (so Credit is + and Debit is -)
 */
export function normalBalanceSign(category) {
  return category === 'liability' || category === 'income' ? 1 : -1
}

export const normalDate = (value) => {
  const raw = val(value)
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

const normalized = (value) => val(value).toLowerCase()

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

export function categoryForGroup(group) {
  const name = normalized(group)
  if (EXACT_CATEGORY.has(name)) return EXACT_CATEGORY.get(name)
  if (name.includes('expense') || name.includes('purchase account')) return 'expense'
  if (name.includes('income') || name.includes('sales account')) return 'income'
  if (/\(asset\)|advance|deposit|debtor|customer|bank account|cash|stock|fixed asset|investment|current asset/.test(name)) return 'asset'
  if (/liabilit|creditor|supplier|capital|loan|provision|duties|tax|reserve|surplus|bank od|overdraft/.test(name)) return 'liability'
  return 'asset'
}

export const ledgerCategory = categoryForGroup

export function partyType(group) {
  const name = normalized(group)
  if (name === 'sundry debtors' || name.includes('debtor') || name.includes('customer')) return 'debtor'
  if (name === 'sundry creditors' || name.includes('creditor') || name.includes('supplier')) return 'creditor'
  return ''
}

/**
 * Walk the exported group hierarchy (`child -> parent`) up to a reserved Tally primary group.
 */
export function resolveRootGroup(group, groupParents = {}) {
  let current = val(group)
  if (!current) return ''
  const lookup = new Map(
    Object.entries(groupParents || {}).map(([k, v]) => [normalized(k), val(v)])
  )
  const visited = new Set()
  while (current && !visited.has(normalized(current))) {
    const key = normalized(current)
    visited.add(key)
    if (EXACT_CATEGORY.has(key)) return current
    const parent = lookup.get(key)
    if (!parent || normalized(parent) === 'primary' || normalized(parent) === ' primary') break
    current = parent
  }
  return current
}

export const resolvePrimaryGroup = resolveRootGroup

const NON_ACCOUNTING_PATTERNS = [
  /\bsales\s+order\b/i,
  /\bpurchase\s+order\b/i,
  /\bjob\s+work\b/i,
  /\bdelivery\s+note\b/i,
  /\breceipt\s+note\b/i,
  /\brejections?\s+in\b/i,
  /\brejections?\s+out\b/i,
  /\bstock\s+journal\b/i,
  /\bphysical\s+stock\b/i,
  /\bmaterial\s+in\b/i,
  /\bmaterial\s+out\b/i,
  /\bmemorandum\b/i,
  /\breversing\s+journal\b/i,
  /\bpayroll\b/i,
  /\battendance\b/i,
]

/**
 * Deterministic voucher type classifier.
 * Avoids naive substring matching (e.g. "Sales Order" -> sales, "Receipt Note" -> receipt).
 */
export function classifyVoucherType(raw) {
  const text = normalized(raw).replace(/\s+/g, ' ')
  if (!text) return { type: '', ignore: false }

  for (const pattern of NON_ACCOUNTING_PATTERNS) {
    if (pattern.test(text)) {
      return { type: '', ignore: true }
    }
  }

  if (/\bcredit\s*note\b|\bsales\s*return\b|^cr\s*note\b/.test(text)) {
    return { type: 'credit_note', ignore: false }
  }
  if (/\bdebit\s*note\b|\bpurchase\s*return\b|^dr\s*note\b/.test(text)) {
    return { type: 'debit_note', ignore: false }
  }
  if (/\bcontra\b/.test(text)) {
    return { type: 'contra', ignore: false }
  }
  if (/\bjournal\b/.test(text)) {
    return { type: 'journal', ignore: false }
  }
  if (/\breceipt\b|^rcpt\b/.test(text)) {
    return { type: 'receipt', ignore: false }
  }
  if (/\bpayment\b|^pymt\b/.test(text)) {
    return { type: 'payment', ignore: false }
  }
  if (/\bsales\b|\bsale\b|\btax\s*invoice\b|\bretail\s*invoice\b|\bpos\s*invoice\b/.test(text)) {
    return { type: 'sales', ignore: false }
  }
  if (/\bpurchase\b|\bpurchases\b/.test(text)) {
    return { type: 'purchase', ignore: false }
  }

  return { type: '', ignore: false }
}

export async function digest(text) {
  const bytes = new TextEncoder().encode(text)
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

const asArray = (value) => (Array.isArray(value) ? value : value ? [value] : [])

function walk(node, key, out = []) {
  if (!node || typeof node !== 'object') return out
  for (const [k, v] of Object.entries(node)) {
    if (k.toUpperCase() === key) out.push(...asArray(v))
    if (v && typeof v === 'object') walk(v, key, out)
  }
  return out
}

const EXACT_CASH_NAMES = new Set(['cash', 'cash-in-hand', 'cash in hand', 'petty cash'])

function isCashOrBankName(name, cashLedgerNames = new Set()) {
  const lower = normalized(name)
  if (!lower) return false
  if (EXACT_CASH_NAMES.has(lower)) return true
  if (cashLedgerNames && cashLedgerNames.has(lower)) return true
  return false
}

function extractLedgerEntries(voucher) {
  // Prefer ALLLEDGERENTRIES.LIST if present so we do not double-count when Tally exports both
  const allEntries = asArray(voucher['ALLLEDGERENTRIES.LIST'])
  const plainEntries = asArray(voucher['LEDGERENTRIES.LIST'])
  const rawEntries = allEntries.length > 0 ? allEntries : plainEntries

  const out = []
  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') continue
    const ledgerName = val(entry.LEDGERNAME ?? entry['@_NAME'])
    const signed = signedAmount(entry.AMOUNT, entry.ISDEEMEDPOSITIVE)
    if (!ledgerName && signed === 0) continue
    const isDebit = signed < 0
    out.push({
      ledger_name: ledgerName,
      amount: Math.abs(signed),
      signed_amount: signed,
      is_debit: isDebit,
      entry_type: isDebit ? 'debit' : 'credit',
      is_party_ledger: /^yes$/i.test(val(entry.ISPARTYLEDGER)),
    })
  }
  return out
}

function extractInventoryItems(voucher) {
  const topLevel = [
    ...asArray(voucher['ALLINVENTORYENTRIES.LIST']),
    ...asArray(voucher['INVENTORYENTRIES.LIST']),
    ...asArray(voucher['INVENTORYENTRIESIN.LIST']),
    ...asArray(voucher['INVENTORYENTRIESOUT.LIST']),
  ]
  const nested = [
    ...asArray(voucher['ALLLEDGERENTRIES.LIST']),
    ...asArray(voucher['LEDGERENTRIES.LIST']),
  ].flatMap((entry) => [
    ...asArray(entry?.['INVENTORYALLOCATIONS.LIST']),
    ...asArray(entry?.['ALLINVENTORYENTRIES.LIST']),
  ])

  const sourceList = topLevel.length > 0 ? topLevel : nested
  return sourceList
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const name = val(item.STOCKITEMNAME)
      if (!name) return null
      const rawQty = val(item.BILLEDQTY || item.ACTUALQTY)
      const qty = Math.abs(num(rawQty))
      const rate = Math.abs(num(item.RATE))
      const amount = Math.abs(signedAmount(item.AMOUNT, item.ISDEEMEDPOSITIVE)) || (qty * rate)
      return {
        name,
        sku: val(item.STOCKITEMNAME),
        qty,
        rate,
        amount,
      }
    })
    .filter((item) => item && item.name)
}

/**
 * Parse Tally XML into normalized master and voucher staging rows.
 */
export async function parseTallyXml(
  xml,
  company = '',
  { XMLParser, XMLValidator },
  { groupParents = {}, cashLedgerNames = new Set() } = {},
) {
  const valid = XMLValidator.validate(xml)
  if (valid !== true) throw new Error('Invalid Tally XML: ' + (valid.err?.msg || 'syntax error'))

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
  })
  const doc = parser.parse(xml)
  const rows = []
  const ignored = { nonAccounting: 0, cancelled: 0, optional: 0 }

  // Collect any GROUP definitions present in the same XML payload
  const mergedGroupParents = { ...groupParents }
  for (const grp of walk(doc, 'GROUP')) {
    const gName = val(grp.NAME ?? grp['@_NAME'] ?? grp['NAME.LIST']?.NAME)
    const gParent = val(grp.PARENT)
    if (gName && gParent) mergedGroupParents[gName] = gParent
  }

  const knownCashLedgers = new Set(
    Array.from(cashLedgerNames || []).map((n) => normalized(n))
  )

  for (const ledger of walk(doc, 'LEDGER')) {
    const rawName = ledger['NAME.LIST']?.NAME ?? ledger.NAME ?? ledger['@_NAME']
    const name = val(Array.isArray(rawName) ? rawName[0] : rawName)
    if (!name) continue

    const group = val(ledger.PARENT || 'General')
    const primaryGroup = resolveRootGroup(group, mergedGroupParents) || group
    const category = categoryForGroup(primaryGroup)
    const sign = normalBalanceSign(category)

    const rawOpening = ledger.OPENINGBALANCE
    const rawClosing = ledger.CLOSINGBALANCE
    const opening = rawOpening !== undefined && val(rawOpening) !== ''
      ? signedAmount(rawOpening) * sign
      : 0
    const closing = rawClosing !== undefined && val(rawClosing) !== ''
      ? signedAmount(rawClosing) * sign
      : opening

    const normPrimary = normalized(primaryGroup)
    if (['cash-in-hand', 'bank accounts', 'bank od a/c'].includes(normPrimary)) {
      knownCashLedgers.add(normalized(name))
    }

    const pType = partyType(primaryGroup) || partyType(group)
    if (pType) {
      rows.push({
        rowType: 'party',
        reference: name,
        sourceKey: `party:${company}:${name.toLowerCase()}`,
        payload: {
          name,
          type: pType,
          group,
          primary_group: primaryGroup,
          phone: val(ledger.LEDGERPHONE || ledger.LEDGERMOBILE || ledger.PHONE),
          email: val(ledger.EMAIL),
          address: asArray(ledger['ADDRESS.LIST']?.ADDRESS).map(val).filter(Boolean).join(', '),
          opening_balance: opening,
          closing_balance: closing,
          current_balance: closing,
        },
      })
    } else {
      rows.push({
        rowType: 'ledger',
        reference: name,
        sourceKey: `ledger:${company}:${name.toLowerCase()}`,
        payload: {
          name,
          group,
          primary_group: primaryGroup,
          category,
          opening_balance: opening,
          closing_balance: closing,
          current_balance: closing,
        },
      })
    }
  }

  for (const item of walk(doc, 'STOCKITEM')) {
    const rawName = item['NAME.LIST']?.NAME ?? item.NAME ?? item['@_NAME']
    const name = val(Array.isArray(rawName) ? rawName[0] : rawName)
    if (!name) continue

    const parseSignedQty = (rawVal) => {
      const cleaned = val(rawVal).replace(/,/g, '')
      const m = cleaned.match(/[+-]?\d+(?:\.\d+)?/)
      return m ? Number(m[0]) : 0
    }

    const openingQty = parseSignedQty(item.OPENINGBALANCE)
    const hasClosingQty = item.CLOSINGBALANCE !== undefined && val(item.CLOSINGBALANCE) !== ''
    const closingQty = hasClosingQty ? parseSignedQty(item.CLOSINGBALANCE) : openingQty
    const openingValue = signedAmount(item.OPENINGVALUE)
    const hasClosingValue = item.CLOSINGVALUE !== undefined && val(item.CLOSINGVALUE) !== ''
    const closingValue = hasClosingValue ? signedAmount(item.CLOSINGVALUE) : openingValue
    const rate = Math.abs(num(item.CLOSINGRATE || item.OPENINGRATE || item.STANDARDCOST || item.STANDARDRATE)) ||
      (closingQty !== 0 && closingValue ? Math.abs(closingValue / closingQty) : 0)

    rows.push({
      rowType: 'stock_item',
      reference: name,
      sourceKey: `stock:${company}:${name.toLowerCase()}`,
      payload: {
        name,
        sku: val(item.PARTNO || item.ALIAS || name),
        category: val(item.PARENT || 'General'),
        unit: val(item.BASEUNITS || 'pcs') || 'pcs',
        opening_qty: openingQty,
        current_qty: closingQty,
        purchase_rate: rate,
        sales_rate: Math.abs(num(item.STANDARDRATE)) || rate,
        current_value: closingValue || (closingQty * rate),
      },
    })
  }

  // Stock Summary report (DSPACCNAME + DSPSTKINFO pairs)
  const envelope = doc?.ENVELOPE || doc
  const dspNames = asArray(envelope?.DSPACCNAME)
  const dspInfos = asArray(envelope?.DSPSTKINFO)
  const pairCount = Math.min(dspNames.length, dspInfos.length)
  for (let i = 0; i < pairCount; i++) {
    const name = val(dspNames[i]?.DSPDISPNAME)
    if (!name) continue
    const stkCl = dspInfos[i]?.DSPSTKCL || {}
    const rawQty = val(stkCl.DSPCLQTY)
    const m = rawQty.replace(/,/g, '').match(/[+-]?\d+(?:\.\d+)?/)
    const qty = m ? Number(m[0]) : 0
    const rate = Math.abs(num(stkCl.DSPCLRATE))
    const rawAmt = signedAmount(stkCl.DSPCLAMTA)
    const value = rawAmt !== 0 ? Math.abs(rawAmt) : qty * rate

    rows.push({
      rowType: 'stock_item',
      reference: name,
      sourceKey: `stock:${company}:${name.toLowerCase()}`,
      payload: {
        name,
        sku: name,
        current_qty: qty,
        purchase_rate: rate,
        current_value: value,
        from_stock_summary: true,
      },
    })
  }

  for (const voucher of walk(doc, 'VOUCHER')) {
    if (/^yes$/i.test(val(voucher.ISCANCELLED))) {
      ignored.cancelled++
      continue
    }
    if (/^yes$/i.test(val(voucher.ISOPTIONAL))) {
      ignored.optional++
      continue
    }

    const rawVoucherType = val(voucher.VOUCHERTYPENAME || voucher['@_VCHTYPE'])
    const classified = classifyVoucherType(rawVoucherType)
    if (classified.ignore) {
      ignored.nonAccounting++
      continue
    }

    const voucherType = classified.type
    const date = normalDate(voucher.DATE || voucher.EFFECTIVEDATE)
    const guid = val(voucher.GUID || voucher.REMOTEID || voucher.MASTERID)
    const rawNo = val(voucher.VOUCHERNUMBER)
    const voucherNo = rawNo || (guid ? `TALLY-${guid.slice(-8)}` : '')

    const ledgerEntries = extractLedgerEntries(voucher)
    const items = extractInventoryItems(voucher)

    const totalDebit = ledgerEntries
      .filter((e) => e.is_debit)
      .reduce((sum, e) => sum + e.amount, 0)
    const totalCredit = ledgerEntries
      .filter((e) => !e.is_debit)
      .reduce((sum, e) => sum + e.amount, 0)
    const itemsSum = items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0)

    let partyName = val(voucher.PARTYLEDGERNAME || voucher.PARTYNAME)
    if (!partyName && ledgerEntries.length > 0) {
      const partyEntry = ledgerEntries.find((e) => e.is_party_ledger) || ledgerEntries[0]
      partyName = partyEntry?.ledger_name || 'Cash'
    }
    if (!partyName) partyName = 'Cash'

    const partyIsCashOrBank = isCashOrBankName(partyName, knownCashLedgers)
    const partyDebited = ledgerEntries
      .filter((e) => normalized(e.ledger_name) === normalized(partyName) && e.is_debit)
      .reduce((sum, e) => sum + e.amount, 0)
    const partyCredited = ledgerEntries
      .filter((e) => normalized(e.ledger_name) === normalized(partyName) && !e.is_debit)
      .reduce((sum, e) => sum + e.amount, 0)

    let amount = Math.abs(signedAmount(voucher.AMOUNT))
    if (!amount) {
      if (voucherType === 'sales' || voucherType === 'credit_note') {
        amount = Math.max(totalDebit, totalCredit, itemsSum)
      } else if (voucherType === 'purchase' || voucherType === 'debit_note') {
        amount = Math.max(totalCredit, totalDebit, itemsSum)
      } else {
        amount = totalDebit || totalCredit || itemsSum
      }
    }

    let paidAmount = amount
    let dueAmount = 0
    let paymentMode = 'Tally import'

    const cashEntries = ledgerEntries.filter((e) => isCashOrBankName(e.ledger_name, knownCashLedgers))

    if (voucherType === 'sales') {
      if (partyIsCashOrBank) {
        paidAmount = amount
        dueAmount = 0
        paymentMode = partyName
      } else {
        dueAmount = partyDebited > 0 ? Math.min(amount, partyDebited) : amount
        paidAmount = Math.max(0, amount - dueAmount)
        paymentMode = cashEntries[0]?.ledger_name || 'Tally import'
      }
    } else if (voucherType === 'purchase') {
      if (partyIsCashOrBank) {
        paidAmount = amount
        dueAmount = 0
        paymentMode = partyName
      } else {
        dueAmount = partyCredited > 0 ? Math.min(amount, partyCredited) : amount
        paidAmount = Math.max(0, amount - dueAmount)
        paymentMode = cashEntries[0]?.ledger_name || 'Tally import'
      }
    } else if (voucherType === 'payment' || voucherType === 'receipt') {
      paidAmount = amount
      dueAmount = 0
      paymentMode = cashEntries[0]?.ledger_name || 'Tally import'
      if (partyIsCashOrBank) {
        const nonCash = ledgerEntries.find((e) => !isCashOrBankName(e.ledger_name, knownCashLedgers))
        if (nonCash?.ledger_name) partyName = nonCash.ledger_name
      }
    } else {
      paidAmount = amount
      dueAmount = 0
      paymentMode = cashEntries[0]?.ledger_name || 'Tally import'
    }

    const cleanLedgerEntries = ledgerEntries.map(({ ledger_name, amount: a, is_debit }) => ({
      ledger_name,
      amount: a,
      is_debit,
    }))

    const sourceHash = await digest(JSON.stringify({
      company,
      guid,
      voucherNo,
      voucherType,
      date,
      partyName,
      amount,
      paidAmount,
      dueAmount,
      items,
      ledgerEntries: cleanLedgerEntries,
    }))

    rows.push({
      rowType: 'voucher',
      reference: voucherNo,
      sourceKey: guid
        ? `voucher:${company}:guid:${guid}`
        : `voucher:${company}:${voucherType}:${date}:${voucherNo.toLowerCase()}`,
      payload: {
        voucher_no: voucherNo,
        voucher_type: voucherType,
        date,
        party_name: partyName,
        amount,
        paid_amount: paidAmount,
        due_amount: dueAmount,
        payment_mode: paymentMode,
        status: dueAmount > 0 ? 'Due' : 'Paid',
        narration: val(voucher.NARRATION),
        reference_no: val(voucher.REFERENCE),
        source_system: 'tally',
        source_company: company || 'default',
        source_voucher_guid: guid || null,
        source_hash: sourceHash,
        items,
        ledger_entries: cleanLedgerEntries,
      },
    })
  }

  return { rows, ignored }
}
