import { tallyLedgerCategory, isPurchaseGroup } from './tallyLedgerCategory.js'

const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const lc = (value) => String(value || '').trim().toLowerCase()
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100

/** Resolve a ledger's category even when the stored one is the 'asset' default. */
function categoryOf(ledger) {
  const fromGroup = tallyLedgerCategory(ledger?.primary_group || ledger?.group)
  return !ledger?.category || (ledger.category === 'asset' && fromGroup !== 'asset') ? fromGroup : ledger.category
}

function buildContext(ledgers = [], materials = [], parties = []) {
  const ledgersByName = new Map(ledgers.filter((l) => l.name).map((l) => [lc(l.name), l]))
  const partyNames = new Set(parties.filter((p) => p.name).map((p) => lc(p.name)))
  // Tally's own average cost (closing value ÷ closing qty) beats a stored purchase rate,
  // which for Tally items is only the last closing rate.
  const costByItem = new Map()
  for (const m of materials) {
    const qty = Number(m.current_qty)
    const value = m.current_value == null ? NaN : Number(m.current_value)
    const average = qty > 0 && Number.isFinite(value) && value > 0 ? value / qty : 0
    const cost = average || Number(m.purchase_rate) || 0
    if (cost > 0) {
      if (m.name) costByItem.set(lc(m.name), cost)
      if (m.sku) costByItem.set(lc(m.sku), cost)
    }
  }
  return { ledgersByName, partyNames, costByItem }
}

/**
 * Signed natural postings of a Tally voucher: income (credit − debit) and expense
 * (debit − credit), split into purchases (cost of goods) and operating expenses.
 */
function tallyPostings(voucher, ctx) {
  const party = lc(voucher.party_name)
  const out = { income: 0, opex: 0, purchases: 0, opexByLedger: new Map(), unknown: false }
  for (const entry of voucher.ledger_entries) {
    const name = lc(entry.ledger_name)
    const ledger = ctx.ledgersByName.get(name)
    const amount = Math.abs(Number(entry.amount) || 0)
    const signed = entry.is_debit ? amount : -amount          // debit positive
    if (!ledger) {
      if (name && name !== party && !ctx.partyNames.has(name)) out.unknown = true
      continue
    }
    const category = categoryOf(ledger)
    if (category === 'income') out.income -= signed
    else if (category === 'expense') {
      if (isPurchaseGroup(ledger)) out.purchases += signed
      else {
        out.opex += signed
        out.opexByLedger.set(ledger.name, (out.opexByLedger.get(ledger.name) || 0) + signed)
      }
    }
  }
  return out
}

const add = (map, key, amount) => map.set(key, (map.get(key) || 0) + amount)
const inRange = (date, start, end) => date >= start && date <= end

