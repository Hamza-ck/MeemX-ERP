import { tallyLedgerCategory, isPurchaseGroup } from './tallyLedgerCategory.js'

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function formatLocalDateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function normalizeVoucherDateKey(rawDate) {
  if (!rawDate) return ''
  const text = String(rawDate).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return ''
  return formatLocalDateKey(parsed)
}

function buildMetricWindow(now = new Date()) {
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const today = formatLocalDateKey(todayDate)
  const monthPrefix = today.slice(0, 7)

  const sales7Days = []
  const sales7DaysByDate = new Map()
  for (let offset = 6; offset >= 0; offset--) {
    const dayDate = new Date(todayDate)
    dayDate.setDate(todayDate.getDate() - offset)
    const date = formatLocalDateKey(dayDate)
    const bucket = {
      day: DAY_NAMES[dayDate.getDay()],
      date,
      amount: 0,
    }
    sales7Days.push(bucket)
    sales7DaysByDate.set(date, bucket)
  }

  return {
    today,
    weekStart: sales7Days[0].date,
    monthPrefix,
    sales7Days,
    sales7DaysByDate,
  }
}

/**
 * Resolve the set of operating expense ledger names (excluding Purchase Accounts which represent COGS),
 * sales income ledger names, and purchase ledger names.
 */
function buildLedgerMaps(ledgers = []) {
  const expenseLedgers = new Map() // normalizedName -> displayName
  const purchaseLedgers = new Set()
  const salesLedgers = new Set()

  for (const ledger of ledgers || []) {
    if (ledger?.deleted_at) continue
    const rawName = String(ledger?.name || '').trim()
    if (!rawName) continue
    const key = rawName.toLowerCase()
    if (isPurchaseGroup(ledger)) {
      purchaseLedgers.add(key)
      continue
    }
    const category = ledger?.category || tallyLedgerCategory(ledger?.primary_group || ledger?.group)
    if (category === 'expense') {
      expenseLedgers.set(key, rawName)
    } else if (category === 'income') {
      salesLedgers.add(key)
    }
  }
  return { expenseLedgers, purchaseLedgers, salesLedgers }
}

function isDebitEntry(entry) {
  if (typeof entry?.is_debit === 'boolean') return entry.is_debit
  if (entry?.entry_type) return entry.entry_type === 'debit'
  return true
}

/**
 * Extract dated operating expense postings from a voucher.
 */
function extractVoucherExpensePostings(voucher, expenseLedgers) {
  if (voucher?.deleted_at) return []
  const vType = voucher?.voucher_type
  if (vType !== 'payment' && vType !== 'journal') return []

  const postings = []
  const entries = Array.isArray(voucher?.ledger_entries) ? voucher.ledger_entries : []

  if (entries.length > 0) {
    for (const entry of entries) {
      const key = String(entry?.ledger_name || '').trim().toLowerCase()
      if (!key || !expenseLedgers.has(key)) continue
      if (!isDebitEntry(entry)) continue
      const amt = Math.abs(Number(entry.amount) || 0)
      if (amt > 0) {
        postings.push({ name: expenseLedgers.get(key), amount: amt })
      }
    }
    if (postings.length > 0) return postings
  }

  if (vType === 'payment') {
    const partyKey = String(voucher?.party_name || '').trim().toLowerCase()
    if (partyKey && expenseLedgers.has(partyKey)) {
      const amt = Math.abs(Number(voucher?.amount) || 0)
      if (amt > 0) {
        postings.push({ name: expenseLedgers.get(partyKey), amount: amt })
      }
    }
  }

  return postings
}

function resolveMaterialUnitCost(material) {
  if (!material) return null
  const qty = Number(material.current_qty)
  const val = Number(material.current_value)
  if (Number.isFinite(qty) && qty > 0 && Number.isFinite(val) && val > 0) {
    return val / qty
  }
  const rate = Number(material.purchase_rate)
  if (Number.isFinite(rate) && rate > 0) return rate
  return null
}

