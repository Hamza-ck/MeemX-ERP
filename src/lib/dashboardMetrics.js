import { tallyLedgerCategory } from './tallyLedgerCategory'

const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

/** Aggregate dashboard periods and chart points in one pass through voucher history. */
export function calculateDashboardMetrics(vouchers, ledgers, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayKey = dateKey(today)
  const weekStartKey = dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6))
  const monthStartKey = dateKey(new Date(today.getFullYear(), today.getMonth(), 1))
  const salesByDate = new Map()
  const nonTallySalesByDate = new Map()
  const expensesByDate = new Map()
  const legacyExpensesByDate = new Map()
  const costByDate = new Map()
  const accountingResultByDate = new Map()
  const salesVoucherCountByDate = new Map()
  const incompleteCostDates = new Set()
  const ledgersByName = new Map(ledgers
    .filter((ledger) => ledger.name)
    .map((ledger) => [ledger.name.trim().toLowerCase(), ledger]))
  const categoryOf = (ledger) => {
    const fromGroup = tallyLedgerCategory(ledger?.group)
    return !ledger?.category || (ledger.category === 'asset' && fromGroup !== 'asset')
      ? fromGroup
      : ledger.category
  }
  const expenseNames = new Set(ledgers
    .filter((ledger) => categoryOf(ledger) === 'expense')
    .map((ledger) => ledger.name?.trim().toLowerCase())
    .filter(Boolean))
  const tallyAccountingDates = new Set()

  for (const voucher of vouchers) {
    const date = (voucher.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const amount = Number(voucher.amount) || 0
    const hasTallyPostings = voucher.source_system === 'tally' && Array.isArray(voucher.ledger_entries)

    if (hasTallyPostings) {
      if (voucher.ledger_entries.length === 0) {
        incompleteCostDates.add(date)
      } else {
        let result = 0
        for (const entry of voucher.ledger_entries) {
          const entryName = String(entry.ledger_name || '').trim().toLowerCase()
          const ledger = ledgersByName.get(entryName)
          const category = ledger ? categoryOf(ledger) : ''
          const entryAmount = Math.abs(Number(entry.amount) || 0)
          const isDebit = Boolean(entry.is_debit)
          if (!ledger && entryName && entryName !== (voucher.party_name || '').trim().toLowerCase()) {
            incompleteCostDates.add(date)
          }
          if (category === 'expense') {
            const expense = isDebit ? entryAmount : -entryAmount
            expensesByDate.set(date, (expensesByDate.get(date) || 0) + expense)
            result -= expense
          } else if (category === 'income') {
            result += isDebit ? -entryAmount : entryAmount
          }
        }
        accountingResultByDate.set(date, (accountingResultByDate.get(date) || 0) + result)
        tallyAccountingDates.add(date)
      }
    }

    if (voucher.voucher_type === 'sales') {
      salesByDate.set(date, (salesByDate.get(date) || 0) + amount)
      salesVoucherCountByDate.set(date, (salesVoucherCountByDate.get(date) || 0) + 1)

      if (hasTallyPostings) continue
      nonTallySalesByDate.set(date, (nonTallySalesByDate.get(date) || 0) + amount)

      if (!Array.isArray(voucher.items) || voucher.items.length === 0) {
        incompleteCostDates.add(date)
        continue
      }

      let cost = 0
      let costIsComplete = true
      for (const item of voucher.items) {
        const rawRate = item.cost_rate
        const quantity = Number(item.qty)
        const rate = Number(rawRate)
        if (rawRate === undefined || rawRate === null || rawRate === '' || !Number.isFinite(quantity) || !Number.isFinite(rate)) {
          costIsComplete = false
          break
        }
        cost += quantity * rate
      }
      if (costIsComplete) costByDate.set(date, (costByDate.get(date) || 0) + cost)
      else incompleteCostDates.add(date)
    } else if (!hasTallyPostings && (
      voucher.voucher_type === 'payment' &&
      expenseNames.has((voucher.party_name || '').trim().toLowerCase())
    )) {
      expensesByDate.set(date, (expensesByDate.get(date) || 0) + amount)
      legacyExpensesByDate.set(date, (legacyExpensesByDate.get(date) || 0) + amount)
    }
  }

  const totals = { today: 0, week: 0, month: 0 }
  const expenseTotals = { today: 0, week: 0, month: 0 }
  const operatingResults = { today: null, week: null, month: null }
  const completeness = { today: true, week: true, month: true }

  for (const [date, amount] of salesByDate) {
    if (date === todayKey) totals.today += amount
    if (date >= weekStartKey && date <= todayKey) totals.week += amount
    if (date >= monthStartKey && date <= todayKey) totals.month += amount
  }
  for (const [date, amount] of expensesByDate) {
    if (date === todayKey) expenseTotals.today += amount
    if (date >= weekStartKey && date <= todayKey) expenseTotals.week += amount
    if (date >= monthStartKey && date <= todayKey) expenseTotals.month += amount
  }

  for (const date of incompleteCostDates) {
    if (date === todayKey) completeness.today = false
    if (date >= weekStartKey && date <= todayKey) completeness.week = false
    if (date >= monthStartKey && date <= todayKey) completeness.month = false
  }

  const hasAccountingActivity = {
    today: tallyAccountingDates.has(todayKey) || (salesVoucherCountByDate.get(todayKey) || 0) > 0 || legacyExpensesByDate.has(todayKey),
    week: [...new Set([...tallyAccountingDates, ...salesVoucherCountByDate.keys(), ...legacyExpensesByDate.keys()])].some((date) => date >= weekStartKey && date <= todayKey),
    month: [...new Set([...tallyAccountingDates, ...salesVoucherCountByDate.keys(), ...legacyExpensesByDate.keys()])].some((date) => date >= monthStartKey && date <= todayKey),
  }
  const salesPeriods = { today: totals.today, week: totals.week, month: totals.month }
  const starts = { today: todayKey, week: weekStartKey, month: monthStartKey }
  const tallyAccountingInPeriod = Object.fromEntries(['today', 'week', 'month'].map((period) => [
    period,
    [...tallyAccountingDates].some((date) => date >= starts[period] && date <= todayKey),
  ]))

  for (const period of ['today', 'week', 'month']) {
    if (!hasAccountingActivity[period] || !completeness[period]) continue
    let cost = 0
    let ledgerResult = 0
    let legacyExpenses = 0
    for (const [date, amount] of costByDate) {
      if (date >= starts[period] && date <= todayKey) cost += amount
    }
    for (const [date, amount] of accountingResultByDate) {
      if (date >= starts[period] && date <= todayKey) ledgerResult += amount
    }
    for (const [date, amount] of legacyExpensesByDate) {
      if (date >= starts[period] && date <= todayKey) legacyExpenses += amount
    }
    let nonTallySales = 0
    for (const [date, amount] of nonTallySalesByDate) {
      if (date >= starts[period] && date <= todayKey) nonTallySales += amount
    }
    operatingResults[period] = ledgerResult + nonTallySales - cost - legacyExpenses
  }

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const sales7Days = []
  let sales7DaysTotal = 0
  let maxDaySale = 0
  for (let i = 6; i >= 0; i--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
    const key = dateKey(day)
    const amount = salesByDate.get(key) || 0
    maxDaySale = Math.max(maxDaySale, amount)
    sales7DaysTotal += amount
    sales7Days.push({ day: dayNames[day.getDay()], date: key, amount, isPeak: false })
  }
  if (maxDaySale > 0) {
    for (const day of sales7Days) day.isPeak = day.amount === maxDaySale
  }

  return {
    salesToday: totals.today,
    salesWeek: totals.week,
    salesMonth: totals.month,
    expensesToday: expenseTotals.today,
    expensesWeek: expenseTotals.week,
    expensesMonth: expenseTotals.month,
    operatingResultToday: operatingResults.today,
    operatingResultWeek: operatingResults.week,
    operatingResultMonth: operatingResults.month,
    operatingResultBasis: Object.fromEntries(['today', 'week', 'month'].map((period) => [
      period,
      tallyAccountingInPeriod[period] ? 'Based on Tally accounts' : 'Sales less item costs & expenses',
    ])),
    sales7Days,
    sales7DaysTotal,
  }
}

export function calculateSalesMetrics(vouchers, now = new Date()) {
  const metrics = calculateDashboardMetrics(vouchers, [], now)
  return {
    salesToday: metrics.salesToday,
    salesWeek: metrics.salesWeek,
    salesMonth: metrics.salesMonth,
    sales7Days: metrics.sales7Days,
    sales7DaysTotal: metrics.sales7DaysTotal,
  }
}

export function calculateExpenseMetrics(vouchers, ledgers, now = new Date()) {
  const metrics = calculateDashboardMetrics(vouchers, ledgers, now)
  return {
    today: metrics.expensesToday,
    week: metrics.expensesWeek,
    month: metrics.expensesMonth,
  }
}
