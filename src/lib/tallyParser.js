import * as XLSX from 'xlsx'
import { accDb, generateNextDebtorUid, findCashBankLedger } from './accountingDb'
import { tallyLedgerCategory, tallyPartyType } from './tallyLedgerCategory.js'

/**
 * TallyPrime XML & Excel Parser
 * Supports:
 *  - TallyPrime / Tally.ERP9 XML Exports (<ENVELOPE>, <VOUCHER>, <LEDGER>, <STOCKITEM>)
 *  - Tally Day Book & Masters Excel / CSV Sheets
 *  - Preserves signed debit/credit amounts and classifies voucher types deterministically
 */

const NON_ACCOUNTING_PATTERNS = [
  /\bsales\s+order\b/i,
  /\bpurchase\s+order\b/i,
  /\bjob\s+work\b/i,
  /\bdelivery\s+note\b/i,
  /\breceipt\s+note\b/i,
  /\brejection\s+in\b/i,
  /\brejection\s+out\b/i,
  /\bstock\s+journal\b/i,
  /\bphysical\s+stock\b/i,
  /\bmaterial\s+in\b/i,
  /\bmaterial\s+out\b/i,
  /\bmemorandum\b/i,
  /\breversing\s+journal\b/i,
  /\bpayroll\b/i,
  /\battendance\b/i,
]

export function classifyVoucherType(raw) {
  const text = String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (!text) return { type: '', skip: false }

  for (const pattern of NON_ACCOUNTING_PATTERNS) {
    if (pattern.test(text)) return { type: '', skip: true }
  }
  if (/\bcredit\s*note\b|\bsales\s*return\b|^cr\s*note\b/.test(text)) return { type: 'credit_note', skip: false }
  if (/\bdebit\s*note\b|\bpurchase\s*return\b|^dr\s*note\b/.test(text)) return { type: 'debit_note', skip: false }
  if (/\bcontra\b/.test(text)) return { type: 'contra', skip: false }
  if (/\bjournal\b/.test(text)) return { type: 'journal', skip: false }
  if (/\breceipt\b|^rcpt\b/.test(text)) return { type: 'receipt', skip: false }
  if (/\bpayment\b|^pymt\b/.test(text)) return { type: 'payment', skip: false }
  if (/\bsales\b|\bsale\b|\btax\s*invoice\b|\bretail\s*invoice\b|\bpos\s*invoice\b/.test(text)) return { type: 'sales', skip: false }
  if (/\bpurchase\b|\bpurchases\b/.test(text)) return { type: 'purchase', skip: false }
  return { type: '', skip: true }
}