function getSaleItemCost(voucher, materialCostByKey = new Map()) {
  if (!Array.isArray(voucher?.items) || voucher.items.length === 0) {
    return { hasItems: false, complete: false, cost: 0 }
  }

  let totalCost = 0
  for (const item of voucher.items) {
    const qty = Number(item?.qty)
    let costRate = Number(item?.cost_rate ?? item?.purchase_rate)
    if (!Number.isFinite(costRate) || costRate <= 0) {
      const skuKey = String(item?.sku || '').trim().toLowerCase()
      const nameKey = String(item?.name || '').trim().toLowerCase()
      if (skuKey && materialCostByKey.has(skuKey)) costRate = materialCostByKey.get(skuKey)
      else if (nameKey && materialCostByKey.has(nameKey)) costRate = materialCostByKey.get(nameKey)
    }
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(costRate) || costRate <= 0) {
      return { hasItems: true, complete: false, cost: 0 }
    }
    totalCost += qty * costRate
  }

  return { hasItems: true, complete: true, cost: totalCost }
}

function extractNetSalesFromEntries(voucher, salesLedgers) {
  const entries = Array.isArray(voucher?.ledger_entries) ? voucher.ledger_entries : []
  if (entries.length === 0 || salesLedgers.size === 0) return Math.abs(Number(voucher?.amount) || 0)
  const vType = voucher?.voucher_type
  let matched = 0
  for (const entry of entries) {
    const key = String(entry?.ledger_name || '').trim().toLowerCase()
    if (!key || !salesLedgers.has(key)) continue
    if (vType === 'sales' && !isDebitEntry(entry)) {
      matched += Math.abs(Number(entry.amount) || 0)
    } else if (vType === 'credit_note' && isDebitEntry(entry)) {
      matched += Math.abs(Number(entry.amount) || 0)
    }
  }
  return matched > 0 ? matched : Math.abs(Number(voucher?.amount) || 0)
}

/**
 * Period-based Dashboard Metrics
 */
