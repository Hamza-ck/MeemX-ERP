import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calculateDashboardMetrics, calculateExpenseBreakdown, computeDebtorAging } from '../src/lib/dashboardMetrics.js'

const now = new Date(2026, 9, 30, 12)
const ledgers = [
  { name: 'Sales Account', group: 'Sales Accounts', primary_group: 'Sales Accounts', category: 'income' },
  { name: 'Purchase Account', group: 'Purchase Accounts', primary_group: 'Purchase Accounts', category: 'expense' },
  { name: 'Rent', group: 'Indirect Expenses', primary_group: 'Indirect Expenses', category: 'expense' },
  { name: 'Transport', group: 'Indirect Expenses', primary_group: 'Indirect Expenses', category: 'expense' },
  { name: 'CGST', group: 'Duties & Taxes', primary_group: 'Duties & Taxes', category: 'liability' },
  { name: 'HDFC', group: 'Bank Accounts', category: 'asset' },
]
const tally = (o) => ({ source_system: 'tally', items: [], deleted_at: null, ...o })
const e = (ledger_name, amount, is_debit) => ({ ledger_name, amount, is_debit })

describe('profit', () => {
  it('buying stock is not an expense: profit = net sales − cost of goods sold − opex', () => {
    const vouchers = [
      tally({ voucher_type: 'sales', date: '2026-10-30', amount: 11800, party_name: 'Acme', items: [{ name: 'Pen', qty: 100 }],
        ledger_entries: [e('Acme', 11800, true), e('Sales Account', 10000, false), e('CGST', 1800, false)] }),
      tally({ voucher_type: 'purchase', date: '2026-10-30', amount: 50000, party_name: 'Mill',
        ledger_entries: [e('Mill', 50000, false), e('Purchase Account', 50000, true)] }),
      tally({ voucher_type: 'payment', date: '2026-10-30', amount: 1000, party_name: 'Rent',
        ledger_entries: [e('HDFC', 1000, false), e('Rent', 1000, true)] }),
    ]
    const materials = [{ name: 'Pen', current_qty: 400, current_value: 20000, purchase_rate: 1 }]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials })
    assert.equal(r.operatingResultToday, 4000)
    assert.equal(r.expensesToday, 1000)
    assert.equal(r.salesToday, 11800)
  })

  it('credit notes reduce both sales and profit', () => {
    const vouchers = [
      tally({ voucher_type: 'sales', date: '2026-10-30', amount: 1000, party_name: 'A', items: [{ name: 'Pen', qty: 10 }],
        ledger_entries: [e('A', 1000, true), e('Sales Account', 1000, false)] }),
      tally({ voucher_type: 'credit_note', date: '2026-10-30', amount: 400, party_name: 'A', items: [{ name: 'Pen', qty: 4 }],
        ledger_entries: [e('A', 400, false), e('Sales Account', 400, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials: [{ name: 'Pen', current_qty: 10, current_value: 500 }] })
    assert.equal(r.salesToday, 600)
    assert.equal(r.operatingResultToday, 600 - (10 * 50 - 4 * 50))
  })

  it('without item data it falls back to a purchases basis instead of showing nothing', () => {
    const vouchers = [
      tally({ voucher_type: 'sales', date: '2026-10-30', amount: 1000, party_name: 'A', ledger_entries: [e('A', 1000, true), e('Sales Account', 1000, false)] }),
      tally({ voucher_type: 'purchase', date: '2026-10-30', amount: 300, party_name: 'M', ledger_entries: [e('M', 300, false), e('Purchase Account', 300, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now)
    assert.equal(r.operatingResultToday, 700)
    assert.match(r.operatingResultBasis.today, /purchases/)
  })

  it('stays unavailable when an item has no cost, instead of guessing zero', () => {
    const vouchers = [tally({ voucher_type: 'sales', date: '2026-10-30', amount: 100, party_name: 'A', items: [{ name: 'Mystery', qty: 1 }],
      ledger_entries: [e('A', 100, true), e('Sales Account', 100, false)] })]
    assert.equal(calculateDashboardMetrics(vouchers, ledgers, now).operatingResultToday, null)
  })

  it('ignores soft-deleted vouchers', () => {
    const v = tally({ voucher_type: 'sales', date: '2026-10-30', amount: 500, party_name: 'A', deleted_at: '2026-10-30T00:00:00Z', ledger_entries: [] })
    assert.equal(calculateDashboardMetrics([v], ledgers, now).salesToday, 0)
  })
})

describe('expense breakdown', () => {
  const pay = (date, ledger, amount) => tally({ voucher_type: 'payment', date, amount, party_name: ledger,
    ledger_entries: [e('HDFC', amount, false), e(ledger, amount, true)] })

  it('uses this month\'s postings, excludes purchases, and compares equal day-spans', () => {
    const vouchers = [
      pay('2026-10-05', 'Rent', 10000), pay('2026-10-20', 'Transport', 2000),
      pay('2026-09-05', 'Rent', 10000),
      pay('2026-09-12', 'Transport', 5000),
      tally({ voucher_type: 'purchase', date: '2026-10-10', amount: 99999, party_name: 'M', ledger_entries: [e('M', 99999, false), e('Purchase Account', 99999, true)] }),
    ]
    const r = calculateExpenseBreakdown(vouchers, ledgers.map((l) => ({ ...l, current_balance: 999999 })), now)
    assert.equal(r.total, 12000)
    assert.deepEqual(r.categories.map((c) => c.name), ['Rent', 'Transport'])
    assert.equal(r.previousTotal, 15000)
    assert.equal(r.changePct, -20)
  })

  it('reports no comparison instead of a made-up percentage when last month is empty', () => {
    const r = calculateExpenseBreakdown([pay('2026-10-05', 'Rent', 100)], ledgers, now)
    assert.equal(r.changePct, null)
  })
})

describe('debtor ageing', () => {
  const inv = (no, date, due) => ({ id: no, voucher_no: no, voucher_type: 'sales', date, party_name: 'Acme', due_amount: due })

  it('ages the balance by real invoice dates (newest invoices are the unpaid ones)', () => {
    const parties = [{ id: 1, name: 'Acme', type: 'debtor', current_balance: 1500 }]
    const vouchers = [inv('S1', '2026-07-01', 1000), inv('S2', '2026-09-20', 800), inv('S3', '2026-10-25', 700)]
    const { byParty, totals, outstandingByVoucher } = computeDebtorAging(parties, vouchers, now)
    assert.equal(totals['0–30d'], 700)
    assert.equal(totals['31–60d'], 800)
    assert.equal(totals['60d+'], 0)
    assert.equal(byParty.get(1).bucket, '31–60d')
    assert.equal(outstandingByVoucher.get('S1'), undefined)
    assert.equal(outstandingByVoucher.get('S3'), 700)
  })

  it('balance not explained by any invoice is an old opening balance → 60d+', () => {
    const parties = [{ id: 1, name: 'Acme', type: 'debtor', current_balance: 5000 }]
    const { totals } = computeDebtorAging(parties, [inv('S3', '2026-10-25', 700)], now)
    assert.equal(totals['0–30d'], 700)
    assert.equal(totals['60d+'], 4300)
  })

  it('customers with an advance (negative balance) are not counted as owing', () => {
    const parties = [{ id: 1, name: 'Acme', type: 'debtor', current_balance: -300 }]
    const { totals } = computeDebtorAging(parties, [inv('S3', '2026-10-25', 700)], now)
    assert.deepEqual(totals, { '0–30d': 0, '31–60d': 0, '60d+': 0 })
  })
})