export function signedAmount(value, isDeemedPositive = null) {
  const raw = String(value ?? '').replace(/[\u0000-\u001f]/g, '').replace(/,/g, '').trim()
  if (!raw) return 0
  const match = raw.match(/([+-])?\s*\d+(?:\.\d+)?/)
  if (!match) return 0
  const magnitude = Math.abs(Number(match[0].replace(/\s+/g, '')))
  if (!Number.isFinite(magnitude) || magnitude === 0) return 0

  const hasMinus = match[1] === '-' || /^\s*-/.test(raw)
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

function normalBalanceSign(category) {
  return category === 'liability' || category === 'income' ? 1 : -1
}

function parseNumeric(raw) {
  const cleaned = String(raw ?? '').replace(/,/g, '').trim()
  const match = cleaned.match(/[+-]?\d+(?:\.\d+)?/)
  return match ? Number(match[0]) : 0
}

function isCashOrBankName(name, cashLedgerNames = new Set()) {
  const lower = String(name || '').trim().toLowerCase()
  if (!lower) return false
  if (cashLedgerNames.has(lower)) return true
  return /^(cash|petty\s*cash|cash[\s-]*in[\s-]*hand|bank|hdfc|sbi|icici|axis|kotak|upi|neft|rtgs|imps|cheque|card)\b/i.test(lower)
}

/**
 * Parse TallyPrime XML String into normalized objects
 */
export function parseTallyXml(xmlText) {
  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml')

  const vouchers = []
  const ledgers = []
  const stockItems = []
  const problems = []
  const cashLedgerNames = new Set()

  // 1. Extract Ledgers (<LEDGER>)
  const ledgerNodes = xmlDoc.getElementsByTagName('LEDGER')
  for (let i = 0; i < ledgerNodes.length; i++) {
    const node = ledgerNodes[i]
    const name = node.getAttribute('NAME') || getTagValue(node, 'NAME')
    const parent = getTagValue(node, 'PARENT') || 'General'
    const category = tallyLedgerCategory(parent)
    const sign = normalBalanceSign(category)
    const rawOpening = getTagValue(node, 'OPENINGBALANCE')
    const rawClosing = getTagValue(node, 'CLOSINGBALANCE')
    const openingBalance = rawOpening !== '' ? signedAmount(rawOpening) * sign : 0
    const closingBalance = rawClosing !== '' ? signedAmount(rawClosing) * sign : openingBalance
    const phone = getTagValue(node, 'LEDGERPHONE') || getTagValue(node, 'LEDGERMOBILE') || ''

    if (name) {
      if (['cash-in-hand', 'bank accounts', 'bank od a/c'].includes(parent.trim().toLowerCase())) {
        cashLedgerNames.add(name.trim().toLowerCase())
      }
      ledgers.push({
        name: name.trim(),
        group: parent.trim(),
        category,
        opening_balance: openingBalance,
        current_balance: closingBalance,
        phone: phone.trim(),
      })
    }
  }

  // 2. Extract Stock Items (<STOCKITEM>)
  const stockNodes = xmlDoc.getElementsByTagName('STOCKITEM')
  for (let i = 0; i < stockNodes.length; i++) {
    const node = stockNodes[i]
    const name = node.getAttribute('NAME') || getTagValue(node, 'NAME')
    const parent = getTagValue(node, 'PARENT') || 'General'
    const baseUnits = getTagValue(node, 'BASEUNITS') || 'pcs'
    const rawOpeningQty = getTagValue(node, 'OPENINGBALANCE')
    const rawClosingQty = getTagValue(node, 'CLOSINGBALANCE')
    const openingQty = parseNumeric(rawOpeningQty)
    const closingQty = rawClosingQty !== '' ? parseNumeric(rawClosingQty) : openingQty
    const openingRate = Math.abs(parseNumeric(getTagValue(node, 'OPENINGRATE') || getTagValue(node, 'CLOSINGRATE') || '0'))

    if (name) {
      stockItems.push({
        name: name.trim(),
        category: parent.trim(),
        unit: baseUnits.trim() || 'pcs',
        current_qty: closingQty,
        purchase_rate: openingRate,
        sales_rate: Math.round(openingRate * 1.25),
      })
    }
  }

  // 3. Extract Vouchers (<VOUCHER>)
  const voucherNodes = xmlDoc.getElementsByTagName('VOUCHER')
  for (let i = 0; i < voucherNodes.length; i++) {
    const node = voucherNodes[i]
    if (/^yes$/i.test(getTagValue(node, 'ISCANCELLED')) || /^yes$/i.test(getTagValue(node, 'ISOPTIONAL'))) {
      continue
    }

    const vchTypeRaw = node.getAttribute('VCHTYPE') || getTagValue(node, 'VOUCHERTYPENAME') || 'Sales'
    const classified = classifyVoucherType(vchTypeRaw)
    if (classified.skip || !classified.type) continue
    const vchType = classified.type

    const dateRaw = getTagValue(node, 'DATE') || ''
    const vchNo = getTagValue(node, 'VOUCHERNUMBER') || `TALLY-${100 + i}`
    const partyNameRaw = getTagValue(node, 'PARTYLEDGERNAME') || getTagValue(node, 'PARTYNAME') || ''
    const narration = getTagValue(node, 'NARRATION') || ''

    const ledgerEntries = []
    const entryLists = [
      ...Array.from(node.getElementsByTagName('ALLLEDGERENTRIES.LIST')),
      ...Array.from(node.getElementsByTagName('LEDGERENTRIES.LIST')),
    ]
    for (const el of entryLists) {
      const lName = getTagValue(el, 'LEDGERNAME')
      const amtRaw = getTagValue(el, 'AMOUNT')
      const isDeemed = getTagValue(el, 'ISDEEMEDPOSITIVE')
      const signed = signedAmount(amtRaw, isDeemed)
      if (!lName && signed === 0) continue
      ledgerEntries.push({
        ledger_name: lName,
        amount: Math.abs(signed),
        signed_amount: signed,
        entry_type: signed < 0 ? 'debit' : 'credit',
        is_party_ledger: /^yes$/i.test(getTagValue(el, 'ISPARTYLEDGER')),
      })
    }

    const items = []
    const invNodes = [
      ...Array.from(node.getElementsByTagName('ALLINVENTORYENTRIES.LIST')),
      ...Array.from(node.getElementsByTagName('INVENTORYENTRIES.LIST')),
    ]
    for (const inv of invNodes) {
      const itemName = getTagValue(inv, 'STOCKITEMNAME')
      const qtyRaw = getTagValue(inv, 'BILLEDQTY') || getTagValue(inv, 'ACTUALQTY') || '1'
      const rateRaw = getTagValue(inv, 'RATE') || '0'
      const amtRaw = getTagValue(inv, 'AMOUNT') || '0'
      const qty = Math.abs(parseNumeric(qtyRaw)) || 1
      const rate = Math.abs(parseNumeric(rateRaw))
      const itemAmt = Math.abs(signedAmount(amtRaw)) || (qty * rate)
      if (itemName) {
        items.push({
          name: itemName.trim(),
          qty,
          rate,
          amount: itemAmt,
        })
      }
    }

    const totalDebit = ledgerEntries.filter((e) => e.entry_type === 'debit').reduce((s, e) => s + e.amount, 0)
    const totalCredit = ledgerEntries.filter((e) => e.entry_type === 'credit').reduce((s, e) => s + e.amount, 0)
    const itemsSum = items.reduce((s, it) => s + it.amount, 0)

    let partyName = partyNameRaw.trim()
    if (!partyName && ledgerEntries.length > 0) {
      const partyEntry = ledgerEntries.find((e) => e.is_party_ledger) || ledgerEntries[0]
      partyName = partyEntry?.ledger_name || 'Cash'
    }
    if (!partyName) partyName = 'Cash'

    let totalAmount = 0
    if (vchType === 'sales' || vchType === 'credit_note') {
      totalAmount = totalDebit || totalCredit || itemsSum
    } else if (vchType === 'purchase' || vchType === 'debit_note') {
      totalAmount = totalCredit || totalDebit || itemsSum
    } else {
      totalAmount = totalDebit || totalCredit || itemsSum
    }

    let paidAmount = totalAmount
    let dueAmount = 0
    let paymentMode = 'Cash'
    const cashEntries = ledgerEntries.filter((e) => isCashOrBankName(e.ledger_name, cashLedgerNames))
    const partyIsCash = isCashOrBankName(partyName, cashLedgerNames)

    if (vchType === 'sales') {
      if (partyIsCash) {
        paidAmount = totalAmount
        dueAmount = 0
        paymentMode = partyName
      } else {
        const cashDebited = cashEntries.filter((e) => e.entry_type === 'debit').reduce((s, e) => s + e.amount, 0)
        const partyDebited = ledgerEntries
          .filter((e) => e.ledger_name.toLowerCase() === partyName.toLowerCase() && e.entry_type === 'debit')
          .reduce((s, e) => s + e.amount, 0)
        const partyCredited = ledgerEntries
          .filter((e) => e.ledger_name.toLowerCase() === partyName.toLowerCase() && e.entry_type === 'credit')
          .reduce((s, e) => s + e.amount, 0)

        if (cashDebited > 0 && partyDebited > 0 && Math.abs((cashDebited + partyDebited) - totalAmount) < 0.01) {
          paidAmount = Math.min(totalAmount, cashDebited)
          dueAmount = Math.max(0, totalAmount - paidAmount)
          paymentMode = cashEntries.find((e) => e.entry_type === 'debit')?.ledger_name || 'Cash'
        } else if (cashDebited > 0 && partyCredited > 0) {
          paidAmount = Math.min(totalAmount, cashDebited)
          dueAmount = Math.max(0, totalAmount - paidAmount)
          paymentMode = cashEntries.find((e) => e.entry_type === 'debit')?.ledger_name || 'Cash'
        } else if (cashDebited >= totalAmount && partyDebited === 0) {
          paidAmount = totalAmount
          dueAmount = 0
          paymentMode = cashEntries.find((e) => e.entry_type === 'debit')?.ledger_name || 'Cash'
        } else {
          paidAmount = 0
          dueAmount = totalAmount
          paymentMode = 'Credit'
        }
      }
    } else if (vchType === 'purchase') {
      if (partyIsCash) {
        paidAmount = totalAmount
        dueAmount = 0
        paymentMode = partyName
      } else {
        const cashCredited = cashEntries.filter((e) => e.entry_type === 'credit').reduce((s, e) => s + e.amount, 0)
        const partyCredited = ledgerEntries
          .filter((e) => e.ledger_name.toLowerCase() === partyName.toLowerCase() && e.entry_type === 'credit')
          .reduce((s, e) => s + e.amount, 0)
        if (cashCredited > 0 && partyCredited > 0 && Math.abs((cashCredited + partyCredited) - totalAmount) < 0.01) {
          paidAmount = Math.min(totalAmount, cashCredited)
          dueAmount = Math.max(0, totalAmount - paidAmount)
          paymentMode = cashEntries.find((e) => e.entry_type === 'credit')?.ledger_name || 'Cash'
        } else if (cashCredited >= totalAmount && partyCredited === 0) {
          paidAmount = totalAmount
          dueAmount = 0
          paymentMode = cashEntries.find((e) => e.entry_type === 'credit')?.ledger_name || 'Cash'
        } else {
          paidAmount = 0
          dueAmount = totalAmount
          paymentMode = 'Credit'
        }
      }
    } else if (vchType === 'payment' || vchType === 'receipt') {
      paidAmount = totalAmount
      dueAmount = 0
      paymentMode = cashEntries[0]?.ledger_name || 'Cash'
      if (partyIsCash) {
        const nonCash = ledgerEntries.find((e) => !isCashOrBankName(e.ledger_name, cashLedgerNames))
        if (nonCash?.ledger_name) partyName = nonCash.ledger_name
      }
    }

    const formattedDate = formatTallyDate(dateRaw)

    if (totalAmount > 0) {
      vouchers.push({
        voucher_no: vchNo.trim(),
        voucher_type: vchType,
        date: formattedDate,
        party_name: partyName,
        amount: totalAmount,
        paid_amount: paidAmount,
        due_amount: dueAmount,
        payment_mode: paymentMode,
        status: dueAmount > 0 ? 'Due' : 'Paid',
        narration: narration.trim(),
        items,
        ledger_entries: ledgerEntries.map(({ ledger_name, amount: a, entry_type }) => ({
          ledger_name,
          amount: a,
          entry_type,
        })),
      })
    }
  }

  return {
    vouchers,
    ledgers,
    stockItems,
    problems,
  }
}

export async function parseTallyExcel(file) {
  const data = await file.arrayBuffer()
  const workbook = XLSX.read(data, { type: 'array' })
  const firstSheetName = workbook.SheetNames[0]
  const worksheet = workbook.Sheets[firstSheetName]
  const jsonRows = XLSX.utils.sheet_to_json(worksheet, { defval: '' })

  const vouchers = []
  const ledgers = []
  const stockItems = []

  jsonRows.forEach((row, idx) => {
    const keys = Object.keys(row)
    const getCol = (candidates) => {
      const foundKey = keys.find((k) =>
        candidates.some((c) => k.toLowerCase().replace(/[^a-z0-9]/g, '').includes(c))
      )
      return foundKey ? row[foundKey] : ''
    }

    const vchNo = String(getCol(['voucherno', 'vchno', 'invoiceno', 'billno']) || '')
    const vchTypeRaw = String(getCol(['vouchertype', 'vchtype', 'type']) || '')
    const party = String(getCol(['party', 'particulars', 'customer', 'ledgername', 'name']) || '')
    const amountRaw = getCol(['amount', 'total', 'debit', 'credit', 'netamount', 'value'])
    const dateVal = String(getCol(['date', 'vchdate', 'invoicedate']) || '')
    const groupVal = String(getCol(['group', 'parent', 'under']) || '')
    const qtyVal = getCol(['qty', 'quantity', 'billedqty', 'stock'])

    const amount = Math.abs(signedAmount(amountRaw))

    if (vchNo || vchTypeRaw) {
      const classified = classifyVoucherType(vchTypeRaw || 'Sales')
      if (!classified.skip && classified.type && amount > 0) {
        const isCredit = party.toLowerCase() !== 'cash' && (classified.type === 'sales' || classified.type === 'purchase')
        vouchers.push({
          voucher_no: vchNo || `XL-${100 + idx}`,
          voucher_type: classified.type,
          date: formatTallyDate(dateVal),
          party_name: party || 'Cash',
          amount,
          paid_amount: isCredit ? 0 : amount,
          due_amount: isCredit ? amount : 0,
          payment_mode: isCredit ? 'Credit' : 'Cash',
          status: isCredit ? 'Due' : 'Paid',
          narration: String(getCol(['narration', 'remarks', 'note']) || 'Imported from Excel'),
          items: [],
        })
      }
    } else if (qtyVal !== '' && party) {
      const q = parseNumeric(qtyVal)
      stockItems.push({
        name: party,
        category: groupVal || 'General',
        unit: 'pcs',
        current_qty: q,
        purchase_rate: amount || 500,
        sales_rate: Math.round((amount || 500) * 1.25),
      })
    } else if (party && groupVal) {
      const category = tallyLedgerCategory(groupVal)
      const signed = signedAmount(amountRaw) * normalBalanceSign(category)
      ledgers.push({
        name: party,
        group: groupVal,
        category,
        opening_balance: signed,
        current_balance: signed,
        phone: String(getCol(['phone', 'mobile', 'contact']) || ''),
      })
    }
  })

  return {
    vouchers,
    ledgers,
    stockItems,
    problems: [],
  }
}

/**
 * Commit parsed Tally dataset into Dexie DB without duplicating effects on repeated imports.
 */
export async function importTallyDataToDb(parsedData) {
  let newCount = 0
  let skippedCount = 0
  let updatedCount = 0

  return accDb.transaction('rw', accDb.parties, accDb.materials, accDb.ledgers, accDb.vouchers, async () => {
    const importedPartyNames = new Set()

    // 1. Upsert Ledgers & Parties (Debtors / Creditors)
    if (Array.isArray(parsedData.ledgers)) {
      for (const l of parsedData.ledgers) {
        const pType = tallyPartyType(l.group)
        if (pType) {
          importedPartyNames.add(l.name.trim().toLowerCase())
          const existingParty = await accDb.parties.where('name').equalsIgnoreCase(l.name).first()
          if (existingParty) {
            await accDb.parties.update(existingParty.id, {
              current_balance: l.current_balance,
              opening_balance: l.opening_balance ?? existingParty.opening_balance,
              phone: l.phone || existingParty.phone,
            })
            updatedCount++
          } else {
            const uid = pType === 'debtor' ? await generateNextDebtorUid(accDb) : undefined
            await accDb.parties.add({
              name: l.name,
              type: pType,
              uid,
              phone: l.phone || '',
              opening_balance: l.opening_balance,
              current_balance: l.current_balance,
              age_bucket: '0–30d',
              due_days: 15,
              last_invoice: 'Tally Sync',
            })
            newCount++
          }
        }

        const existingLedger = await accDb.ledgers.where('name').equalsIgnoreCase(l.name).first()
        const category = l.category || tallyLedgerCategory(l.group)

        if (existingLedger) {
          await accDb.ledgers.update(existingLedger.id, {
            group: l.group || existingLedger.group,
            category,
            opening_balance: l.opening_balance ?? existingLedger.opening_balance,
            current_balance: l.current_balance,
          })
          if (!pType) updatedCount++
        } else {
          await accDb.ledgers.add({
            name: l.name,
            group: l.group,
            opening_balance: l.opening_balance,
            current_balance: l.current_balance,
            is_system: false,
            category,
          })
          if (!pType) newCount++
        }
      }
    }

    // 2. Upsert Stock Items
    const importedStockNames = new Set()
    if (Array.isArray(parsedData.stockItems)) {
      for (const st of parsedData.stockItems) {
        importedStockNames.add(st.name.trim().toLowerCase())
        const existingItem = await accDb.materials.where('name').equalsIgnoreCase(st.name).first()
        if (existingItem) {
          await accDb.materials.update(existingItem.id, {
            current_qty: st.current_qty,
            purchase_rate: st.purchase_rate || existingItem.purchase_rate,
            sales_rate: st.sales_rate || existingItem.sales_rate,
          })
          updatedCount++
        } else {
          const count = await accDb.materials.count()
          await accDb.materials.add({
            sku: `SKU-${100 + count + 1}`,
            name: st.name,
            category: st.category || 'General',
            unit: st.unit || 'pcs',
            opening_qty: st.current_qty,
            current_qty: st.current_qty,
            purchase_rate: st.purchase_rate,
            sales_rate: st.sales_rate,
            reorder_threshold: 10,
          })
          newCount++
        }
      }
    }

    // 3. Upsert Vouchers (Idempotent by voucher_no + voucher_type + date)
    if (Array.isArray(parsedData.vouchers)) {
      for (const v of parsedData.vouchers) {
        const candidates = await accDb.vouchers.where('voucher_no').equalsIgnoreCase(v.voucher_no).toArray()
        const existingVch = candidates.find(
          (c) => (c.voucher_type || '') === (v.voucher_type || '') && (c.date || '') === (v.date || '')
        ) || candidates[0]

        if (existingVch) {
          skippedCount++
          continue
        }

        let partyUid = ''
        if (v.party_name && v.party_name.toLowerCase() !== 'cash') {
          let party = await accDb.parties.where('name').equalsIgnoreCase(v.party_name).first()
          if (!party) {
            const pType = v.voucher_type === 'purchase' || v.voucher_type === 'debit_note' ? 'creditor' : 'debtor'
            const uid = pType === 'debtor' ? await generateNextDebtorUid(accDb) : undefined
            const dueDelta = v.voucher_type === 'sales' || v.voucher_type === 'purchase'
              ? (Number(v.due_amount) || 0)
              : (v.voucher_type === 'receipt' || v.voucher_type === 'payment' || v.voucher_type === 'credit_note' || v.voucher_type === 'debit_note')
                ? -(Number(v.amount) || 0)
                : 0
            const id = await accDb.parties.add({
              name: v.party_name,
              type: pType,
              uid,
              phone: '',
              opening_balance: 0,
              current_balance: dueDelta,
              age_bucket: '0–30d',
              due_days: 7,
              last_invoice: v.date,
            })
            party = await accDb.parties.get(id)
          } else {
            // Only adjust party balance if this import did not already set the party's closing balance from masters
            if (!importedPartyNames.has(v.party_name.trim().toLowerCase())) {
              let delta = 0
              if (v.voucher_type === 'sales' || v.voucher_type === 'purchase') delta = Number(v.due_amount) || 0
              else if (['receipt', 'payment', 'credit_note', 'debit_note'].includes(v.voucher_type)) delta = -(Number(v.amount) || 0)
              await accDb.parties.update(party.id, {
                current_balance: (Number(party.current_balance) || 0) + delta,
                last_invoice: v.date,
              })
            }
          }
          partyUid = party?.uid || ''
        }

        // Update stock quantities for voucher items if stock masters weren't already setting closing balances in the same file
        if (Array.isArray(v.items) && v.items.length > 0) {
          for (const item of v.items) {
            if (!item.name || importedStockNames.has(item.name.trim().toLowerCase())) continue
            const mat = await accDb.materials.where('name').equalsIgnoreCase(item.name.trim()).first()
            if (mat) {
              const qty = Number(item.qty) || 0
              const delta = (v.voucher_type === 'sales' || v.voucher_type === 'debit_note') ? -qty
                : (v.voucher_type === 'purchase' || v.voucher_type === 'credit_note') ? qty : 0
              await accDb.materials.update(mat.id, {
                current_qty: (Number(mat.current_qty) || 0) + delta,
              })
            }
          }
        }

        // Update cash/bank ledger if not already set by master import
        const paidAmt = Number(v.paid_amount) || 0
        if (paidAmt > 0 && v.payment_mode && v.payment_mode !== 'Credit') {
          const cashLedger = await findCashBankLedger(accDb, v.payment_mode)
          if (cashLedger) {
            let cashDelta = 0
            if (v.voucher_type === 'sales' || v.voucher_type === 'receipt') cashDelta = paidAmt
            else if (v.voucher_type === 'purchase' || v.voucher_type === 'payment') cashDelta = -paidAmt
            if (cashDelta !== 0) {
              await accDb.ledgers.update(cashLedger.id, {
                current_balance: (Number(cashLedger.current_balance) || 0) + cashDelta,
              })
            }
          }
        }

        await accDb.vouchers.add({
          ...v,
          party_uid: partyUid,
          displayDate: v.date,
        })
        newCount++
      }
    }

    return { newCount, skippedCount, updatedCount }
  })
}

function getTagValue(parent, tagName) {
  const els = parent.getElementsByTagName(tagName)
  if (els && els.length > 0 && els[0].textContent) {
    return els[0].textContent.trim()
  }
  return ''
}

function formatTallyDate(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10)
  const clean = String(raw).trim()
  if (/^\d{8}$/.test(clean)) {
    const y = clean.slice(0, 4)
    const m = clean.slice(4, 6)
    const d = clean.slice(6, 8)
    return `${y}-${m}-${d}`
  }
  const dmy = clean.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  return clean.slice(0, 10)
}