export function calculateDashboardMetrics(vouchers = [], ledgers = [], now = new Date(), extra = {}) {
  const materials = Array.isArray(extra) ? extra : (extra?.materials || [])
  const {
    today,
    weekStart,
    monthPrefix,
    sales7Days,
    sales7DaysByDate,
  } = buildMetricWindow(now)

  const { expenseLedgers, purchaseLedgers, salesLedgers } = buildLedgerMaps(ledgers)
  const materialCostByKey = new Map()
  for (const m of materials || []) {
    if (m?.deleted_at) continue
    const unitCost = resolveMaterialUnitCost(m)
    if (unitCost != null && unitCost > 0) {
      if (m.sku) materialCostByKey.set(String(m.sku).trim().toLowerCase(), unitCost)
      if (m.name) materialCostByKey.set(String(m.name).trim().toLowerCase(), unitCost)
    }
  }

  let salesToday = 0
  let salesWeek = 0
  let salesMonth = 0
  let netSalesToday = 0
  let netSalesWeek = 0
  let netSalesMonth = 0
  let expensesToday = 0
  let expensesWeek = 0
  let expensesMonth = 0

  let itemCostToday = 0
  let itemCostWeek = 0
  let itemCostMonth = 0
  let purchasesToday = 0
  let purchasesWeek = 0
  let purchasesMonth = 0

  let hasSalesToday = false
  let hasSalesWeek = false
  let hasSalesMonth = false
  let hasItemsToday = false
  let hasItemsWeek = false
  let hasItemsMonth = false
  let completeCostToday = true
  let completeCostWeek = true
  let completeCostMonth = true

  for (const voucher of vouchers || []) {
    if (voucher?.deleted_at) continue
    const dateKey = normalizeVoucherDateKey(voucher?.date)
    if (!dateKey) continue
    const amount = Math.abs(Number(voucher?.amount) || 0)
    const isToday = dateKey === today
    const isWeek = dateKey >= weekStart && dateKey <= today
    const isMonth = dateKey.startsWith(monthPrefix) && dateKey <= today

    const vType = voucher?.voucher_type

    if (vType === 'sales' || vType === 'credit_note') {
      const sign = vType === 'credit_note' ? -1 : 1
      const signedGross = amount * sign
      const signedNet = extractNetSalesFromEntries(voucher, salesLedgers) * sign

      if (isToday) {
        hasSalesToday = true
        salesToday += signedGross
        netSalesToday += signedNet
      }
      if (isWeek) {
        hasSalesWeek = true
        salesWeek += signedGross
        netSalesWeek += signedNet
        const dayBucket = sales7DaysByDate.get(dateKey)
        if (dayBucket) dayBucket.amount += signedGross
      }
      if (isMonth) {
        hasSalesMonth = true
        salesMonth += signedGross
        netSalesMonth += signedNet
      }

      const itemCost = getSaleItemCost(voucher, materialCostByKey)
      if (isToday) {
        if (itemCost.hasItems) hasItemsToday = true
        if (itemCost.complete) itemCostToday += itemCost.cost * sign
        else if (vType === 'sales') completeCostToday = false
      }
      if (isWeek) {
        if (itemCost.hasItems) hasItemsWeek = true
        if (itemCost.complete) itemCostWeek += itemCost.cost * sign
        else if (vType === 'sales') completeCostWeek = false
      }
      if (isMonth) {
        if (itemCost.hasItems) hasItemsMonth = true
        if (itemCost.complete) itemCostMonth += itemCost.cost * sign
        else if (vType === 'sales') completeCostMonth = false
      }
    } else if (vType === 'purchase' || vType === 'debit_note') {
      const sign = vType === 'debit_note' ? -1 : 1
      if (isToday) purchasesToday += amount * sign
      if (isWeek) purchasesWeek += amount * sign
      if (isMonth) purchasesMonth += amount * sign
    } else {
      const entries = Array.isArray(voucher?.ledger_entries) ? voucher.ledger_entries : []
      for (const entry of entries) {
        const key = String(entry?.ledger_name || '').trim().toLowerCase()
        if (key && purchaseLedgers.has(key) && isDebitEntry(entry)) {
          const pAmt = Math.abs(Number(entry.amount) || 0)
          if (isToday) purchasesToday += pAmt
          if (isWeek) purchasesWeek += pAmt
          if (isMonth) purchasesMonth += pAmt
        }
      }
    }

    const expensePostings = extractVoucherExpensePostings(voucher, expenseLedgers)
    if (expensePostings.length > 0) {
      const expSum = expensePostings.reduce((s, p) => s + p.amount, 0)
      if (isToday) expensesToday += expSum
      if (isWeek) expensesWeek += expSum
      if (isMonth) expensesMonth += expSum
    }
  }

  const resolveOperatingResult = (hasSales, netSales, expenses, hasItems, completeItemCost, itemCost, purchases) => {
    if (!hasSales && expenses === 0 && purchases === 0) {
      return { value: 0, basis: 'Sales less item costs & expenses' }
    }
    if (completeItemCost && hasSales && hasItems) {
      return {
        value: netSales - itemCost - expenses,
        basis: 'Sales less item costs & expenses',
      }
    }
    if (!hasItems && purchases > 0) {
      return {
        value: netSales - purchases - expenses,
        basis: 'Sales less purchases & expenses',
      }
    }
    if (!hasSales && expenses > 0) {
      return {
        value: -expenses,
        basis: 'Recorded period expenses',
      }
    }
    return { value: null, basis: 'Profit details incomplete' }
  }

  const resToday = resolveOperatingResult(hasSalesToday, netSalesToday, expensesToday, hasItemsToday, completeCostToday, itemCostToday, purchasesToday)
  const resWeek = resolveOperatingResult(hasSalesWeek, netSalesWeek, expensesWeek, hasItemsWeek, completeCostWeek, itemCostWeek, purchasesWeek)
  const resMonth = resolveOperatingResult(hasSalesMonth, netSalesMonth, expensesMonth, hasItemsMonth, completeCostMonth, itemCostMonth, purchasesMonth)

  return {
    salesToday,
    salesWeek,
    salesMonth,
    expensesToday,
    expensesWeek,
    expensesMonth,
    operatingResultToday: resToday.value,
    operatingResultWeek: resWeek.value,
    operatingResultMonth: resMonth.value,
    operatingResultBasis: {
      today: resToday.basis,
      week: resWeek.basis,
      month: resMonth.basis,
    },
    sales7Days,
    sales7DaysTotal: salesWeek,
  }
}

export function calculateSalesMetrics(vouchers = [], now = new Date()) {
  const {
    salesToday,
    salesWeek,
    salesMonth,
    sales7Days,
    sales7DaysTotal,
  } = calculateDashboardMetrics(vouchers, [], now)

  return {
    salesToday,
    salesWeek,
    salesMonth,
    sales7Days,
    sales7DaysTotal,
  }
}

