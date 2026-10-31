import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  parseTallyXml, classifyVoucherType, signedAmount, resolveRootGroup, categoryForGroup,
} from '../supabase/functions/tally-import/parser.js'
import { tallyLedgerCategory } from '../src/lib/tallyLedgerCategory.js'

const deps = { XMLParser, XMLValidator }
const wrap = (inner) => `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`
const entry = (tag, name, amount, deemed) =>
  `<${tag}><LEDGERNAME>${name}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></${tag}>`
const voucher = ({ type = 'Sales', no = '1', guid = 'g1', party = 'Acme', extra = '', body }) =>
  `<VOUCHER VCHTYPE="${type}"><DATE>20261030</DATE><GUID>${guid}</GUID><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${no}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>${extra}${body}</VOUCHER>`

const parse = async (xml, options) => (await parseTallyXml(wrap(xml), 'Co', deps, options))

describe('amount signs', () => {
  it('uses Tally convention: Dr negative, Cr positive, and understands Dr/Cr suffixes', () => {
    assert.equal(signedAmount('-1,500.50'), -1500.5)
    assert.equal(signedAmount('1,500.50 Dr'), -1500.5)
    assert.equal(signedAmount('1,500.50 Cr'), 1500.5)
    assert.equal(signedAmount('(200.00)'), -200)
  })
})

describe('voucher type classification', () => {
  it('does not treat orders / receipt notes / stock journals as accounting vouchers', () => {
    for (const name of ['Sales Order', 'Purchase Order', 'Receipt Note', 'Delivery Note', 'Stock Journal', 'Rejections In']) {
      assert.deepEqual(classifyVoucherType(name), { type: '', ignore: true }, name)
    }
  })
  it('keeps returns as their own types instead of dropping or adding them to sales', () => {
    assert.equal(classifyVoucherType('Credit Note').type, 'credit_note')
    assert.equal(classifyVoucherType('Sales Return').type, 'credit_note')
    assert.equal(classifyVoucherType('Debit Note').type, 'debit_note')
    assert.equal(classifyVoucherType('Sales - GST').type, 'sales')
    assert.equal(classifyVoucherType('Journal').type, 'journal')
  })
})

