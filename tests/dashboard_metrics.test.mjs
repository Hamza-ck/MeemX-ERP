import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calculateDashboardMetrics, calculateExpenseMetrics, calculateSalesMetrics } from '../src/lib/dashboardMetrics.js'

describe('calculateSalesMetrics', () => {
  const now = new Date(2026, 9, 28, 12)

  it('uses local calendar boundaries and the last seven days', () => {
    const result = calculateSalesMetrics([
      { voucher_type: 'sales', date: '2026-10-22', amount: 10 },
      { voucher_type: 'sales', date: '2026-10-28', amount: 20 },
      { voucher_type: 'sales', date: '2026-10-21', amount: 100 },
      { voucher_type: 'sales', date: '2026-09-30', amount: 200 },
      { voucher_type: 'payment', date: '2026-10-28', amount: 500 },
    ], now)

    assert.equal(result.salesToday, 20)
    assert.equal(result.salesWeek, 30)
    assert.equal(result.salesMonth, 130)
    assert.equal(result.sales7DaysTotal, 30)
    assert.equal(result.sales7Days.length, 7)
    assert.equal(result.sales7Days[0].date, '2026-10-22')
    assert.equal(result.sales7Days[6].date, '2026-10-28')
  })

  it('keeps a zero-sales month at zero instead of falling back to all-time sales', () => {
    const result = calculateSalesMetrics([
      { voucher_type: 'sales', date: '2026-09-30', amount: 200 },
    ], now)

    assert.equal(result.salesMonth, 0)
    assert.equal(result.salesToday, 0)
    assert.equal(result.salesWeek, 0)
  })

  it('counts dated expense payments but excludes supplier payments and ledger balances', () => {
    const ledgers = [{ name: 'Transport', category: 'expense', current_balance: 9999 }]
    const vouchers = [
      { voucher_type: 'payment', party_name: 'Transport', date: '2026-10-28', amount: 50 },
      { voucher_type: 'payment', party_name: 'Transport', date: '2026-10-20', amount: 70 },
      { voucher_type: 'payment', party_name: 'Supplier A', date: '2026-10-28', amount: 500 },
    ]
    assert.deepEqual(calculateExpenseMetrics(vouchers, ledgers, now), { today: 50, week: 50, month: 120 })
  })

  it('calculates the operating result only when every sale has recorded item costs', () => {
    const result = calculateDashboardMetrics([
      { voucher_type: 'sales', date: '2026-10-28', amount: 100, items: [{ qty: 5, cost_rate: 6 }] },
      { voucher_type: 'payment', date: '2026-10-28', amount: 10, party_name: 'Transport' },
    ], [{ name: 'Transport', group: 'Indirect Expenses' }], now)

    assert.equal(result.salesToday, 100)
    assert.equal(result.expensesToday, 10)
    assert.equal(result.operatingResultToday, 60)
    assert.equal(result.operatingResultWeek, 60)
  })

  it('marks the operating result unavailable when a sale has no item cost details', () => {
    const result = calculateDashboardMetrics([
      { voucher_type: 'sales', date: '2026-10-28', amount: 100, items: [{ qty: 2 }] },
    ], [], now)

    assert.equal(result.salesToday, 100)
    assert.equal(result.operatingResultToday, null)
  })
})