export function calculateExpenseMetrics(vouchers = [], ledgers = [], now = new Date()) {
  const {
    expensesToday,
    expensesWeek,
    expensesMonth,
  } = calculateDashboardMetrics(vouchers, ledgers, now)

  return {
    today: expensesToday,
    week: expensesWeek,
    month: expensesMonth,
  }
}

/**
 * Period-based Expense Breakdown & Equal-Span Prior-Month Comparison
 */
export function calculateExpenseBreakdown(vouchers = [], ledgers = [], now = new Date()) {
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const daySpan = todayDate.getDate()

  const currStart = formatLocalDateKey(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1))
  const currEnd = formatLocalDateKey(todayDate)

  const prevMonthStartDate = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1)
  const prevMonthDays = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0).getDate()
  const prevEndDay = Math.min(daySpan, prevMonthDays)
  const prevMonthEndDate = new Date(prevMonthStartDate.getFullYear(), prevMonthStartDate.getMonth(), prevEndDay)
  const prevStart = formatLocalDateKey(prevMonthStartDate)
  const prevEnd = formatLocalDateKey(prevMonthEndDate)

  const { expenseLedgers } = buildLedgerMaps(ledgers)
  const ledgerByName = new Map(
    (ledgers || []).map((l) => [String(l?.name || '').trim().toLowerCase(), l])
  )

  const categoryTotals = new Map()
  let totalThisMonth = 0
  let totalPrevPeriod = 0

  for (const voucher of vouchers || []) {
    if (voucher?.deleted_at) continue
    const dateKey = normalizeVoucherDateKey(voucher?.date)
    if (!dateKey) continue
    const postings = extractVoucherExpensePostings(voucher, expenseLedgers)
    if (postings.length === 0) continue

    const isCurrentMonth = dateKey >= currStart && dateKey <= currEnd
    const isPrevPeriod = dateKey >= prevStart && dateKey <= prevEnd

    for (const post of postings) {
      if (isCurrentMonth) {
        totalThisMonth += post.amount
        categoryTotals.set(post.name, (categoryTotals.get(post.name) || 0) + post.amount)
      } else if (isPrevPeriod) {
        totalPrevPeriod += post.amount
      }
    }
  }

  const categories = Array.from(categoryTotals.entries())
    .map(([name, amount]) => {
      const ledger = ledgerByName.get(name.toLowerCase())
      return {
        id: ledger?.id ?? name,
        name,
        amount,
        rawAmount: amount,
      }
    })
    .sort((a, b) => b.amount - a.amount)

  let changePct = null
  let comparisonLabel = 'No prior-month data for comparison'
  if (totalPrevPeriod > 0) {
    changePct = Math.round(((totalThisMonth - totalPrevPeriod) / totalPrevPeriod) * 100)
    const sign = changePct > 0 ? '+' : ''
    comparisonLabel = `${sign}${changePct}% vs first ${daySpan}d last month`
  }

  return {
    total: totalThisMonth,
    previousTotal: totalPrevPeriod,
    changePct,
    categories,
    totalThisMonth,
    totalPrevPeriod,
    pctChange: changePct,
    comparisonLabel,
    daySpan,
  }
}

/**
 * Reconcile each debtor's outstanding balance against their sales invoices (newest-first FIFO)
 * to compute real 0–30d, 31–60d, and 60d+ aging buckets.
 */
