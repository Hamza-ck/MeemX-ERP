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
      // big stock purchase the same day: must NOT wipe out the day's profit
      tally({ voucher_type: 'purchase', date: '2026-10-30', amount: 50000, party_name: 'Mill',
        ledger_entries: [e('Mill', 50000, false), e('Purchase Account', 50000, true)] }),
      tally({ voucher_type: 'payment', date: '2026-10-30', amount: 1000, party_name: 'Rent',
        ledger_entries: [e('HDFC', 1000, false), e('Rent', 1000, true)] }),
    ]
    const materials = [{ name: 'Pen', current_qty: 400, current_value: 20000, purchase_rate: 1 }] // avg cost 50
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials })
    // 10,000 net sales (GST excluded) − 100×50 COGS − 1,000 rent = 4,000
    assert.equal(r.operatingResultToday, 4000)
    assert.equal(r.expensesToday, 1000)           // purchases are not "expenses"
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
    assert.equal(r.operatingResultToday, 600 - (10 * 50 - 4 * 50))   // 600 − 300
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

  it('declines (with a reason) only when there is nothing at all to base a cost on', () => {
    const vouchers = [tally({ voucher_type: 'sales', date: '2026-10-30', amount: 100, party_name: 'A', items: [{ name: 'Mystery', qty: 1 }],
      ledger_entries: [e('A', 100, true), e('Sales Account', 100, false)] })]
    const r = calculateDashboardMetrics(vouchers, ledgers, now)
    assert.equal(r.operatingResultToday, null)
    assert.match(r.operatingResultNote.today, /No item costs or purchases/)
  })

  it('one item without a stored cost no longer blanks the whole period', () => {
    const sale = (n, name, qty) => tally({ voucher_type: 'sales', date: '2026-10-30', amount: 1000, party_name: 'A', voucher_no: n, items: [{ name, qty }],
      ledger_entries: [e('A', 1000, true), e('Sales Account', 1000, false)] })
    // Pen cost 50 (known), Gadget has no stock value or rate anywhere
    const vouchers = [sale('1', 'Pen', 10), sale('2', 'Pen', 10), sale('3', 'Pen', 10), sale('4', 'Gadget', 1)]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials: [{ name: 'Pen', current_qty: 10, current_value: 500 }] })
    // known: 3 sales of 1000 with cost 500 each (50%); the 4th is estimated at the same margin
    assert.equal(r.operatingResultToday, 4000 - 2000)
    assert.equal(r.operatingResultApprox.today, true)
    assert.match(r.operatingResultNote.today, /75%/)
  })

  it('uses the last purchase rate for an item that is out of stock', () => {
    const vouchers = [
      tally({ voucher_type: 'purchase', date: '2026-10-01', amount: 400, party_name: 'M', items: [{ name: 'Pen', qty: 10, rate: 40 }],
        ledger_entries: [e('M', 400, false), e('Purchase Account', 400, true)] }),
      tally({ voucher_type: 'sales', date: '2026-10-30', amount: 1000, party_name: 'A', items: [{ name: 'Pen', qty: 10 }],
        ledger_entries: [e('A', 1000, true), e('Sales Account', 1000, false)] }),
    ]
    // closing stock is zero, so Tally gives no closing rate; the purchase rate (40) is used
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials: [{ name: 'Pen', current_qty: 0, current_value: 0, purchase_rate: 0 }] })
    assert.equal(r.operatingResultToday, 1000 - 400)
    assert.equal(r.operatingResultApprox.today, false)
  })

  it('vouchers without any postings are excluded and flagged, unless they are most of the sales', () => {
    const posted = tally({ voucher_type: 'sales', date: '2026-10-30', amount: 1000, party_name: 'A', items: [{ name: 'Pen', qty: 10 }],
      ledger_entries: [e('A', 1000, true), e('Sales Account', 1000, false)] })
    const bare = (amount) => tally({ voucher_type: 'sales', date: '2026-10-30', amount, party_name: 'B', ledger_entries: [] })
    const materials = [{ name: 'Pen', current_qty: 10, current_value: 500 }]
    const few = calculateDashboardMetrics([posted, bare(100)], ledgers, now, { materials })
    assert.equal(few.operatingResultToday, 500)
    assert.equal(few.operatingResultApprox.today, true)
    const most = calculateDashboardMetrics([posted, bare(5000)], ledgers, now, { materials })
    assert.equal(most.operatingResultToday, null)
    assert.match(most.operatingResultNote.today, /no ledger postings/)
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
