import * as XLSX from 'xlsx'
import {
  accDb,
  createDebtor,
  createCreditor,
  createStockItem,
  createVoucher,
  updateVoucher,
} from './accountingDb'
import { tallyLedgerCategory, tallyPartyType } from './tallyLedgerCategory'

/**
 * Tally Integration Engine
 * Full support for Tally Prime / Tally ERP 9 Exported XML & Excel/CSV Vouchers and Masters
 */

// Format Tally date 'YYYYMMDD' or 'DD-MM-YYYY' into 'YYYY-MM-DD'
export function formatTallyDate(rawDate) {
  if (!rawDate) return ''
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) return rawDate.toISOString().slice(0, 10)
  if (typeof rawDate === 'number' && Number.isFinite(rawDate)) {
    const parts = XLSX.SSF.parse_date_code(rawDate)
    if (parts && validDateParts(parts.y, parts.m, parts.d)) {
      return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`
    }
    return ''
  }
  const str = String(rawDate).trim()

  // YYYYMMDD (e.g. 20261014)
  if (/^\d{8}$/.test(str)) {
    const y = str.slice(0, 4)
    const m = str.slice(4, 6)
    const d = str.slice(6, 8)
    return validDateParts(y, m, d) ? `${y}-${m}-${d}` : ''
  }

  // DD-MM-YYYY or DD/MM/YYYY
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(str)) {
    const parts = str.split(/[-/]/)
    const d = parts[0].padStart(2, '0')
    const m = parts[1].padStart(2, '0')
    const y = parts[2]
    return validDateParts(y, m, d) ? `${y}-${m}-${d}` : ''
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const [y, m, d] = str.split('-')
    return validDateParts(y, m, d) ? str : ''
  }

  // Fallback date parsing
  const parsed = new Date(str)
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10)
  }

  return ''
}

function validDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() === Number(month) - 1 &&
    date.getUTCDate() === Number(day)
}

function elements(node, tagNames) {
  const found = []
  const seen = new Set()
  for (const tagName of tagNames) {
    for (const element of Array.from(node.getElementsByTagName(tagName))) {
      if (!seen.has(element)) {
        seen.add(element)
        found.push(element)
      }
    }
  }
  return found
}

function elementText(node, ...tagNames) {
  for (const tagName of tagNames) {
    const element = node.getElementsByTagName(tagName)[0]
    const value = element?.textContent?.trim()
    if (value) return value
  }
  return ''
}

function tallyNumber(rawValue) {
  if (rawValue == null || String(rawValue).trim() === '') return null
  const raw = String(rawValue).trim()
  const isParenthesizedNegative = /^\(.*\)$/.test(raw)
  const isCredit = /\bCr\.?\s*$/i.test(raw)
  const match = raw.replace(/[(),]/g, '').match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)
  if (!match) return null
  let value = Number(match[0])
  if (!Number.isFinite(value)) return null
  if (isParenthesizedNegative) value = -Math.abs(value)
  if (isCredit) value = -Math.abs(value)
  return value
}

function numericValue(rawValue) {
  return tallyNumber(rawValue) ?? 0
}

function voucherType(rawType) {
  const type = String(rawType || '').toLowerCase()
  if (type.includes('sale')) return 'sales'
  if (type.includes('purch')) return 'purchase'
  if (type.includes('receipt')) return 'receipt'
  if (type.includes('paym')) return 'payment'
  if (type.includes('contra')) return 'contra'
  if (type.includes('journal')) return 'journal'
  return ''
}

/**
 * Parse Tally XML Export string
 */
export function parseTallyXml(xmlText) {
  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml')

  const parserError = xmlDoc.getElementsByTagName('parsererror')[0]
  if (parserError) {
    throw new Error('Invalid XML document: ' + parserError.textContent)
  }

  const result = {
    ledgers: [],
    stockItems: [],
    vouchers: [],
    stats: {
      ledgersCount: 0,
      stockItemsCount: 0,
      vouchersCount: 0,
      salesCount: 0,
      purchaseCount: 0,
      receiptCount: 0,
      paymentCount: 0,
      contraCount: 0,
      journalCount: 0,
    },
  }
  result.companyName = elementText(xmlDoc, 'SVCURRENTCOMPANY')

  // 1. Parse Ledgers (<LEDGER>)
  const ledgerNodes = xmlDoc.getElementsByTagName('LEDGER')
  ledgerNodes.forEach((node) => {
    const name = node.getAttribute('NAME') || elementText(node, 'NAME')
    const parent = elementText(node, 'PARENT') || 'General'
    const openingBal = Math.abs(numericValue(elementText(node, 'OPENINGBALANCE')))
    const closingBalance = tallyNumber(elementText(node, 'CLOSINGBALANCE'))
    const phone = elementText(node, 'LEDGERPHONE', 'PHONE')
    const email = elementText(node, 'EMAIL')
    const address = elements(node, ['ADDRESS.LIST'])
      .flatMap((list) => Array.from(list.getElementsByTagName('ADDRESS')))
      .map((a) => a.textContent.trim())
      .filter(Boolean)
      .join(', ')

    if (name) {
      result.ledgers.push({
        name,
        group: parent,
        opening_balance: openingBal,
        current_balance: closingBalance === null ? openingBal : Math.abs(closingBalance),
        closing_balance: closingBalance === null ? null : Math.abs(closingBalance),
        category: tallyLedgerCategory(parent),
        phone,
        email,
        address,
      })
      result.stats.ledgersCount++
    }
  })

  // 2. Parse Stock Items (<STOCKITEM>)
  const stockNodes = xmlDoc.getElementsByTagName('STOCKITEM')
  stockNodes.forEach((node) => {
    const name = node.getAttribute('NAME') || elementText(node, 'NAME')
    const unit = elementText(node, 'BASEUNITS') || 'pcs'
    const category = elementText(node, 'PARENT') || 'General'
    const openingQty = tallyNumber(elementText(node, 'OPENINGBALANCE'))
    const closingQty = tallyNumber(elementText(node, 'CLOSINGBALANCE'))
    const openingRate = tallyNumber(elementText(node, 'OPENINGRATE'))
    const closingRate = tallyNumber(elementText(node, 'CLOSINGRATE'))
    const closingValue = tallyNumber(elementText(node, 'CLOSINGVALUE'))
    const salesRate = tallyNumber(elementText(node, 'BASESELLPRICE', 'SALEPRICE'))
    const currentQty = closingQty ?? openingQty
    const purchaseRate = closingRate ?? openingRate

    if (name) {
      const sku = 'MAT-' + name.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()
      result.stockItems.push({
        sku,
        name,
        category,
        unit,
        ...(purchaseRate !== null ? { purchase_rate: Math.abs(purchaseRate) } : {}),
        ...(salesRate !== null ? { sales_rate: Math.abs(salesRate) } : {}),
        ...(closingValue !== null ? { current_value: Math.abs(closingValue) } : {}),
        ...(currentQty !== null ? { current_qty: currentQty } : {}),
        reorder_threshold: 10,
      })
      result.stats.stockItemsCount++
    }
  })

  // 3. Parse Vouchers (<VOUCHER>)
  const voucherNodes = xmlDoc.getElementsByTagName('VOUCHER')
  voucherNodes.forEach((node, idx) => {
    const rawType = (node.getAttribute('VCHTYPE') || elementText(node, 'VOUCHERTYPENAME', 'VOUCHERTYPE')).trim()

    const rawDate = elementText(node, 'DATE', 'EFFECTIVEDATE')
    const date = formatTallyDate(rawDate)
    const voucherNo = elementText(node, 'VOUCHERNUMBER', 'VOUCHERNO')
    const partyName =
      elementText(node, 'PARTYLEDGERNAME', 'PARTYNAME') ||
      'Cash'
    const narration = elementText(node, 'NARRATION')

    const normalizedType = voucherType(rawType)

    // Parse item rows before ledger postings because Tally stores the sales and
    // purchase ledger allocations inside each inventory line.
    const inventoryNodes = elements(node, ['ALLINVENTORYENTRIES.LIST', 'INVENTORYENTRIES.LIST'])

    // Parse Ledger Entries, including accounting allocations nested under items.
    const ledgerEntries = []
    const ledgerNodes = [
      ...elements(node, ['ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST']),
      ...inventoryNodes.flatMap((invNode) => elements(invNode, ['ACCOUNTINGALLOCATIONS.LIST'])),
    ]
    ledgerNodes.forEach((leNode) => {
      const lName = elementText(leNode, 'LEDGERNAME')
      const rawAmt = numericValue(elementText(leNode, 'AMOUNT'))
      const isPositive = /^yes$/i.test(elementText(leNode, 'ISDEEMEDPOSITIVE'))
      if (!lName) return
      ledgerEntries.push({
        ledger_name: lName,
        amount: Math.abs(rawAmt),
        is_debit: isPositive || rawAmt < 0,
      })
    })

    // Parse Inventory Items if present
    const inventoryItems = []
    inventoryNodes.forEach((invNode) => {
      const itemName = elementText(invNode, 'STOCKITEMNAME')
      const qty = Math.abs(numericValue(elementText(invNode, 'BILLEDQTY', 'ACTUALQTY')))
      const rate = Math.abs(numericValue(elementText(invNode, 'RATE')))
      const rawAmount = tallyNumber(elementText(invNode, 'AMOUNT'))
      const amt = Math.abs(rawAmount ?? (qty && rate ? qty * rate : 0))

      if (itemName && qty > 0) {
        inventoryItems.push({
          name: itemName,
          qty,
          rate,
          amount: amt,
        })
      }
    })

    // Compute net voucher amount
    const inventoryTotal = inventoryItems.reduce((sum, item) => sum + item.amount, 0)
    const postingTotal = Math.max(0, ...ledgerEntries.map((entry) => entry.amount))
    const totalAmount = Math.max(Math.abs(numericValue(elementText(node, 'AMOUNT'))), inventoryTotal, postingTotal)
    const partyPosting = ledgerEntries.find((entry) => entry.ledger_name.toLowerCase() === partyName.toLowerCase())

    const isCashParty = partyName.toLowerCase().includes('cash')
    const dueAmount = normalizedType === 'sales' && partyPosting?.is_debit
      ? Math.min(totalAmount, partyPosting.amount)
      : normalizedType === 'purchase' && partyPosting && !partyPosting.is_debit
        ? Math.min(totalAmount, partyPosting.amount)
        : isCashParty ? 0 : totalAmount
    const paidAmount = Math.max(0, totalAmount - dueAmount)

    result.vouchers.push({
      voucher_no: voucherNo,
      voucher_type: normalizedType,
      date,
      party_name: partyName,
      amount: totalAmount,
      paid_amount: paidAmount,
      due_amount: dueAmount,
      items: inventoryItems,
      ledger_entries: ledgerEntries,
      narration,
      source_system: 'tally',
      source_voucher_guid: elementText(node, 'GUID', 'MASTERID'),
    })

    result.stats.vouchersCount++
    if (normalizedType === 'sales') result.stats.salesCount++
    else if (normalizedType === 'purchase') result.stats.purchaseCount++
    else if (normalizedType === 'receipt') result.stats.receiptCount++
    else if (normalizedType === 'payment') result.stats.paymentCount++
    else if (normalizedType === 'contra') result.stats.contraCount++
    else if (normalizedType === 'journal') result.stats.journalCount++
  })

  return result
}

/**
 * Parse Excel or CSV Tally Export
 */
export async function parseTallyExcel(file) {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheetName = workbook.SheetNames[0]
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' })

  const result = {
    vouchers: [],
    materials: [],
    parties: [],
    problems: [],
    stats: { totalRows: rows.length, parsedVouchers: 0, skippedRows: 0 },
  }

  rows.forEach((row, idx) => {
    // Check common Tally export column headers
    const date = formatTallyDate(row['Date'] || row['DATE'] || row['Voucher Date'])
    const voucherNo = String(row['Vch No.'] || row['Vch No'] || row['Voucher No'] || row['VOUCHER NO'] || '').trim()
    const rawType = String(row['Vch Type'] || row['Voucher Type'] || row['TYPE'] || '').trim()
    const partyName = String(row['Particulars'] || row['Party Name'] || row['PARTY'] || row['Account'] || '').trim()
    const debit = tallyNumber(row['Debit Amount'] ?? row['Debit'] ?? row['DEBIT'])
    const credit = tallyNumber(row['Credit Amount'] ?? row['Credit'] ?? row['CREDIT'])
    const explicitAmount = tallyNumber(row['Amount'] ?? row['AMOUNT'] ?? row['Voucher Amount'])
    const narration = String(row['Narration'] || row['Remarks'] || '').trim()
    const normalizedType = voucherType(rawType)
    const amountValue = explicitAmount ?? Math.max(Math.abs(debit || 0), Math.abs(credit || 0))

    if (!date || !voucherNo || !normalizedType || amountValue <= 0) {
      result.problems.push({
        where: `Spreadsheet row ${idx + 2}`,
        problem: 'Voucher date, number, supported type, or amount is missing.',
        howToFix: 'Export the voucher date, voucher number, voucher type, and debit/credit amount columns from Tally.',
      })
      result.stats.skippedRows++
      return
    }

    result.vouchers.push({
      voucher_no: voucherNo,
      voucher_type: normalizedType,
      date,
      party_name: partyName || 'Cash',
      amount: amountValue,
      paid_amount: normalizedType === 'sales' && partyName.toLowerCase().includes('cash') ? amountValue : 0,
      due_amount: normalizedType === 'sales' && !partyName.toLowerCase().includes('cash') ? amountValue : 0,
      narration,
      items: [],
      ledger_entries: [],
      source_system: 'tally',
    })
    result.stats.parsedVouchers++
  })

  return result
}

/**
 * Generate Tally XML export for current system vouchers and masters
 */
export function generateTallyExportXml({ vouchers = [], materials = [], parties = [], ledgers = [] }) {
  let xml = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>All Masters and Vouchers</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
`

  // Export Ledgers
  ledgers.forEach((l) => {
    xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${escapeXml(l.name)}" ACTION="Create">
            <NAME>${escapeXml(l.name)}</NAME>
            <PARENT>${escapeXml(l.group || 'Sundry Debtors')}</PARENT>
            <OPENINGBALANCE>${Number(l.opening_balance || 0).toFixed(2)}</OPENINGBALANCE>
          </LEDGER>
        </TALLYMESSAGE>
`
  })

  // Export Parties as Ledgers
  parties.forEach((p) => {
    const parent = p.type === 'creditor' ? 'Sundry Creditors' : 'Sundry Debtors'
    xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="${escapeXml(p.name)}" ACTION="Create">
            <NAME>${escapeXml(p.name)}</NAME>
            <PARENT>${parent}</PARENT>
            <OPENINGBALANCE>${Number(p.opening_balance || 0).toFixed(2)}</OPENINGBALANCE>
            ${p.uid ? `<LEDGERCODE>${escapeXml(p.uid)}</LEDGERCODE>` : ''}
            <LEDGERPHONE>${escapeXml(p.phone || '')}</LEDGERPHONE>
          </LEDGER>
        </TALLYMESSAGE>
`
  })

  // Export Stock Items
  materials.forEach((m) => {
    xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="${escapeXml(m.name)}" ACTION="Create">
            <NAME>${escapeXml(m.name)}</NAME>
            <BASEUNITS>${escapeXml(m.unit || 'pcs')}</BASEUNITS>
            <OPENINGBALANCE>${Number(m.current_qty || 0)} ${escapeXml(m.unit || 'pcs')}</OPENINGBALANCE>
            <OPENINGRATE>${Number(m.purchase_rate || 0).toFixed(2)}/${escapeXml(m.unit || 'pcs')}</OPENINGRATE>
          </STOCKITEM>
        </TALLYMESSAGE>
`
  })

  // Export Vouchers
  vouchers.forEach((v) => {
    const vchType = capitalize(v.voucher_type || 'sales')
    const tallyDate = (v.date || '').replace(/[^0-9]/g, '') || '20261014'

    xml += `        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="${vchType}" ACTION="Create">
            <DATE>${tallyDate}</DATE>
            <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${escapeXml(v.voucher_no || '')}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${escapeXml(v.party_name || 'Cash')}</PARTYLEDGERNAME>
            <NARRATION>${escapeXml(v.narration || '')}</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${escapeXml(v.party_name || 'Cash')}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${v.voucher_type === 'sales' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
              <AMOUNT>-${Number(v.amount || 0).toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
`
    if (Array.isArray(v.items) && v.items.length > 0) {
      v.items.forEach((item) => {
        xml += `            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>${escapeXml(item.name)}</STOCKITEMNAME>
              <BILLEDQTY>${Number(item.qty || 1)} ${escapeXml(item.unit || 'pcs')}</BILLEDQTY>
              <RATE>${Number(item.rate || 0).toFixed(2)}</RATE>
              <AMOUNT>${Number(item.amount || (item.qty * item.rate)).toFixed(2)}</AMOUNT>
            </ALLINVENTORYENTRIES.LIST>
`
      })
    }
    xml += `          </VOUCHER>
        </TALLYMESSAGE>
`
  })

  xml += `      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`

  return xml
}

function escapeXml(unsafe = '') {
  return String(unsafe).replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '&': return '&amp;'
      case '\'': return '&apos;'
      case '"': return '&quot;'
      default: return c
    }
  })
}

function capitalize(s) {
  if (!s) return ''
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Built-in Sample Tally Prime Export XML Data for 1-Click Demo & Testing
 */
export const SAMPLE_TALLY_XML = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Export Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers &amp; Masters</REPORTNAME>
      </REQUESTDESC>
      <REQUESTDATA>
        <!-- Master Ledgers -->
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="Apex Infotech Pvt Ltd" ACTION="Create">
            <NAME>Apex Infotech Pvt Ltd</NAME>
            <PARENT>Sundry Debtors</PARENT>
            <OPENINGBALANCE>12500.00</OPENINGBALANCE>
            <LEDGERPHONE>+91 98450 11223</LEDGERPHONE>
          </LEDGER>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="Metro Steel &amp; Hardware" ACTION="Create">
            <NAME>Metro Steel &amp; Hardware</NAME>
            <PARENT>Sundry Creditors</PARENT>
            <OPENINGBALANCE>45000.00</OPENINGBALANCE>
            <LEDGERPHONE>+91 98210 99887</LEDGERPHONE>
          </LEDGER>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <LEDGER NAME="HDFC Current Account 0422" ACTION="Create">
            <NAME>HDFC Current Account 0422</NAME>
            <PARENT>Bank Accounts</PARENT>
            <OPENINGBALANCE>385000.00</OPENINGBALANCE>
          </LEDGER>
        </TALLYMESSAGE>
        <!-- Master Stock Items -->
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="Industrial Cotton Canvas 350 GSM" ACTION="Create">
            <NAME>Industrial Cotton Canvas 350 GSM</NAME>
            <BASEUNITS>meter</BASEUNITS>
            <OPENINGBALANCE>1200 meter</OPENINGBALANCE>
            <OPENINGRATE>145.00/meter</OPENINGRATE>
          </STOCKITEM>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <STOCKITEM NAME="High Tensile Steel Bolts M12" ACTION="Create">
            <NAME>High Tensile Steel Bolts M12</NAME>
            <BASEUNITS>box</BASEUNITS>
            <OPENINGBALANCE>85 box</OPENINGBALANCE>
            <OPENINGRATE>420.00/box</OPENINGRATE>
          </STOCKITEM>
        </TALLYMESSAGE>
        <!-- Vouchers -->
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create">
            <DATE>20261014</DATE>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>TALLY-SL-801</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Apex Infotech Pvt Ltd</PARTYLEDGERNAME>
            <NARRATION>Tax invoice goods sold under PO #9482</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Apex Infotech Pvt Ltd</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-28500.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>Industrial Cotton Canvas 350 GSM</STOCKITEMNAME>
              <BILLEDQTY>150 meter</BILLEDQTY>
              <RATE>190.00</RATE>
              <AMOUNT>28500.00</AMOUNT>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Purchase" ACTION="Create">
            <DATE>20261013</DATE>
            <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
            <VOUCHERNUMBER>TALLY-PUR-402</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Metro Steel &amp; Hardware</PARTYLEDGERNAME>
            <NARRATION>Inward raw material supply</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Metro Steel &amp; Hardware</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>21000.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLINVENTORYENTRIES.LIST>
              <STOCKITEMNAME>High Tensile Steel Bolts M12</STOCKITEMNAME>
              <BILLEDQTY>50 box</BILLEDQTY>
              <RATE>420.00</RATE>
              <AMOUNT>21000.00</AMOUNT>
            </ALLINVENTORYENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Receipt" ACTION="Create">
            <DATE>20261014</DATE>
            <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
            <VOUCHERNUMBER>TALLY-REC-105</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Apex Infotech Pvt Ltd</PARTYLEDGERNAME>
            <NARRATION>Cheque received against previous pending dues</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>HDFC Current Account 0422</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-12500.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Apex Infotech Pvt Ltd</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>12500.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Contra" ACTION="Create">
            <DATE>20261014</DATE>
            <VOUCHERTYPENAME>Contra</VOUCHERTYPENAME>
            <VOUCHERNUMBER>TALLY-CNT-019</VOUCHERNUMBER>
            <PARTYLEDGERNAME>Cash</PARTYLEDGERNAME>
            <NARRATION>Cash deposit into HDFC Bank</NARRATION>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>HDFC Current Account 0422</LEDGERNAME>
              <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
              <AMOUNT>-25000.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>Cash</LEDGERNAME>
              <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
              <AMOUNT>25000.00</AMOUNT>
            </ALLLEDGERENTRIES.LIST>
          </VOUCHER>
        </TALLYMESSAGE>
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>`

/**
 * Persist parsed Tally XML or Excel records directly into Dexie DB
 */
export async function importTallyDataToDb(parsedData) {
  let newCount = 0
  let skippedCount = 0
  let updatedCount = 0
  const problems = []

  // 1. Import Ledgers
  if (Array.isArray(parsedData.ledgers) && parsedData.ledgers.length > 0) {
    for (const l of parsedData.ledgers) {
      try {
        const groupName = String(l.group || 'General')
        const partyType = tallyPartyType(groupName)
        const currentBalance = Number(l.closing_balance ?? l.current_balance ?? l.opening_balance ?? 0)
        const openingBalance = Number(l.opening_balance ?? 0)
        if (partyType === 'debtor') {
          const existing = await accDb.parties.where('name').equalsIgnoreCase(l.name.trim()).filter((party) => party.type === 'debtor').first()
          if (existing) {
            await accDb.parties.update(existing.id, {
              opening_balance: openingBalance,
              current_balance: Math.abs(currentBalance),
              phone: l.phone || existing.phone || '',
              email: l.email || existing.email || '',
              address: l.address || existing.address || '',
            })
            updatedCount++
          } else {
            await createDebtor({
              name: l.name,
              phone: l.phone || '',
              current_balance: Math.abs(currentBalance),
              due_days: 15,
            })
            const created = await accDb.parties.where('name').equalsIgnoreCase(l.name.trim()).first()
            if (created) await accDb.parties.update(created.id, { opening_balance: openingBalance, email: l.email || '', address: l.address || '' })
            newCount++
          }
        } else if (partyType === 'creditor') {
          const existing = await accDb.parties.where('name').equalsIgnoreCase(l.name.trim()).filter((party) => party.type === 'creditor').first()
          if (existing) {
            await accDb.parties.update(existing.id, {
              opening_balance: openingBalance,
              current_balance: Math.abs(currentBalance),
              phone: l.phone || existing.phone || '',
              email: l.email || existing.email || '',
              address: l.address || existing.address || '',
            })
            updatedCount++
          } else {
            await createCreditor({
              name: l.name,
              phone: l.phone || '',
              current_balance: Math.abs(currentBalance),
              due_days: 14,
              next_payment: 'Next month',
            })
            const created = await accDb.parties.where('name').equalsIgnoreCase(l.name.trim()).first()
            if (created) await accDb.parties.update(created.id, { opening_balance: openingBalance, email: l.email || '', address: l.address || '' })
            newCount++
          }
        } else {
          const category = l.category || tallyLedgerCategory(groupName)
          const existing = await accDb.ledgers.where('name').equalsIgnoreCase(l.name.trim()).first()
          if (existing) {
            await accDb.ledgers.update(existing.id, {
              group: groupName,
              category,
              opening_balance: openingBalance,
              current_balance: Math.abs(currentBalance),
            })
            updatedCount++
          } else {
            await accDb.ledgers.add({
              name: l.name.trim(),
              group: groupName,
              category,
              opening_balance: openingBalance,
              current_balance: Math.abs(currentBalance),
            })
            newCount++
          }
        }
      } catch (err) {
        problems.push({
          where: `Ledger ${l.name}`,
          problem: err.message || 'Error importing ledger',
          howToFix: 'Check ledger details in Tally',
        })
      }
    }
  }

  // 2. Import Stock Items
  if (Array.isArray(parsedData.stockItems) && parsedData.stockItems.length > 0) {
    for (const item of parsedData.stockItems) {
      try {
        const existing = await accDb.materials.where('name').equalsIgnoreCase(item.name.trim()).first()
        if (existing) {
          const changes = {}
          for (const field of ['current_qty', 'current_value', 'purchase_rate', 'sales_rate']) {
            if (item[field] != null && Number.isFinite(Number(item[field]))) changes[field] = Number(item[field])
          }
          if (item.category) changes.category = item.category
          if (item.unit) changes.unit = item.unit
          if (item.sku) changes.sku = item.sku
          await accDb.materials.update(existing.id, changes)
          updatedCount++
        } else {
          await createStockItem({
            name: item.name,
            sku: item.sku,
            category: item.category || 'Tally Imported',
            unit: item.unit || 'pcs',
            purchase_rate: item.purchase_rate ?? 0,
            sales_rate: item.sales_rate ?? null,
            current_qty: item.current_qty ?? 0,
            current_value: item.current_value ?? null,
            reorder_threshold: Number(item.reorder_threshold) || 10,
          })
          newCount++
        }
      } catch (err) {
        problems.push({
          where: `Stock item ${item.name}`,
          problem: err.message || 'Error importing stock item',
          howToFix: 'Verify unit and rate in Tally',
        })
      }
    }
  }

  // 3. Import Vouchers
  if (Array.isArray(parsedData.vouchers) && parsedData.vouchers.length > 0) {
    const existingVouchers = await accDb.vouchers.toArray()
    for (const v of parsedData.vouchers) {
      try {
        if (!v.voucher_no?.trim() || !v.date || !v.voucher_type || !Number.isFinite(Number(v.amount))) {
          problems.push({
            where: `Voucher ${v.voucher_no || '(no number)'}`,
            problem: 'Voucher is missing a valid date, number, type, or amount.',
            howToFix: 'Export the complete voucher header and amount from Tally.',
          })
          continue
        }
        const sourceCompany = v.source_company || parsedData.companyName || ''
        const existing = (v.source_voucher_guid
          ? existingVouchers.find((voucher) => voucher.source_voucher_guid === v.source_voucher_guid && (voucher.source_company || '') === sourceCompany)
          : null) || existingVouchers.find((voucher) => voucher.voucher_no?.toLowerCase() === v.voucher_no.trim().toLowerCase())
        const normalizedVoucher = {
          ...v,
          source_system: 'tally',
          source_company: sourceCompany,
          ledger_entries: Array.isArray(v.ledger_entries) ? v.ledger_entries : [],
        }
        if (existing) {
          await updateVoucher(existing.id, normalizedVoucher)
          Object.assign(existing, normalizedVoucher)
          updatedCount++
        } else {
          await createVoucher(normalizedVoucher)
          existingVouchers.push(normalizedVoucher)
          newCount++
        }
      } catch (err) {
        problems.push({
          where: `Voucher ${v.voucher_no}`,
          problem: err.message || 'Error processing voucher',
          howToFix: 'Check voucher ledger balances',
        })
      }
    }
  }

  window.dispatchEvent(new Event('accounting-data-updated'))
  return { newCount, skippedCount, updatedCount, problems }
}