export function computeDebtorAging(debtors = [], vouchers = [], now = new Date()) {
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const todayMs = todayDate.getTime()

  const salesByParty = new Map()
  for (const v of vouchers || []) {
    if (v?.deleted_at || v?.voucher_type !== 'sales') continue
    const key = String(v?.party_name || '').trim().toLowerCase()
    if (!key) continue
    const dateKey = normalizeVoucherDateKey(v.date)
    if (!dateKey) continue
    const amt = Math.max(0, Number(v.due_amount ?? v.amount) || 0)
    if (amt <= 0) continue
    if (!salesByParty.has(key)) salesByParty.set(key, [])
    salesByParty.get(key).push({
      id: v.id ?? v.voucher_no,
      voucher_no: v.voucher_no,
      dateKey,
      amount: amt,
    })
  }

  for (const list of salesByParty.values()) {
    list.sort((a, b) => (a.dateKey < b.dateKey ? 1 : a.dateKey > b.dateKey ? -1 : 0))
  }

  let cat0to30 = 0
  let cat31to60 = 0
  let cat60plus = 0
  let totalOwed = 0
  const byParty = new Map()
  const outstandingByVoucher = new Map()

  const enrichedDebtors = (debtors || []).map((debtor) => {
    if (debtor?.deleted_at || (debtor?.type && debtor.type !== 'debtor')) {
      return debtor
    }
    const bal = Number(debtor?.current_balance) || 0
    if (bal <= 0) {
      const info = { bucket: bal < 0 ? 'Advance' : 'Settled', days: 0, balance: bal }
      if (debtor.id !== undefined) byParty.set(debtor.id, info)
      if (debtor.name) byParty.set(debtor.name, info)
      return {
        ...debtor,
        age_bucket: info.bucket,
        due_days: 0,
        buckets: { b0_30: 0, b31_60: 0, b60plus: 0 },
      }
    }

    totalOwed += bal
    const key = String(debtor?.name || '').trim().toLowerCase()
    const partyInvoices = salesByParty.get(key) || []

    let remaining = bal
    let b0_30 = 0
    let b31_60 = 0
    let b60plus = 0
    let oldestUnpaidDays = 0
    const lastInvoiceDate = partyInvoices[0]?.dateKey || debtor.last_invoice || ''

    if (partyInvoices.length > 0) {
      for (const inv of partyInvoices) {
        if (remaining <= 0) break
        const allocated = Math.min(remaining, inv.amount)
        remaining -= allocated
        if (allocated > 0 && inv.id !== undefined) {
          outstandingByVoucher.set(inv.id, allocated)
        }

        const [y, m, d] = inv.dateKey.split('-').map(Number)
        const invMs = new Date(y, m - 1, d).getTime()
        const days = Math.max(0, Math.floor((todayMs - invMs) / (1000 * 60 * 60 * 24)))
        if (days > oldestUnpaidDays) oldestUnpaidDays = days

        if (days > 60) b60plus += allocated
        else if (days > 30) b31_60 += allocated
        else b0_30 += allocated
      }

      if (remaining > 0) {
        b60plus += remaining
        if (oldestUnpaidDays <= 60) oldestUnpaidDays = 61
      }
    } else {
      const fallbackDays = Number.isFinite(Number(debtor?.due_days)) ? Number(debtor.due_days) : 61
      oldestUnpaidDays = fallbackDays
      if (fallbackDays > 60 || debtor?.age_bucket === '60d+') b60plus = bal
      else if (fallbackDays > 30 || debtor?.age_bucket === '31–60d') b31_60 = bal
      else b0_30 = bal
    }

    cat0to30 += b0_30
    cat31to60 += b31_60
    cat60plus += b60plus

    const ageBucket = b60plus > 0 || oldestUnpaidDays > 60
      ? '60d+'
      : b31_60 > 0 || oldestUnpaidDays > 30
        ? '31–60d'
        : '0–30d'

    const info = { bucket: ageBucket, days: oldestUnpaidDays, balance: bal }
    if (debtor.id !== undefined) byParty.set(debtor.id, info)
    if (debtor.name) byParty.set(debtor.name, info)

    return {
      ...debtor,
      age_bucket: ageBucket,
      due_days: oldestUnpaidDays,
      last_invoice: lastInvoiceDate || debtor.last_invoice || 'Opening balance',
      buckets: { b0_30, b31_60, b60plus },
    }
  })

  const totals = {
    '0–30d': cat0to30,
    '31–60d': cat31to60,
    '60d+': cat60plus,
  }

  const bucketSum = cat0to30 + cat31to60 + cat60plus
  const p1 = bucketSum > 0 ? Math.round((cat0to30 / bucketSum) * 100) : 0
  const p2 = bucketSum > 0 ? Math.round((cat31to60 / bucketSum) * 100) : 0
  const p3 = bucketSum > 0 ? Math.max(0, 100 - p1 - p2) : 0

  return {
    totals,
    byParty,
    outstandingByVoucher,
    totalOwed,
    cat0to30,
    cat31to60,
    cat60plus,
    p1: `${p1}%`,
    p2: `${p2}%`,
    p3: `${p3}%`,
    enrichedDebtors,
  }
}
