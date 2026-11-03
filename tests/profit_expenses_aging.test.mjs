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

describe('profit = sales − cost of items sold − expenses', () => {
  const sale = (extra) => tally({ voucher_type: 'sales', date: '2026-10-30', party_name: 'Acme', ...extra })
  const materials = [{ name: 'Pen', current_qty: 400, current_value: 20000 }]       // average cost 50

  it('worked example: every figure can be checked by hand', () => {
    const vouchers = [
      // 100 pens at 100 = 10,000 before GST (invoice total 11,800)
      sale({ amount: 11800, items: [{ name: 'Pen', qty: 100, rate: 100, amount: 10000 }],
        ledger_entries: [e('Acme', 11800, true), e('Sales Account', 10000, false), e('CGST', 1800, false)] }),
      // buying stock is NOT an expense and not cost of goods sold until it is sold
      tally({ voucher_type: 'purchase', date: '2026-10-30', amount: 50000, party_name: 'Mill',
        ledger_entries: [e('Mill', 50000, false), e('Purchase Account', 50000, true)] }),
      tally({ voucher_type: 'payment', date: '2026-10-30', amount: 1000, party_name: 'Rent',
        ledger_entries: [e('HDFC', 1000, false), e('Rent', 1000, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials })
    assert.deepEqual(r.operatingResultDetail.today, { sales: 10000, cost: 5000, expenses: 1000, missingItems: [], missingAmount: 0 })
    assert.equal(r.operatingResultToday, 4000)         // 10,000 − 5,000 − 1,000
    assert.equal(r.expensesToday, 1000)                // same expenses as the Expenses card
    assert.equal(r.salesToday, 11800)                  // the Sales card still shows the invoice total
    assert.equal(r.operatingResultApprox.today, false)
  })

  it('sales returns (credit notes) take back both the sales value and the item cost', () => {
    const vouchers = [
      sale({ amount: 1000, items: [{ name: 'Pen', qty: 10, rate: 100, amount: 1000 }], ledger_entries: [e('Acme', 1000, true), e('Sales Account', 1000, false)] }),
      tally({ voucher_type: 'credit_note', date: '2026-10-30', amount: 400, party_name: 'Acme', items: [{ name: 'Pen', qty: 4, rate: 100, amount: 400 }],
        ledger_entries: [e('Acme', 400, false), e('Sales Account', 400, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials })
    assert.equal(r.operatingResultDetail.today.sales, 600)
    assert.equal(r.operatingResultDetail.today.cost, 300)       // 6 pens × 50
    assert.equal(r.operatingResultToday, 300)
  })

  it('does not estimate: an item with no cost is listed and the result is flagged, not guessed', () => {
    const vouchers = [
      sale({ amount: 1000, items: [{ name: 'Pen', qty: 10, rate: 100, amount: 1000 }], ledger_entries: [e('Acme', 1000, true), e('Sales Account', 1000, false)] }),
      sale({ amount: 700, items: [{ name: 'Gadget', qty: 1, rate: 700, amount: 700 }], ledger_entries: [e('Acme', 700, true), e('Sales Account', 700, false)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials })
    assert.equal(r.operatingResultDetail.today.cost, 500)       // Pen only; Gadget is NOT given an invented cost
    assert.deepEqual(r.operatingResultDetail.today.missingItems, [{ name: 'Gadget', amount: 700 }])
    assert.equal(r.operatingResultToday, 1700 - 500)
    assert.equal(r.operatingResultApprox.today, true)
    assert.match(r.operatingResultNote.today, /1 item sold with no cost/)
  })

  it('an item that is out of stock uses the last rate it was bought at', () => {
    const vouchers = [
      tally({ voucher_type: 'purchase', date: '2026-10-01', amount: 400, party_name: 'M', items: [{ name: 'Pen', qty: 10, rate: 40, amount: 400 }],
        ledger_entries: [e('M', 400, false), e('Purchase Account', 400, true)] }),
      sale({ amount: 1000, items: [{ name: 'Pen', qty: 10, rate: 100, amount: 1000 }], ledger_entries: [e('Acme', 1000, true), e('Sales Account', 1000, false)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials: [{ name: 'Pen', current_qty: 0, current_value: 0, purchase_rate: 0 }] })
    assert.equal(r.operatingResultDetail.today.cost, 400)
    assert.equal(r.operatingResultToday, 600)
  })

  it('a sale with no item lines counts at its sales-ledger value with no item cost', () => {
    const vouchers = [sale({ amount: 5900, items: [], ledger_entries: [e('Acme', 5900, true), e('Sales Account', 5000, false), e('CGST', 900, false)] })]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials })
    assert.equal(r.operatingResultDetail.today.sales, 5000)
    assert.equal(r.operatingResultToday, 5000)
  })

  it('expenses are operating expenses only (purchases excluded) and match the expense breakdown', () => {
    const vouchers = [
      tally({ voucher_type: 'payment', date: '2026-10-05', amount: 700, party_name: 'Rent', ledger_entries: [e('HDFC', 700, false), e('Rent', 700, true)] }),
      tally({ voucher_type: 'purchase', date: '2026-10-05', amount: 9000, party_name: 'M', ledger_entries: [e('M', 9000, false), e('Purchase Account', 9000, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now)
    assert.equal(r.expensesMonth, 700)
    assert.equal(calculateExpenseBreakdown(vouchers, ledgers, now).total, 700)
  })

  it('ignores soft-deleted vouchers', () => {
    const v = sale({ amount: 500, deleted_at: '2026-10-30T00:00:00Z', items: [{ name: 'Pen', qty: 1, rate: 500, amount: 500 }], ledger_entries: [] })
    assert.equal(calculateDashboardMetrics([v], ledgers, now).salesToday, 0)
  })

  it('last month is its own calendar month, not month-to-date', () => {
    const vouchers = [
      sale({ date: '2026-09-15', amount: 1000, items: [{ name: 'Pen', qty: 10, rate: 100, amount: 1000 }], ledger_entries: [e('Acme', 1000, true), e('Sales Account', 1000, false)] }),
      tally({ voucher_type: 'payment', date: '2026-09-20', amount: 100, party_name: 'Rent', ledger_entries: [e('HDFC', 100, false), e('Rent', 100, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, new Date(2026, 9, 5), { materials })
    assert.equal(r.operatingResultPrevMonth, 1000 - 500 - 100)
    assert.equal(r.operatingResultMonth, null)         // nothing yet in October
  })
})

describe('expense breakdown', () => {
  const pay = (date, ledger, amount) => tally({ voucher_type: 'payment', date, amount, party_name: ledger,
    ledger_entries: [e('HDFC', amount, false), e(ledger, amount, true)] })

  it('uses this month\'s postings, excludes purchases, and compares equal day-spans', () => {
    const vouchers = [
      pay('2026-10-05', 'Rent', 10000), pay('2026-10-20', 'Transport', 2000),
      pay('2026-09-05', 'Rent', 10000),          // inside Sep 1–30 comparison span
      pay('2026-09-12', 'Transport', 5000),
      tally({ voucher_type: 'purchase', date: '2026-10-10', amount: 99999, party_name: 'M', ledger_entries: [e('M', 99999, false), e('Purchase Account', 99999, true)] }),
    ]
    const r = calculateExpenseBreakdown(vouchers, ledgers.map((l) => ({ ...l, current_balance: 999999 })), now)
    assert.equal(r.total, 12000)
    assert.deepEqual(r.categories.map((c) => c.name), ['Rent', 'Transport'])
    assert.equal(r.previousTotal, 15000)
    assert.equal(r.changePct, -20)
  })

  it('supports last month expense breakdown', () => {
    const vouchers = [
      pay('2026-10-05', 'Rent', 10000),
      pay('2026-09-05', 'Rent', 8000),
      pay('2026-09-12', 'Transport', 5000),
    ]
    const r = calculateExpenseBreakdown(vouchers, ledgers, now, { period: 'lastMonth' })
    assert.equal(r.total, 13000)
    assert.deepEqual(r.categories.map((c) => c.name), ['Rent', 'Transport'])
  })

  it('reports no comparison instead of a made-up percentage when last month is empty', () => {
    const r = calculateExpenseBreakdown([pay('2026-10-05', 'Rent', 100)], ledgers, now)
    assert.equal(r.changePct, null)
  })
})

describe('debtor ageing', () => {
  const party = (name, current_balance) => ({ type: 'debtor', name, current_balance })
  const sale = (date, party_name, due_amount, n = '1') => tally({
    voucher_type: 'sales', date, party_name, due_amount, voucher_no: n,
  })

  it('ages the balance by real invoice dates (newest invoices are the unpaid ones)', () => {
    // Customer owes 15,000. Three invoices in the last 60 days:
    // 5k (10 days ago: 0–30d), 5k (40 days ago: 31–60d), 10k (55 days ago: 31–60d).
    // The unpaid 15,000 is: 5k in 0–30d, 10k in 31–60d. Oldest paid 5k dropped.
    const vouchers = [
      sale('2026-10-20', 'Ravi', 5000, '3'),
      sale('2026-09-20', 'Ravi', 5000, '2'),
      sale('2026-09-05', 'Ravi', 10000, '1'),
    ]
    const r = computeDebtorAging([party('Ravi', 15000)], vouchers, now)
    const ravi = r.byParty.get('Ravi')
    assert.equal(ravi.bucket, '31–60d')
    assert.equal(ravi.buckets['0–30d'], 5000)
    assert.equal(ravi.buckets['31–60d'], 10000)
    assert.equal(ravi.buckets['60d+'], 0)
  })

  it('balance not explained by any invoice is an old opening balance → 60d+', () => {
    const r = computeDebtorAging([party('Old', 5000)], [], now)
    assert.equal(r.byParty.get('Old').bucket, '60d+')
    assert.equal(r.byParty.get('Old').buckets['60d+'], 5000)
  })

  it('customers with an advance (negative balance) are not counted as owing', () => {
    const r = computeDebtorAging([party('Prepaid', -2000)], [], now)
    assert.equal(r.totals['0–30d'], 0)
    assert.equal(r.totals['31–60d'], 0)
    assert.equal(r.totals['60d+'], 0)
  })
})

describe("profit from Tally's own Profit & Loss", () => {
  const row = (extra) => ({ company: 'Co', period_start: '2026-10-01', period_end: '2026-10-30', sales: 100000, direct_income: 0, cogs: 80000,
    gross_profit: 20000, indirect_expenses: 5000, indirect_income: 0, net_profit: 15000, fetched_at: '2026-10-30T10:00:00Z', ...extra })
  const sale = tally({ voucher_type: 'sales', date: '2026-10-10', amount: 100000, party_name: 'A', items: [{ name: 'Pen', qty: 1, rate: 100000, amount: 100000 }],
    ledger_entries: [e('A', 100000, true), e('Sales Account', 100000, false)] })

  it('uses Tally\'s cost of sales and net profit as they are, with no recalculation', () => {
    const r = calculateDashboardMetrics([sale], ledgers, now, { pnl: [row()] })
    assert.equal(r.operatingResultMonth, 15000)
    assert.deepEqual([r.operatingResultDetail.month.sales, r.operatingResultDetail.month.cost, r.operatingResultDetail.month.expenses], [100000, 80000, 5000])
    assert.equal(r.operatingResultDetail.month.source, 'tally')
    assert.equal(r.operatingResultBasis.month, "Tally's Profit & Loss")
    assert.equal(r.operatingResultApprox.month, false)
  })

  it('reports a loss as a loss', () => {
    const r = calculateDashboardMetrics([sale], ledgers, now, { pnl: [row({ net_profit: -2500, gross_profit: 2500 })] })
    assert.equal(r.operatingResultMonth, -2500)
  })

  it('flags when the app\'s vouchers do not agree with Tally\'s sales (duplicates or gaps)', () => {
    const r = calculateDashboardMetrics([sale, { ...sale, voucher_no: 'dup' }], ledgers, now, { pnl: [row()] })
    assert.equal(r.operatingResultMonth, 15000)             // still Tally's number
    assert.equal(r.operatingResultApprox.month, true)
    assert.match(r.operatingResultNote.month, /2,00,000.*Tally shows ₹1,00,000/)
  })

  it('ignores a month-to-date row that is more than a day old and falls back to the voucher estimate', () => {
    const stale = row({ fetched_at: '2026-10-27T10:00:00Z' })
    const r = calculateDashboardMetrics([sale], ledgers, new Date('2026-10-30T12:00:00Z'), { pnl: [stale], materials: [{ name: 'Pen', current_qty: 1, current_value: 80000 }] })
    assert.equal(r.operatingResultDetail.month.source, undefined)
    assert.equal(r.operatingResultMonth, 100000 - 80000)
  })

  it('a closed month (last month) never goes stale', () => {
    const lastMonth = row({ period_start: '2026-09-01', period_end: '2026-09-30', fetched_at: '2026-10-01T00:00:00Z', net_profit: 777 })
    assert.equal(calculateDashboardMetrics([], ledgers, now, { pnl: [lastMonth] }).operatingResultPrevMonth, 777)
  })

  it('picks the newest figures when a period was fetched more than once', () => {
    const r = calculateDashboardMetrics([sale], ledgers, now, { pnl: [row({ net_profit: 1, fetched_at: '2026-10-30T08:00:00Z' }), row({ net_profit: 2, fetched_at: '2026-10-30T11:00:00Z' })] })
    assert.equal(r.operatingResultMonth, 2)
  })
})