/** Aggregate dashboard periods and chart points in one pass through voucher history. */
export function calculateDashboardMetrics(vouchers, ledgers, now = new Date(), { materials = [], parties = [] } = {}) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayKey = dateKey(today)
  const starts = {
    today: todayKey,
    week: dateKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)),
    month: dateKey(new Date(today.getFullYear(), today.getMonth(), 1)),
  }
  const prevMonthDate = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const prevMonthEndDate = new Date(today.getFullYear(), today.getMonth(), 0)
  const prevMonthStartKey = dateKey(prevMonthDate)
  const prevMonthEndKey = dateKey(prevMonthEndDate)
  const currentMonthName = today.toLocaleDateString('en-IN', { month: 'short' })
  const currentMonthFullName = today.toLocaleDateString('en-IN', { month: 'long' })
  const prevMonthName = prevMonthDate.toLocaleDateString('en-IN', { month: 'short' })
  const prevMonthFullName = prevMonthDate.toLocaleDateString('en-IN', { month: 'long' })
  const ctx = buildContext(ledgers, materials, parties)
  const expenseNames = new Set(ledgers.filter((l) => categoryOf(l) === 'expense' && !isPurchaseGroup(l)).map((l) => lc(l.name)).filter(Boolean))

  const salesByDate = new Map()          // invoice totals net of credit notes
  const salesCountByDate = new Map()
  const tallyIncomeByDate = new Map()
  const tallyOpexByDate = new Map()
  const tallyPurchasesByDate = new Map()
  const tallyItemCostByDate = new Map()
  const legacyCostByDate = new Map()
  const legacySalesByDate = new Map()
  const legacyExpensesByDate = new Map()
  const incompleteDates = new Set()      // result cannot be trusted for these days
  const missingItemCostDates = new Set() // only matters if the item-cost basis is used
  const tallyItemSaleDates = new Set()
  const tallyNoItemSaleDates = new Set()
  const tallyActivityDates = new Set()

  for (const voucher of vouchers) {
    if (voucher.deleted_at) continue
    const date = (voucher.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const amount = Number(voucher.amount) || 0
    const type = voucher.voucher_type
    const isTally = voucher.source_system === 'tally' && Array.isArray(voucher.ledger_entries)
    const hasItems = Array.isArray(voucher.items) && voucher.items.length > 0

    if (type === 'sales') {
      add(salesByDate, date, amount)
      add(salesCountByDate, date, 1)
    } else if (type === 'credit_note') {
      add(salesByDate, date, -amount)   // sales returns reduce sales
    }

    if (isTally) {
      if (voucher.ledger_entries.length === 0) {
        incompleteDates.add(date)
      } else {
        const posting = tallyPostings(voucher, ctx)
        if (posting.unknown) incompleteDates.add(date)
        add(tallyIncomeByDate, date, posting.income)
        add(tallyOpexByDate, date, posting.opex)
        add(tallyPurchasesByDate, date, posting.purchases)
        tallyActivityDates.add(date)
      }
      if (type === 'sales' || type === 'credit_note') {
        if (!hasItems) {
          tallyNoItemSaleDates.add(date)
        } else {
          tallyItemSaleDates.add(date)
          const direction = type === 'credit_note' ? -1 : 1
          for (const item of voucher.items) {
            const cost = ctx.costByItem.get(lc(item.name)) ?? ctx.costByItem.get(lc(item.sku))
            const qty = Number(item.qty)
            if (!cost || !Number.isFinite(qty)) { missingItemCostDates.add(date); continue }
            add(tallyItemCostByDate, date, direction * qty * cost)
          }
        }
      }
      continue
    }

    // Locally keyed vouchers (not from Tally): sale items carry their own cost_rate.
    if (type === 'sales') {
      add(legacySalesByDate, date, amount)
      if (!hasItems) { incompleteDates.add(date); continue }
      let cost = 0
      let complete = true
      for (const item of voucher.items) {
        const rate = Number(item.cost_rate)
        const qty = Number(item.qty)
        if (item.cost_rate === undefined || item.cost_rate === null || item.cost_rate === '' || !Number.isFinite(qty) || !Number.isFinite(rate)) { complete = false; break }
        cost += qty * rate
      }
      if (complete) add(legacyCostByDate, date, cost)
      else incompleteDates.add(date)
    } else if (type === 'payment' && expenseNames.has(lc(voucher.party_name))) {
      add(legacyExpensesByDate, date, amount)
    }
  }

  const sumPeriod = (map, period) => {
    let total = 0
    if (period === 'lastMonth') {
      for (const [date, amount] of map) if (inRange(date, prevMonthStartKey, prevMonthEndKey)) total += amount
      return total
    }
    for (const [date, amount] of map) if (inRange(date, starts[period], todayKey)) total += amount
    return total
  }
  const anyInPeriod = (dates, period) => {
    if (period === 'lastMonth') {
      return [...dates].some((date) => inRange(date, prevMonthStartKey, prevMonthEndKey))
    }
    return [...dates].some((date) => inRange(date, starts[period], todayKey))
  }

  const periods = ['today', 'week', 'month', 'lastMonth']
  const sales = {}, expenses = {}, results = {}, basis = {}
  for (const period of periods) {
    sales[period] = sumPeriod(salesByDate, period)
    expenses[period] = sumPeriod(tallyOpexByDate, period) + sumPeriod(legacyExpensesByDate, period)

    const hasTally = anyInPeriod(tallyActivityDates, period)
    const hasActivity = hasTally || anyInPeriod(new Set(salesCountByDate.keys()), period) || anyInPeriod(new Set(legacyExpensesByDate.keys()), period)
    const useItemCost = anyInPeriod(tallyItemSaleDates, period)
    const mixed = useItemCost && anyInPeriod(tallyNoItemSaleDates, period)
    const costMissing = useItemCost && anyInPeriod(missingItemCostDates, period)
    basis[period] = hasTally
      ? (useItemCost ? 'Tally net sales − item cost − expenses'
        : anyInPeriod(tallyNoItemSaleDates, period) ? 'Tally net sales − purchases − expenses (no item data)'
        : 'Tally accounts')
      : 'Sales less item costs & expenses'

    if (!hasActivity || anyInPeriod(incompleteDates, period) || mixed || costMissing) {
      results[period] = null
      continue
    }
    const cogs = useItemCost ? sumPeriod(tallyItemCostByDate, period)
      : anyInPeriod(tallyNoItemSaleDates, period) ? sumPeriod(tallyPurchasesByDate, period) : 0
    const tallyNet = sumPeriod(tallyIncomeByDate, period) - cogs - sumPeriod(tallyOpexByDate, period)
    results[period] = round2(tallyNet + sumPeriod(legacySalesByDate, period) - sumPeriod(legacyCostByDate, period) - sumPeriod(legacyExpensesByDate, period))
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
  if (maxDaySale > 0) for (const day of sales7Days) day.isPeak = day.amount === maxDaySale

  return {
    salesToday: sales.today, salesWeek: sales.week, salesMonth: sales.month, salesPrevMonth: sales.lastMonth,
    expensesToday: expenses.today, expensesWeek: expenses.week, expensesMonth: expenses.month, expensesPrevMonth: expenses.lastMonth,
    operatingResultToday: results.today, operatingResultWeek: results.week, operatingResultMonth: results.month, operatingResultPrevMonth: results.lastMonth,
    operatingResultBasis: basis,
    sales7Days, sales7DaysTotal,
    currentMonthName, currentMonthFullName, prevMonthName, prevMonthFullName,
  }
}

export function calculateSalesMetrics(vouchers, now = new Date()) {
  const metrics = calculateDashboardMetrics(vouchers, [], now)
  return {
    salesToday: metrics.salesToday, salesWeek: metrics.salesWeek, salesMonth: metrics.salesMonth, salesPrevMonth: metrics.salesPrevMonth,
    sales7Days: metrics.sales7Days, sales7DaysTotal: metrics.sales7DaysTotal,
    currentMonthName: metrics.currentMonthName, currentMonthFullName: metrics.currentMonthFullName,
    prevMonthName: metrics.prevMonthName, prevMonthFullName: metrics.prevMonthFullName,
  }
}

export function calculateExpenseMetrics(vouchers, ledgers, now = new Date()) {
  const metrics = calculateDashboardMetrics(vouchers, ledgers, now)
  return { today: metrics.expensesToday, week: metrics.expensesWeek, month: metrics.expensesMonth }
}

/**
 * Month-to-date operating expenses by ledger, compared with the SAME number of days of
 * the previous month (a month-to-date total against a full month is not comparable).
 * Purchase accounts are cost of goods and are excluded. Cumulative ledger balances are
 * never used — they are year-to-date, not this month.
 */
export function calculateExpenseBreakdown(vouchers, ledgers, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monthStart = dateKey(new Date(today.getFullYear(), today.getMonth(), 1))
  const todayKey = dateKey(today)
  const prevStartDate = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const prevDaysInMonth = new Date(prevStartDate.getFullYear(), prevStartDate.getMonth() + 1, 0).getDate()
  const prevEndDate = new Date(prevStartDate.getFullYear(), prevStartDate.getMonth(), Math.min(today.getDate(), prevDaysInMonth))
  const prevStart = dateKey(prevStartDate)
  const prevEnd = dateKey(prevEndDate)

  const ctx = buildContext(ledgers)
  const expenseNames = new Map(ledgers.filter((l) => categoryOf(l) === 'expense' && !isPurchaseGroup(l)).map((l) => [lc(l.name), l.name]))
  const current = new Map()
  let previousTotal = 0
  let currentTotal = 0

  const record = (date, name, amount) => {
    if (inRange(date, monthStart, todayKey)) { add(current, name, amount); currentTotal += amount }
    else if (inRange(date, prevStart, prevEnd)) previousTotal += amount
  }

  for (const voucher of vouchers) {
    if (voucher.deleted_at) continue
    const date = (voucher.date || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    if (voucher.source_system === 'tally' && Array.isArray(voucher.ledger_entries) && voucher.ledger_entries.length) {
      for (const [name, amount] of tallyPostings(voucher, ctx).opexByLedger) record(date, name, amount)
    } else if (voucher.voucher_type === 'payment' && expenseNames.has(lc(voucher.party_name))) {
      record(date, expenseNames.get(lc(voucher.party_name)), Number(voucher.amount) || 0)
    }
  }

  const categories = [...current.entries()]
    .map(([name, amount]) => ({ name, amount: round2(amount) }))
    .filter((c) => Math.abs(c.amount) >= 0.005)
    .sort((a, b) => b.amount - a.amount)
  const changePct = previousTotal > 0 ? Math.round(((currentTotal - previousTotal) / previousTotal) * 1000) / 10 : null
  return { total: round2(currentTotal), previousTotal: round2(previousTotal), changePct, categories }
}

const daysBetween = (fromKey, to) => {
  const [y, m, d] = fromKey.split('-').map(Number)
  return Math.floor((Date.UTC(to.getFullYear(), to.getMonth(), to.getDate()) - Date.UTC(y, m - 1, d)) / 86_400_000)
}
const bucketFor = (days) => (days > 60 ? '60d+' : days > 30 ? '31–60d' : '0–30d')

/**
 * Real receivable ageing. A party's closing balance is made of its most recent unpaid
 * invoices (receipts settle the oldest first), so allocate the balance newest-first over
 * the party's credit invoices and age each slice by invoice date. Whatever is not covered
 * by a known invoice is an older opening balance → oldest bucket.
 *
 * Also returns the unpaid part of each invoice, so the Sales list can show Paid/Due from
 * the same source of truth instead of the invoice's frozen due_amount.
 */
export function computeDebtorAging(parties, vouchers, now = new Date()) {
  const invoicesByParty = new Map()
  for (const v of vouchers) {
    if (v.deleted_at || v.voucher_type !== 'sales' || !(Number(v.due_amount) > 0)) continue
    const key = lc(v.party_name)
    if (!invoicesByParty.has(key)) invoicesByParty.set(key, [])
    invoicesByParty.get(key).push(v)
  }

  const byParty = new Map()
  const outstandingByVoucher = new Map()
  const totals = { '0–30d': 0, '31–60d': 0, '60d+': 0 }

  for (const party of parties) {
    if (party.type !== 'debtor') continue
    const balance = round2(Number(party.current_balance) || 0)
    const buckets = { '0–30d': 0, '31–60d': 0, '60d+': 0 }
    let oldestDays = 0
    if (balance > 0) {
      let remaining = balance
      const invoices = (invoicesByParty.get(lc(party.name)) || [])
        .slice()
        .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.voucher_no).localeCompare(String(a.voucher_no)))
      for (const invoice of invoices) {
        if (remaining <= 0) break
        const portion = Math.min(remaining, Number(invoice.due_amount))
        const days = Math.max(0, daysBetween(String(invoice.date).slice(0, 10), now))
        buckets[bucketFor(days)] += portion
        outstandingByVoucher.set(invoice.id ?? invoice.voucher_no, round2(portion))
        oldestDays = Math.max(oldestDays, days)
        remaining = round2(remaining - portion)
      }
      if (remaining > 0) { buckets['60d+'] += remaining; oldestDays = Math.max(oldestDays, 61) }
      for (const key of Object.keys(buckets)) totals[key] += buckets[key]
    }
    const bucket = buckets['60d+'] > 0 ? '60d+' : buckets['31–60d'] > 0 ? '31–60d' : '0–30d'
    byParty.set(party.id ?? party.name, { balance, bucket, oldestDays, buckets })
  }

  return { byParty, outstandingByVoucher, totals }
}
