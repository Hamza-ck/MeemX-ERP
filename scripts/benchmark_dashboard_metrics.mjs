import { performance } from 'node:perf_hooks'
import { calculateDashboardMetrics } from '../src/lib/dashboardMetrics.js'

const now = new Date(2026, 9, 28, 12)
const voucherCount = Number(process.env.BENCHMARK_VOUCHERS) || 100_000
const vouchers = Array.from({ length: voucherCount }, (_, index) => {
  const dayOffset = index % 365
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOffset)
  const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return {
    voucher_type: index % 3 === 0 ? 'payment' : 'sales',
    date: key,
    amount: 100 + index % 900,
    items: [{ qty: 1, cost_rate: 50 }],
  }
})

const dates = Array.from({ length: 7 }, (_, index) => {
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + index)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
})

// Reproduces the previous chart path: build the sales list, then rescan it once
// for every day in the seven-day chart.
function repeatedChartScan() {
  const sales = vouchers.filter((voucher) => voucher.voucher_type === 'sales')
  return dates.map((date) => sales
    .filter((voucher) => voucher.date === date)
    .reduce((sum, voucher) => sum + (Number(voucher.amount) || 0), 0))
}

function onePassChartScan() {
  const totalsByDate = new Map()
  for (const voucher of vouchers) {
    if (voucher.voucher_type !== 'sales') continue
    totalsByDate.set(voucher.date, (totalsByDate.get(voucher.date) || 0) + (Number(voucher.amount) || 0))
  }
  return dates.map((date) => totalsByDate.get(date) || 0)
}

function medianDuration(run) {
  run()
  run()
  const samples = Array.from({ length: 9 }, () => {
    const start = performance.now()
    run()
    return performance.now() - start
  }).sort((a, b) => a - b)
  return Number(samples[Math.floor(samples.length / 2)].toFixed(2))
}

const baselineMs = medianDuration(repeatedChartScan)
const onePassMs = medianDuration(onePassChartScan)
const expected = repeatedChartScan()
const actual = onePassChartScan()
const productionTotals = calculateDashboardMetrics(vouchers, [], now).sales7Days.map((day) => day.amount)
if (JSON.stringify(expected) !== JSON.stringify(actual) || JSON.stringify(expected) !== JSON.stringify(productionTotals)) {
  throw new Error('Benchmark paths produced different seven-day sales totals.')
}

process.stdout.write(`${JSON.stringify({
  runtime: process.version,
  voucherCount,
  warmupRuns: 2,
  measuredRuns: 9,
  statistic: 'median',
  repeatedSevenDayScanMs: baselineMs,
  onePassChartAggregationMs: onePassMs,
  sevenDayTotalsMatch: true,
}, null, 2)}\n`)
