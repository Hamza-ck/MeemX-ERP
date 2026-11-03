import { useState, useEffect, useMemo } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Download,
  Eye,
  EyeOff,
  ArrowUpRight,
  Check,
  Sliders,
  MessageCircle,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { accDb } from '../lib/accountingDb'
import { calculateDashboardMetrics, computeDebtorAging } from '../lib/dashboardMetrics'
import SalesBarChart from '../components/SalesBarChart'
import Nav from '../components/Nav'

export default function DashboardPage() {
  const {
    isAdmin,
    shopName,
    ownerPermissions,
    updateOwnerPermission,
    cardOrder,
    updateCardOrder,
  } = useAuth()

  const [period, setPeriod] = useState('Month') // 'Today' | 'Week' | 'Month'
  const [editLayout, setEditLayout] = useState(false)
  const [downloadSuccess, setDownloadSuccess] = useState(false)
  const [remindSent, setRemindSent] = useState(null)
  const [liveMetrics, setLiveMetrics] = useState(null)
  const [liveDebtors, setLiveDebtors] = useState(null)
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState('Live local books')
  const navigate = useNavigate()

  // Format currency in Indian standard Lakhs/Crores
  const formatMoney = (val, compact = true) => {
    const num = Number(val) || 0
    if (compact) {
      if (Math.abs(num) >= 10000000) return `₹${(num / 10000000).toFixed(1)}Cr`
      if (Math.abs(num) >= 100000) return `₹${(num / 100000).toFixed(1)}L`
      if (Math.abs(num) >= 1000) return `₹${(num / 1000).toFixed(1)}K`
      return `₹${num}`
    }
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(num)
  }

  // Load live DB data
  useEffect(() => {
    let active = true

    async function loadData() {
      try {
        const [parties, materials, ledgers, vouchers, syncSetting] = await Promise.all([
          accDb.parties.toArray(),
          accDb.materials.toArray(),
          accDb.ledgers.toArray(),
          accDb.vouchers.toArray(),
          accDb.settings.get('last_cloud_sync'),
        ])
        if (!active) return

        if (syncSetting?.value) {
          const dt = new Date(syncSetting.value)
          if (!Number.isNaN(dt.getTime())) {
            setLastUpdatedLabel(
              `Updated ${dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
            )
          }
        }
        if (!active) return

        const debtors = parties.filter((p) => p.type === 'debtor')
        const creditors = parties.filter((p) => p.type === 'creditor')

        // Only positive balances are money owed. A negative balance is an advance on the other
        // side and must not silently cancel out other parties' dues.
        const owing = (list) => list.filter((p) => (Number(p.current_balance) || 0) > 0)
        const debtorsSum = owing(debtors).reduce((s, d) => s + Number(d.current_balance), 0)
        const creditorsSum = owing(creditors).reduce((s, c) => s + Number(c.current_balance), 0)
        const stockSum = materials.reduce((sum, material) => {
          if (material.current_value != null && Number.isFinite(Number(material.current_value))) {
            return sum + Number(material.current_value)
          }
          return sum + (Number(material.current_qty) || 0) * (Number(material.purchase_rate) || 0)
        }, 0)

        const loansOwed = ledgers
          .filter((l) => !l.deleted_at && l.category === 'liability' && /loan|overdraft|bank od/i.test(`${l.primary_group || ''} ${l.group || ''}`))
          .reduce((s, l) => s + Math.max(0, Number(l.current_balance) || 0), 0)
        const advGiven = ledgers
          .filter((l) => (l.group || '').toLowerCase().includes('loans & advances (asset)'))
          .reduce((s, l) => s + (Number(l.current_balance) || 0), 0)

        // Keep dashboard date totals in one pass through voucher history.
        let pnl = []
        try { pnl = JSON.parse((await accDb.settings.get('tally_pnl'))?.value || '[]') } catch { pnl = [] }
        const calculated = calculateDashboardMetrics(vouchers, ledgers, new Date(), { materials, parties, pnl })
        const aging = computeDebtorAging(parties, vouchers)
        const {
          salesToday, salesWeek, salesMonth, salesPrevMonth,
          expensesToday, expensesWeek, expensesMonth, expensesPrevMonth,
          operatingResultToday, operatingResultWeek, operatingResultMonth, operatingResultPrevMonth,
          sales7Days, sales7DaysTotal,
          operatingResultBasis,
          operatingResultNote,
          operatingResultDetail,
          operatingResultApprox,
          currentMonthName, currentMonthFullName, prevMonthName, prevMonthFullName,
        } = calculated

        const last7 = sales7Days.map((item) => ({ ...item, display: formatMoney(item.amount) }))

        setLiveMetrics({
          debtorsSum,
          debtorsCount: owing(debtors).length,
          creditorsSum,
          creditorsCount: owing(creditors).length,
          stockSum,
          netLoans: Math.max(0, loansOwed - advGiven),
          salesToday,
          salesWeek,
          salesMonth,
          salesPrevMonth,
          expensesToday,
          expensesWeek,
          expensesMonth,
          expensesPrevMonth,
          operatingResultToday,
          operatingResultWeek,
          operatingResultMonth,
          operatingResultPrevMonth,
          operatingResultBasis,
          operatingResultNote,
          operatingResultDetail,
          operatingResultApprox,
          sales7Days: last7,
          sales7DaysTotal,
          currentMonthName,
          currentMonthFullName,
          prevMonthName,
          prevMonthFullName,
        })

        const topDebtors = debtors
          .filter((d) => (Number(d.current_balance) || 0) > 0)
          .sort((a, b) => (Number(b.current_balance) || 0) - (Number(a.current_balance) || 0))
          .slice(0, 5)
          .map((d) => {
            const bucket = aging.byParty.get(d.id ?? d.name)?.bucket || '0–30d'
            return {
              name: d.name,
              age: bucket,
              ageTone:
                bucket === '60d+'
                  ? 'bg-[#fcebe6] text-[#ba3e29]'
                  : bucket === '31–60d'
                  ? 'bg-[#fdf1dc] text-[#9a6412]'
                  : 'bg-[#e3f2ec] text-[#136b60]',
              amount: `₹${(Number(d.current_balance) || 0).toLocaleString('en-IN')}`,
              phone: d.phone || '',
            }
          })

        setLiveDebtors(topDebtors)
      } catch {
        // fallback
      }
    }

    loadData()
    const onUpdate = () => loadData()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => {
      active = false
      window.removeEventListener('accounting-data-updated', onUpdate)
    }
  }, [])

  // Metrics dynamically derived from live DB records
  const metrics = useMemo(() => {
    const debtorsVal = formatMoney(liveMetrics?.debtorsSum || 0)
    const debtorsDetail = `They owe you · ${liveMetrics?.debtorsCount || 0}`
    const creditorsVal = formatMoney(liveMetrics?.creditorsSum || 0)
    const creditorsDetail = `You owe · ${liveMetrics?.creditorsCount || 0}`
    // Show the arithmetic so the profit can be checked against Tally: Sales − Cost of sales − Expenses.
    const profitDiff = (key, pVal) => {
      const d = liveMetrics?.operatingResultDetail?.[key]
      if (pVal == null || !d) return liveMetrics?.operatingResultNote?.[key] || 'No transactions in this period'
      const other = d.otherIncome ? ` + ${formatMoney(d.otherIncome)} other income` : ''
      const line = d.source === 'tally'
        ? `${formatMoney(d.sales)} sales − ${formatMoney(d.cost)} cost of sales − ${formatMoney(d.expenses)} expenses${other} · Tally P&L${d.fetchedAt ? ' as of ' + new Date(d.fetchedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : ''}`
        : `Estimated from vouchers: ${formatMoney(d.sales)} sales − ${formatMoney(d.cost)} item cost − ${formatMoney(d.expenses)} expenses (Tally P&L not synced yet)`
      return liveMetrics?.operatingResultApprox?.[key] ? `${line} · ⚠ ${liveMetrics.operatingResultNote[key]}` : line
    }

    const stockVal = formatMoney(liveMetrics?.stockSum || 0)
    const loansVal = formatMoney(liveMetrics?.netLoans || 0)

    if (period === 'Today') {
      const sVal = liveMetrics?.salesToday || 0
      const pVal = liveMetrics?.operatingResultToday
      const eVal = liveMetrics?.expensesToday || 0
      return {
        sales: { value: formatMoney(sVal), diff: sVal > 0 ? 'Today revenue' : 'No sales today', isPositive: true },
        profit: { value: pVal == null ? '—' : formatMoney(pVal), diff: profitDiff('today', pVal), isPositive: pVal != null && pVal >= 0 },
        expenses: { value: formatMoney(eVal), diff: eVal > 0 ? 'Today expenses' : 'No expenses', isPositive: false },
        debtors: { value: debtorsVal, detail: debtorsDetail },
        creditors: { value: creditorsVal, detail: creditorsDetail },
        inventory: { value: stockVal, detail: 'Stock value' },
        loans: { value: loansVal, detail: 'Net balance' },
      }
    } else if (period === 'Week') {
      const sVal = liveMetrics?.salesWeek || 0
      const pVal = liveMetrics?.operatingResultWeek
      const eVal = liveMetrics?.expensesWeek || 0
      return {
        sales: { value: formatMoney(sVal), diff: sVal > 0 ? 'Last 7 days' : 'No sales this week', isPositive: true },
        profit: { value: pVal == null ? '—' : formatMoney(pVal), diff: profitDiff('week', pVal), isPositive: pVal != null && pVal >= 0 },
        expenses: { value: formatMoney(eVal), diff: eVal > 0 ? 'Weekly expenses' : 'No expenses', isPositive: false },
        debtors: { value: debtorsVal, detail: debtorsDetail },
        creditors: { value: creditorsVal, detail: creditorsDetail },
        inventory: { value: stockVal, detail: 'Stock value' },
        loans: { value: loansVal, detail: 'Net balance' },
      }
    } else if (period === 'Last month') {
      const sVal = liveMetrics?.salesPrevMonth || 0
      const pVal = liveMetrics?.operatingResultPrevMonth
      const eVal = liveMetrics?.expensesPrevMonth || 0
      const prevName = liveMetrics?.prevMonthFullName || 'Last month'
      return {
        sales: { value: formatMoney(sVal), diff: `${prevName} total`, isPositive: true },
        profit: { value: pVal == null ? '—' : formatMoney(pVal), diff: profitDiff('lastMonth', pVal), isPositive: pVal != null && pVal >= 0 },
        expenses: { value: formatMoney(eVal), diff: `${prevName} expenses`, isPositive: false },
        debtors: { value: debtorsVal, detail: debtorsDetail },
        creditors: { value: creditorsVal, detail: creditorsDetail },
        inventory: { value: stockVal, detail: 'Stock value' },
        loans: { value: loansVal, detail: 'Net balance' },
      }
    } else {
      const sVal = liveMetrics?.salesMonth || 0
      const pVal = liveMetrics?.operatingResultMonth
      const eVal = liveMetrics?.expensesMonth || 0
      const currFull = liveMetrics?.currentMonthFullName || 'This month'
      const currShort = liveMetrics?.currentMonthName || 'Nov'
      const prevShort = liveMetrics?.prevMonthName || 'Oct'
      const prevSalesVal = liveMetrics?.salesPrevMonth || 0
      const prevExpVal = liveMetrics?.expensesPrevMonth || 0
      const prevProfitVal = liveMetrics?.operatingResultPrevMonth
      return {
        sales: {
          value: formatMoney(sVal),
          diff: sVal > 0
            ? `${currFull} revenue`
            : prevSalesVal > 0
            ? `No ${currShort} sales yet · ${prevShort}: ${formatMoney(prevSalesVal)}`
            : 'No sales this month',
          isPositive: true,
        },
        profit: {
          value: pVal == null ? '—' : formatMoney(pVal),
          diff: pVal == null
            ? profitDiff('month', pVal)
            : sVal === 0 && prevProfitVal != null
            ? `No ${currShort} profit yet · ${prevShort}: ${formatMoney(prevProfitVal)}`
            : profitDiff('month', pVal),
          isPositive: pVal != null && pVal >= 0,
        },
        expenses: {
          value: formatMoney(eVal),
          diff: eVal > 0
            ? 'Monthly expenses'
            : prevExpVal > 0
            ? `No ${currShort} expenses · ${prevShort}: ${formatMoney(prevExpVal)}`
            : 'No expenses',
          isPositive: false,
        },
        debtors: { value: debtorsVal, detail: debtorsDetail },
        creditors: { value: creditorsVal, detail: creditorsDetail },
        inventory: { value: stockVal, detail: 'Stock value' },
        loans: { value: loansVal, detail: 'Net balance' },
      }
    }
  }, [period, liveMetrics])

  // 7-day Sales Bar Chart data
  const sales7Days = liveMetrics?.sales7Days || [
    { day: 'Mon', amount: 0, display: '₹0' },
    { day: 'Tue', amount: 0, display: '₹0' },
    { day: 'Wed', amount: 0, display: '₹0' },
    { day: 'Thu', amount: 0, display: '₹0' },
    { day: 'Fri', amount: 0, display: '₹0' },
    { day: 'Sat', amount: 0, display: '₹0' },
    { day: 'Sun', amount: 0, display: '₹0' },
  ]
  const sales7DaysTotal = liveMetrics?.sales7DaysTotal || 0

  // Supported periods
  const periodOptions = useMemo(() => {
    const list = ['Today', 'Week', 'Month']
    if ((liveMetrics?.salesPrevMonth || 0) > 0) {
      list.push('Last month')
    }
    return list
  }, [liveMetrics?.salesPrevMonth])

  // Money to collect list
  const moneyToCollect = liveDebtors || []

  const handleSendReminder = (customer) => {
    const text = encodeURIComponent(
      `Hello ${customer.name}, gentle payment reminder from ${shopName} for outstanding balance of ${customer.amount} (${customer.age}). Please arrange settlement at your earliest convenience. Thank you!`
    )
    window.open(`https://wa.me/${customer.phone.replace(/[^0-9]/g, '')}?text=${text}`, '_blank')
    setRemindSent(customer.name)
    setTimeout(() => setRemindSent(null), 3000)
  }

  const handleDownloadReport = () => {
    const rows = [
      ['MEEMX ERP / TallyFlow - Executive Summary Report'],
      ['Period', period],
      ['Generated On', new Date().toLocaleString()],
      [],
      ['Metric', 'Figure'],
      ['Sales', metrics.sales.value],
      ['Operating result (sales less item costs & recorded expenses)', metrics.profit.value],
      ['Expenses', metrics.expenses.value],
      ['Debtors (They owe you)', metrics.debtors.value],
      ['Creditors (You owe)', metrics.creditors.value],
      ['Inventory (Stock value)', metrics.inventory.value],
      ['Loans & Advances', metrics.loans.value],
      [],
      ['Customer', 'Aging', 'Amount', 'Phone'],
      ...moneyToCollect.map((c) => [c.name, c.age, c.amount, c.phone]),
    ]

    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n')
    const encodedUri = encodeURI(csvContent)
    const link = document.createElement('a')
    link.setAttribute('href', encodedUri)
    link.setAttribute('download', `Executive_Summary_${period}_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)

    setDownloadSuccess(true)
    setTimeout(() => setDownloadSuccess(false), 3000)
  }

  // Determine card definition dictionary
  const cardDefinitions = {
    sales: {
      id: 'sales',
      label: period === 'Today'
        ? 'Sales today'
        : period === 'Week'
        ? 'Sales this week'
        : period === 'Last month'
        ? `Sales in ${liveMetrics?.prevMonthFullName || 'Last month'}`
        : `Sales this month (${liveMetrics?.currentMonthFullName || 'Current'})`,
      to: '/sales',
      value: metrics.sales.value,
      badge: metrics.sales.diff,
      isFeatured: true,
    },
    profit: {
      id: 'profit',
      label: period === 'Last month' ? `Operating result (${liveMetrics?.prevMonthFullName || 'Last month'})` : 'Operating result',
      to: '/sales',
      value: metrics.profit.value,
      badge: metrics.profit.diff,
      accent: 'border-l-4 border-l-[#c25e19]',
    },
    expenses: {
      id: 'expenses',
      label: period === 'Last month' ? `Expenses (${liveMetrics?.prevMonthFullName || 'Last month'})` : 'Expenses',
      to: '/expenses',
      value: metrics.expenses.value,
      badge: metrics.expenses.diff,
      accent: 'border-l-4 border-l-[#b07d3b]',
    },
    debtors: {
      id: 'debtors',
      label: 'Debtors',
      to: '/debtors',
      value: metrics.debtors.value,
      detail: metrics.debtors.detail,
      accent: 'border-l-4 border-l-[#0b786e]',
    },
    creditors: {
      id: 'creditors',
      label: 'Creditors',
      to: '/creditors',
      value: metrics.creditors.value,
      detail: metrics.creditors.detail,
      accent: 'border-l-4 border-l-[#c25e19]',
    },
    inventory: {
      id: 'inventory',
      label: 'Inventory',
      to: '/inventory',
      value: metrics.inventory.value,
      detail: metrics.inventory.detail,
      accent: 'border-l-4 border-l-[#0b3832]',
    },
    loans: {
      id: 'loans',
      label: 'Loans & Advances',
      to: '/loans',
      value: metrics.loans.value,
      detail: metrics.loans.detail,
      accent: 'border-l-4 border-l-[#2a4e58]',
    },
  }

  // Move card up or down in Admin Edit Layout mode
  const moveCard = (index, direction) => {
    const newOrder = [...cardOrder]
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= newOrder.length) return
    const temp = newOrder[index]
    newOrder[index] = newOrder[targetIndex]
    newOrder[targetIndex] = temp
    updateCardOrder(newOrder)
  }

  // Filter cards: If in Owner view, ONLY show cards permitted by Admin!
  const visibleCardIds = cardOrder.filter((id) => {
    if (editLayout && isAdmin) return true
    if (isAdmin) return true
    return ownerPermissions[id] !== false
  })

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10">
      <Nav />

      {/* Main Page Container */}
      <main className="mx-auto max-w-6xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* ================= TOP MOBILE HEADER (PDF Page 1 & 15) ================= */}
        <header className="mb-4 flex items-center justify-between lg:hidden">
          <div>
            <span className="text-[12px] font-medium text-[#5f7971]">Good evening</span>
            <h1 className="text-[20px] font-extrabold tracking-tight text-[#11352e]">
              {editLayout ? `${shopName} Dashboard` : shopName}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {isAdmin && (
              <button
                type="button"
                onClick={() => setEditLayout(!editLayout)}
                className={`rounded-full px-3 py-1.5 text-xs font-extrabold transition shadow-xs ${
                  editLayout
                    ? 'bg-[#0d6e63] text-white'
                    : 'bg-[#e2f0ea] text-[#0d6e63] hover:bg-[#d6e9e1]'
                }`}
              >
                {editLayout ? 'Done' : 'Admin'}
              </button>
            )}
            <div
              className="grid h-10 w-10 place-items-center rounded-full bg-[#0d6e63] text-base font-extrabold text-white shadow-sm"
              aria-label={isAdmin ? 'Admin account' : 'Owner account'}
            >
              {isAdmin ? 'A' : 'S'}
            </div>
          </div>
        </header>

        {/* ================= TOP DESKTOP HEADER (PDF Page 5 & 13) ================= */}
        <header className="hidden items-center justify-between pb-5 lg:flex">
          <div>
            <h1 className="text-[26px] font-extrabold tracking-tight text-[#0d342d]">
              {isAdmin && editLayout ? 'Dashboard' : 'Good evening'}
            </h1>
            <p className="mt-0.5 text-xs text-[#637d75]">
              {isAdmin && editLayout
                ? 'Same screen your owner sees, with edit controls'
                : 'Here is how your business is doing'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="rounded-xl border border-[#e1e9e3] bg-white px-3 py-2 text-xs font-bold text-[#5d776f]">
              {isAdmin ? 'Admin account' : 'Owner view'}
            </span>

            {/* Time Filter Pills: Today / Week / Month / Last month */}
            <div className="flex items-center rounded-2xl bg-white p-1 border border-[#e1e9e3] shadow-xs">
              {periodOptions.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPeriod(p)}
                  className={`rounded-xl px-3.5 py-1.5 text-xs font-bold transition ${
                    period === p ? 'bg-[#0e655d] text-white shadow-xs' : 'text-[#5d776f] hover:text-[#0e655d]'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            {/* Download Report Button */}
            <button
              type="button"
              onClick={handleDownloadReport}
              className="flex items-center gap-2 rounded-2xl bg-[#0e655d] px-4 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-[#0b544d] transition active:scale-95"
            >
              {downloadSuccess ? <Check size={15} /> : <Download size={15} />}
              {downloadSuccess ? 'Downloaded!' : 'Download report'}
            </button>
          </div>
        </header>

        {/* Mobile Period Filter (PDF Page 1) */}
        <div className="mb-4 flex items-center justify-between rounded-2xl bg-white p-1 border border-[#e1e9e3] shadow-xs lg:hidden">
          {periodOptions.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`flex-1 rounded-xl py-2 text-xs font-bold text-center transition ${
                period === p
                  ? 'bg-white text-[#0e655d] shadow-sm'
                  : 'text-[#6e867f] hover:text-[#0e655d]'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* ================= EDIT LAYOUT BANNER (PDF Page 13 Desktop & Page 15 Mobile) ================= */}
        {isAdmin && editLayout && (
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#cbe4d7] bg-[#eef7f2] p-3 sm:p-4 text-xs">
            <div className="flex items-center gap-2 text-[#185344] font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#0e655d] text-white">
                <Eye size={15} />
              </span>
              <span>Edit layout is on. Drag to reorder, tap the eye to hide a card from the owner.</span>
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => navigate('/settings')}
                className="rounded-xl border border-[#b7dcce] bg-white px-3 py-1.5 font-bold text-[#115748] hover:bg-[#e4f3ed]"
              >
                Visibility settings
              </button>
              <button
                type="button"
                onClick={() => setEditLayout(false)}
                className="rounded-xl bg-[#0e655d] px-4 py-1.5 font-bold text-white hover:bg-[#095049]"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Admin Toggle button on Desktop when not in edit mode */}
        {isAdmin && !editLayout && (
          <div className="mb-4 hidden items-center justify-end lg:flex">
            <button
              type="button"
              onClick={() => setEditLayout(true)}
              className="flex items-center gap-1.5 text-xs font-bold text-[#0e655d] hover:underline"
            >
              <Sliders size={14} /> Customize owner layout
            </button>
          </div>
        )}

        {/* ================= NEW MONTH BANNER ================= */}
        {period === 'Month' && (liveMetrics?.salesMonth || 0) === 0 && (liveMetrics?.salesPrevMonth || 0) > 0 && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#cbe4d7] bg-[#eef7f2] p-3 sm:p-4 text-xs">
            <div className="flex items-center gap-2 text-[#134e40]">
              <span className="text-base leading-none">📅</span>
              <div>
                <strong className="font-extrabold text-[#0e655d]">{liveMetrics?.currentMonthFullName || 'November'} has just started.</strong>
                <span className="ml-1 text-[#3c6b5e]">
                  No sales vouchers entered in Tally for {liveMetrics?.currentMonthFullName || 'this month'} yet. Your existing records are safe and intact.
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPeriod('Last month')}
              className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-[#0e655d] px-3.5 py-1.5 font-bold text-white shadow-xs hover:bg-[#095049] transition active:scale-95 cursor-pointer"
            >
              View {liveMetrics?.prevMonthFullName || 'October'} summary ({formatMoney(liveMetrics.salesPrevMonth)}) &rarr;
            </button>
          </div>
        )}

        {/* ================= VIEWING LAST MONTH BANNER ================= */}
        {period === 'Last month' && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#cbe4d7] bg-[#eef7f2] p-3 sm:p-4 text-xs">
            <div className="flex items-center gap-2 text-[#134e40]">
              <span className="text-base leading-none">📊</span>
              <div>
                <strong className="font-extrabold text-[#0e655d]">Viewing {liveMetrics?.prevMonthFullName || 'October'} closed summary.</strong>
                <span className="ml-1 text-[#3c6b5e]">
                  Showing complete month totals ({formatMoney(liveMetrics?.salesPrevMonth || 0)} sales).
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPeriod('Month')}
              className="ml-auto inline-flex items-center gap-1.5 rounded-xl border border-[#0e655d] bg-white px-3.5 py-1.5 font-bold text-[#0e655d] hover:bg-[#e4f3ed] transition active:scale-95 cursor-pointer"
            >
              Switch to {liveMetrics?.currentMonthFullName || 'November'} (Current) &rarr;
            </button>
          </div>
        )}

        {/* ================= KPI CARDS GRID (PDF Page 1, 5, 13, 15) ================= */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 sm:gap-4">
          {visibleCardIds.map((cardId, index) => {
            const card = cardDefinitions[cardId]
            if (!card) return null
            const isOwnerHidden = ownerPermissions[cardId] === false

            // 1. Featured Big Emerald Sales Card (PDF Page 1 & 5)
            if (card.isFeatured) {
              return (
                <div
                  key={card.id}
                  className={`relative col-span-1 sm:col-span-2 rounded-3xl p-6 text-white transition shadow-sm ${
                    editLayout
                      ? 'border-2 border-dashed border-white/60 bg-[#0e655d]'
                      : 'bg-[#0e655d] hover:shadow-md'
                  }`}
                >
                  {/* Eye toggle for Admin in Edit Mode */}
                  {editLayout && isAdmin && (
                    <div className="absolute top-4 right-4 flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          updateOwnerPermission(card.id, isOwnerHidden)
                        }}
                        className="grid h-8 w-8 place-items-center rounded-full bg-white text-[#0e655d] shadow-sm hover:scale-105"
                        title={isOwnerHidden ? 'Show to owner' : 'Hide from owner'}
                      >
                        {isOwnerHidden ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-[#a5dcd0]">
                      {card.label}
                    </span>
                    <Link
                      to={card.to}
                      className="rounded-full bg-white/10 p-1 text-[#bad4cc] hover:text-white"
                      title="View all sales"
                    >
                      <ArrowUpRight size={16} />
                    </Link>
                  </div>

                  <strong className="mt-4 block text-[38px] font-extrabold tracking-tight sm:text-[44px]">
                    {card.value}
                  </strong>

                  <div className="mt-3 flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-white px-3 py-1 text-xs font-bold text-[#0e655d] shadow-xs">
                      {card.badge}
                    </span>
                    {isOwnerHidden && (
                      <span className="rounded-full bg-[#fae8e5] px-2 py-0.5 text-[10px] font-bold text-[#ba3b2a]">
                        Hidden from Owner
                      </span>
                    )}
                  </div>
                </div>
              )
            }

            // 2. Standard Metric Cards with Left Accent Borders (PDF Page 1 & 5)
            return (
              <div
                key={card.id}
                className={`group relative flex min-h-[120px] flex-col justify-between rounded-2xl bg-white p-4 transition ${
                  editLayout
                    ? 'border-2 border-dashed border-[#b6d9cc]'
                    : `border border-[#e1e9e3] ${card.accent} shadow-xs hover:-translate-y-0.5 hover:shadow-md`
                }`}
              >
                {/* Admin edit controls */}
                {editLayout && isAdmin && (
                  <div className="absolute top-3 right-3 flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveCard(index, -1)}
                      disabled={index === 0}
                      className="p-1 text-[#658279] hover:text-[#0e655d] disabled:opacity-30"
                      title="Move card left/up"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => moveCard(index, 1)}
                      disabled={index === visibleCardIds.length - 1}
                      className="p-1 text-[#658279] hover:text-[#0e655d] disabled:opacity-30"
                      title="Move card right/down"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() => updateOwnerPermission(card.id, isOwnerHidden)}
                      className={`grid h-7 w-7 place-items-center rounded-full shadow-xs ${
                        isOwnerHidden
                          ? 'bg-[#feeae6] text-[#b73725]'
                          : 'bg-[#e2f3ec] text-[#0e655d]'
                      }`}
                      title={isOwnerHidden ? 'Show to owner' : 'Hide from owner'}
                    >
                      {isOwnerHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                )}

                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[#657d75]">
                      {card.label}
                    </span>
                    {!editLayout && (
                      <Link
                        to={card.to}
                        className="opacity-0 group-hover:opacity-100 transition text-[#8fa79f] hover:text-[#0e655d]"
                      >
                        <ArrowUpRight size={15} />
                      </Link>
                    )}
                  </div>
                  <strong className="mt-2 block text-[24px] font-extrabold tracking-tight text-[#16362f]">
                    {card.value}
                  </strong>
                </div>

                <div className="mt-2 flex items-center justify-between text-[11px] text-[#6d857d]">
                  {card.badge && (
                    <span className="font-semibold text-[#526e66]">
                      {card.badge}
                    </span>
                  )}
                  {card.detail && (
                    <span className="font-medium text-[#7a938c]">
                      {card.detail}
                    </span>
                  )}
                  {isOwnerHidden && (
                    <span className="text-[10px] font-bold text-[#ba3b2a]">
                      Hidden from Owner
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </section>

        {/* ================= DESKTOP LOWER SECTION: SALES CHART & MONEY TO COLLECT (PDF Page 5) ================= */}
        <section className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* 7-day Sales Bar Chart (PDF Page 5 Left Column) */}
          <div className="rounded-3xl border border-[#e1e9e3] bg-white p-5 lg:col-span-7 shadow-xs">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-sm font-extrabold text-[#143d35]">
                  Sales, last 7 days
                </h3>
      <span className="text-xs text-[#718b82]">Daily revenue trend</span>
              </div>
              <strong className="text-base font-extrabold text-[#0e655d]">
                {formatMoney(sales7DaysTotal)}
              </strong>
            </div>

            <div className="h-52 w-full pt-2">
              <SalesBarChart data={sales7Days} formatMoney={formatMoney} />
            </div>
          </div>

          {/* Money to collect (PDF Page 5 Right Column) */}
          <div className="rounded-3xl border border-[#e1e9e3] bg-white p-5 lg:col-span-5 shadow-xs">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-extrabold text-[#143d35]">
                Money to collect
              </h3>
              <Link
                to="/debtors"
                className="text-xs font-bold text-[#0e655d] hover:underline"
              >
                View all debtors
              </Link>
            </div>

            <div className="space-y-3">
              {moneyToCollect.length > 0 ? (
                moneyToCollect.map((item) => (
                  <div
                    key={item.name}
                    className="flex items-center justify-between rounded-2xl border border-[#edf3f0] bg-[#fafcfb] p-3 transition hover:bg-[#f3f8f5]"
                  >
                    <div className="min-w-0 pr-2">
                      <div className="flex items-center gap-2">
                        <strong className="block truncate text-xs font-bold text-[#143d35]">
                          {item.name}
                        </strong>
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${item.ageTone}`}>
                          {item.age}
                        </span>
                      </div>
                      <span className="block text-[13px] font-extrabold text-[#173a32] mt-0.5">
                        {item.amount}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSendReminder(item)}
                      className="flex items-center gap-1 rounded-xl border border-[#cbe3d9] bg-white px-3 py-1.5 text-xs font-bold text-[#0e655d] shadow-2xs hover:bg-[#0e655d] hover:text-white transition active:scale-95"
                    >
                      <MessageCircle size={13} />
                      {remindSent === item.name ? 'Opened!' : 'Remind'}
                    </button>
                  </div>
                ))
              ) : (
                <div className="py-8 text-center rounded-2xl border border-dashed border-[#dce6e1] p-4">
                  <p className="text-xs font-bold text-[#143d35]">
                    No outstanding collections
                  </p>
                  <p className="mt-1 text-[11px] text-[#78968d]">
                    Import customer accounts &amp; vouchers from Tally to see aging receivables.
                  </p>
                  <Link
                    to="/tally"
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-[#0e655d] px-3.5 py-1.5 text-xs font-extrabold text-white no-underline shadow-xs hover:bg-[#0a4f49]"
                  >
                    Import from Tally
                  </Link>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Bottom Timestamp (PDF Page 1 & 5) */}
        <footer className="mt-8 mb-4 text-center text-xs text-[#78938a]">
          {lastUpdatedLabel}
        </footer>
      </main>
    </div>
  )
}