export const SAMPLE_TALLY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDATA>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="Apex Mobile World">
            <NAME>Apex Mobile World</NAME>
            <PARENT>Sundry Debtors</PARENT>
            <OPENINGBALANCE>-64000</OPENINGBALANCE>
            <LEDGERPHONE>+91 98300 44556</LEDGERPHONE>
          </LEDGER>
          <LEDGER NAME="Metro Gadget Point">
            <NAME>Metro Gadget Point</NAME>
            <PARENT>Sundry Debtors</PARENT>
            <OPENINGBALANCE>-39500</OPENINGBALANCE>
            <LEDGERPHONE>+91 98311 77889</LEDGERPHONE>
          </LEDGER>
          <STOCKITEM NAME="Samsung 25W Super Fast Charger">
            <NAME>Samsung 25W Super Fast Charger</NAME>
            <PARENT>Chargers</PARENT>
            <BASEUNITS>pcs</BASEUNITS>
            <OPENINGBALANCE>55 pcs</OPENINGBALANCE>
            <OPENINGRATE>780</OPENINGRATE>
          </STOCKITEM>
          <VOUCHER VCHTYPE="Sales">
            <DATE>20261017</DATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>INV-0413</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Apex Mobile World</PARTYLEDGERNAME>
            <NARRATION>Credit sale via TallyPrime XML sync</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Apex Mobile World</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-38500.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>Samsung 25W Super Fast Charger</STOCKITEMNAME>
              <BILLEDQTY>35 pcs</BILLEDQTY>
              <RATE>1100.00</RATE>
              <AMOUNT>38500.00</AMOUNT>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
          <VOUCHER VCHTYPE="Sales">
            <DATE>20261017</DATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>INV-0414</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Metro Gadget Point</PARTYLEDGERNAME>
            <NARRATION>Fast accessories batch order</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Metro Gadget Point</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-24000.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`