describe('sales voucher math', () => {
  const body = entry('ALLLEDGERENTRIES.LIST', 'Acme', '-11800.00', 'Yes') +
    entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '10000.00', 'No') +
    entry('ALLLEDGERENTRIES.LIST', 'CGST', '900.00', 'No') +
    entry('ALLLEDGERENTRIES.LIST', 'SGST', '900.00', 'No')

  it('amount is the party-side gross and due is the party debit', async () => {
    const { rows } = await parse(voucher({ body }))
    const p = rows[0].payload
    assert.equal(p.amount, 11800)
    assert.equal(p.due_amount, 11800)
    assert.equal(p.paid_amount, 0)
    assert.equal(p.ledger_entries.find((e) => e.ledger_name === 'Acme').is_debit, true)
  })

  it('a discount ledger no longer shows up as money the customer "paid"', async () => {
    const b = entry('ALLLEDGERENTRIES.LIST', 'Acme', '-9500.00', 'Yes') +
      entry('ALLLEDGERENTRIES.LIST', 'Discount Allowed', '-500.00', 'Yes') +
      entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '10000.00', 'No') +
      '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Pen</STOCKITEMNAME><BILLEDQTY>100 Nos</BILLEDQTY><RATE>100/Nos</RATE><AMOUNT>10000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>'
    const p = (await parse(voucher({ body: b }))).rows[0].payload
    assert.equal(p.amount, 10000)
    assert.equal(p.due_amount, 9500)
    assert.equal(p.paid_amount, 500)
    assert.equal(p.items[0].qty, 100)
  })

  it('a party whose name merely contains "cash" still owes money; real cash sales do not', async () => {
    const credit = (await parse(voucher({ party: 'Cashew Traders', body: entry('ALLLEDGERENTRIES.LIST', 'Cashew Traders', '-500', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '500', 'No') }))).rows[0].payload
    assert.equal(credit.due_amount, 500)
    const cash = (await parse(voucher({ party: 'Cash', body: entry('ALLLEDGERENTRIES.LIST', 'Cash', '-500', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '500', 'No') }))).rows[0].payload
    assert.equal(cash.due_amount, 0)
    assert.equal(cash.paid_amount, 500)
    const bank = (await parse(voucher({ party: 'HDFC Current', body: entry('ALLLEDGERENTRIES.LIST', 'HDFC Current', '-500', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '500', 'No') }), { cashLedgerNames: new Set(['hdfc current']) })).rows[0].payload
    assert.equal(bank.due_amount, 0)
  })

  it('does not double count when Tally exposes the same postings under both ALL* and plain tags', async () => {
    const both = body + body.replaceAll('ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST')
    const p = (await parse(voucher({ body: both }))).rows[0].payload
    assert.equal(p.ledger_entries.length, 4)
    assert.equal(p.amount, 11800)
  })

  it('a receipt from a party is not a new debt', async () => {
    const p = (await parse(voucher({ type: 'Receipt', body: entry('ALLLEDGERENTRIES.LIST', 'Acme', '5000', 'No') + entry('ALLLEDGERENTRIES.LIST', 'HDFC Current', '-5000', 'Yes') }))).rows[0].payload
    assert.equal(p.voucher_type, 'receipt')
    assert.equal(p.due_amount, 0)
    assert.equal(p.paid_amount, 5000)
  })

  it('purchase: due is the credit owed to the supplier', async () => {
    const p = (await parse(voucher({ type: 'Purchase', party: 'Mill', body: entry('ALLLEDGERENTRIES.LIST', 'Mill', '2360', 'No') + entry('ALLLEDGERENTRIES.LIST', 'Purchase Account', '-2000', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Input GST', '-360', 'Yes') }))).rows[0].payload
    assert.equal(p.amount, 2360)
    assert.equal(p.due_amount, 2360)
  })
})

describe('voucher filtering', () => {
  it('skips cancelled, optional and non-accounting vouchers and reports them', async () => {
    const e = entry('ALLLEDGERENTRIES.LIST', 'Acme', '-100', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '100', 'No')
    const result = await parse(
      voucher({ guid: 'a', body: e }) +
      voucher({ guid: 'b', extra: '<ISCANCELLED>Yes</ISCANCELLED>', body: e }) +
      voucher({ guid: 'c', extra: '<ISOPTIONAL>Yes</ISOPTIONAL>', body: e }) +
      voucher({ guid: 'd', type: 'Sales Order', body: e }),
    )
    assert.equal(result.rows.length, 1)
    assert.deepEqual(result.ignored, { nonAccounting: 1, cancelled: 1, optional: 1 })
  })
})

describe('ledger balances keep their side', () => {
  const groups = { 'Retail Customers': 'Sundry Debtors', 'Sundry Debtors': '', 'Bank Accounts': '' }
  it('resolves sub-groups to their primary group', () => {
    assert.equal(resolveRootGroup('Retail Customers', groups), 'Sundry Debtors')
  })

  it('customer who owes us is positive, one who prepaid is negative; overdrawn bank is negative', async () => {
    const ledger = (name, parent, closing) => `<LEDGER NAME="${name}"><PARENT>${parent}</PARENT><OPENINGBALANCE>0</OPENINGBALANCE><CLOSINGBALANCE>${closing}</CLOSINGBALANCE></LEDGER>`
    const { rows } = await parse(
      ledger('Debtor Owes', 'Retail Customers', '-5000.00') +
      ledger('Debtor Prepaid', 'Retail Customers', '700.00') +
      ledger('HDFC OD', 'Bank Accounts', '1200.00'),
      { groupParents: groups })
    const by = Object.fromEntries(rows.map((r) => [r.payload.name, r]))
    assert.equal(by['Debtor Owes'].rowType, 'party')
    assert.equal(by['Debtor Owes'].payload.type, 'debtor')
    assert.equal(by['Debtor Owes'].payload.current_balance, 5000)
    assert.equal(by['Debtor Prepaid'].payload.current_balance, -700)
    assert.equal(by['HDFC OD'].rowType, 'ledger')
    assert.equal(by['HDFC OD'].payload.current_balance, -1200)
  })
})

describe('stock', () => {
  it('keeps negative (oversold) stock negative', async () => {
    const { rows } = await parse('<STOCKITEM NAME="Widget"><CLOSINGBALANCE>-3 Nos</CLOSINGBALANCE><CLOSINGVALUE>-300.00</CLOSINGVALUE><CLOSINGRATE>100.00</CLOSINGRATE></STOCKITEM>')
    assert.equal(rows[0].payload.current_qty, -3)
    assert.equal(rows[0].payload.purchase_rate, 100)
  })
})

describe('group → category', () => {
  it('fixes the groups the old keyword rules misclassified', () => {
    assert.equal(categoryForGroup('Loans & Advances (Asset)'), 'asset')
    assert.equal(categoryForGroup('Duties & Taxes'), 'liability')
    assert.equal(categoryForGroup('Reserves & Surplus'), 'liability')
    assert.equal(categoryForGroup('Bank OD A/c'), 'liability')
    assert.equal(categoryForGroup('Purchase Accounts'), 'expense')
  })
  it('client and edge function agree for every reserved group', () => {
    const groups = ['Direct Expenses', 'Indirect Expenses', 'Purchase Accounts', 'Direct Incomes', 'Indirect Incomes', 'Sales Accounts',
      'Capital Account', 'Reserves & Surplus', 'Current Liabilities', 'Duties & Taxes', 'Provisions', 'Sundry Creditors', 'Loans (Liability)',
      'Secured Loans', 'Unsecured Loans', 'Bank OD A/c', 'Bank Accounts', 'Cash-in-Hand', 'Current Assets', 'Deposits (Asset)', 'Fixed Assets',
      'Investments', 'Loans & Advances (Asset)', 'Stock-in-Hand', 'Sundry Debtors', 'Misc. Expenses (ASSET)', 'Suspense A/c', 'Staff Loan Recoverable', 'Freight Charges']
    for (const g of groups) assert.equal(tallyLedgerCategory(g), categoryForGroup(g), g)
  })
})
