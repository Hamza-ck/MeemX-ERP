import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  Edit3,
  TrendingDown,
} from 'lucide-react'
import Nav from '../components/Nav'
import { accDb } from '../lib/accountingDb'
import { calculateExpenseBreakdown } from '../lib/dashboardMetrics'
import AdminEditModal from '../components/AdminEditModal'

export default function ExpensesPage() {
  const navigate = useNavigate()
  const [period, setPeriod] = useState('thisMonth') // 'thisMonth' | 'lastMonth'
  const [categories, setCategories] = useState([])
  const [expandedCategory, setExpandedCategory] = useState(null)
  const [editingExpense, setEditingExpense] = useState(null)
  const [summary, setSummary] = useState({ total: 0, previousTotal: 0, changePct: null })
  const [lastMonthTotal, setLastMonthTotal] = useState(0)

  const monthNames = useMemo(() => {
    const now = new Date()
    const curr = now.toLocaleDateString('en-IN', { month: 'long' })
    const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const prev = prevDate.toLocaleDateString('en-IN', { month: 'long' })
    return { current: curr, previous: prev }
  }, [])

  // Operating expenses built from dated postings.
  const loadExpenses = useCallback(async () => {
    try {
      const [ledgers, vouchers] = await Promise.all([accDb.ledgers.toArray(), accDb.vouchers.toArray()])
      const result = calculateExpenseBreakdown(vouchers, ledgers, new Date(), { period })
      const prevResult = calculateExpenseBreakdown(vouchers, ledgers, new Date(), { period: 'lastMonth' })

      setCategories(result.categories.map((c) => ({
        id: c.name,
        name: c.name,
        rawAmount: c.amount,
        vouchers: c.vouchers || [],
      })))
      setSummary({ total: result.total, previousTotal: result.previousTotal, changePct: result.changePct })
      setLastMonthTotal(prevResult.total)
    } catch {
      setCategories([])
      setSummary({ total: 0, previousTotal: 0, changePct: null })
      setLastMonthTotal(0)
    }
  }, [period])

  useEffect(() => {
    loadExpenses()
    const onUpdate = () => loadExpenses()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadExpenses])

  const totalExpenses = summary.total

  // Bars are scaled to the largest category in the period
  const maxExpense = useMemo(() => Math.max(1, ...categories.map((c) => Number(c.rawAmount) || 0)), [categories])

  const formatAmount = (amt) => {
    if (amt < 0) return `-${formatAmount(-amt)}`
    if (amt >= 100000) return `₹${(amt / 100000).toFixed(1)}L`
    if (amt >= 1000) return `₹${(amt / 1000).toFixed(0)}K`
    return `₹${amt}`
  }

  const toggleCategory = (name) => {
    setExpandedCategory((prev) => (prev === name ? null : name))
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header with Back button (PDF Page 8) */}
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="grid h-9 w-9 place-items-center rounded-xl bg-white text-[#153e34] shadow-2xs hover:bg-[#ebf4ef] transition"
              aria-label="Back to dashboard"
            >
              <ChevronLeft size={20} />
            </button>
            <h1 className="text-[22px] font-extrabold tracking-tight text-[#11382f]">
              Expenses
            </h1>
          </div>

          <div className="flex items-center gap-2">
            {/* Period Pills */}
            <div className="flex items-center rounded-2xl bg-white p-1 border border-[#e1e9e3] shadow-xs">
              <button
                type="button"
                onClick={() => setPeriod('thisMonth')}
                className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                  period === 'thisMonth' ? 'bg-[#0e655d] text-white shadow-xs' : 'text-[#5d776f] hover:text-[#0e655d]'
                }`}
              >
                {monthNames.current}
              </button>
              <button
                type="button"
                onClick={() => setPeriod('lastMonth')}
                className={`rounded-xl px-3 py-1.5 text-xs font-bold transition ${
                  period === 'lastMonth' ? 'bg-[#0e655d] text-white shadow-xs' : 'text-[#5d776f] hover:text-[#0e655d]'
                }`}
              >
                {monthNames.previous}
              </button>
            </div>

            <button
              type="button"
              onClick={() => navigate('/tally')}
              className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
              title="Import vouchers from Tally XML"
            >
              <FileSpreadsheet size={16} />
              <span className="hidden sm:inline">Tally import</span>
            </button>
          </div>
        </header>

        {/* New Month Rollover Prompt */}
        {period === 'thisMonth' && totalExpenses === 0 && lastMonthTotal > 0 && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-[#cbe4d7] bg-[#eef7f2] p-3 text-xs">
            <span className="text-[#134e40]">
              <strong>{monthNames.current} has no expenses yet.</strong> Prior month ({monthNames.previous}) recorded {formatAmount(lastMonthTotal)}.
            </span>
            <button
              type="button"
              onClick={() => setPeriod('lastMonth')}
              className="rounded-xl bg-[#0e655d] px-3 py-1 font-bold text-white shadow-xs hover:bg-[#095049] transition whitespace-nowrap"
            >
              View {monthNames.previous} &rarr;
            </button>
          </div>
        )}

        {/* Featured Card */}
        <div className="mb-6 rounded-3xl border border-[#e1e9e3] bg-white p-6 shadow-xs">
          <span className="text-xs font-bold text-[#6a847c]">
            {period === 'thisMonth' ? `This month (${monthNames.current})` : `${monthNames.previous} total`}
          </span>
          <strong className="mt-1 block text-[38px] font-extrabold tracking-tight text-[#c25e19]">
            {formatAmount(totalExpenses)}
          </strong>
          {period === 'thisMonth' && (
            summary.changePct === null ? (
              <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-[#6a847c]">
                No expenses in the same days last month to compare
              </span>
            ) : (
              <span className={`mt-1 inline-flex items-center gap-1 text-xs font-bold ${summary.changePct <= 0 ? 'text-[#147366]' : 'text-[#b83e29]'}`}>
                <TrendingDown size={14} className={summary.changePct > 0 ? 'rotate-180' : ''} />
                {Math.abs(summary.changePct)}% {summary.changePct <= 0 ? 'lower' : 'higher'} than the same days last month
              </span>
            )
          )}
        </div>

        {/* By Category Section (PDF Page 8) */}
        <section className="rounded-3xl border border-[#e1e9e3] bg-white p-6 shadow-xs">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-[17px] font-extrabold text-[#11382f]">
                By category
              </h2>
              <p className="mt-0.5 text-[11px] font-semibold text-[#6e8a81]">
                Tap any category to view individual expense transactions
              </p>
            </div>
            <span className="text-xs font-bold text-[#0e655d]">
              {categories.length} categories
            </span>
          </div>

          <div className="space-y-4">
            {categories.length > 0 ? (
              categories.map((cat) => {
                const amt = Number(cat.rawAmount) || 0
                const percentage = Math.min(100, Math.max(4, Math.round((amt / maxExpense) * 100)))
                const barColor = amt >= maxExpense * 0.6 ? 'bg-[#b8521a]' : 'bg-[#cfa472]'
                const isExpanded = expandedCategory === cat.name
                const count = cat.vouchers?.length || 0

                return (
                  <div key={cat.id || cat.name} className="group rounded-2xl border border-[#edf3f0] p-3 hover:border-[#cbe1d7] transition">
                    <div
                      className="cursor-pointer"
                      onClick={() => toggleCategory(cat.name)}
                    >
                      <div className="flex items-center justify-between text-sm font-extrabold text-[#11382f] mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="hover:text-[#0e655d] transition">{cat.name}</span>
                          {count > 0 && (
                            <span className="rounded bg-[#e8f3ee] px-1.5 py-0.5 text-[10px] font-extrabold text-[#0e655d]">
                              {count} tx
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={async (e) => {
                              e.stopPropagation()
                              const ledger = await accDb.ledgers.where('name').equalsIgnoreCase(cat.name).first()
                              if (ledger) setEditingExpense(ledger)
                            }}
                            className="opacity-75 group-hover:opacity-100 inline-flex items-center gap-1 rounded-md border border-[#cfded6] bg-[#f8faf9] px-2 py-0.5 text-[10px] font-bold text-[#0e655d] hover:bg-[#ebf3ef] transition"
                            title="Admin Edit expense"
                          >
                            <Edit3 size={11} />
                            <span>Edit</span>
                          </button>
                        </div>
                        <div className="flex items-center gap-2">
                          <span>{formatAmount(amt)}</span>
                          <span className="text-[#6d8880]">
                            {isExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                          </span>
                        </div>
                      </div>
                      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[#edebe9]">
                        <div
                          className={`h-full rounded-full ${barColor} transition-all duration-300`}
                          style={{ width: `${percentage}%` }}
                        />
                      </div>
                    </div>

                    {/* Expandable Vouchers List */}
                    {isExpanded && (
                      <div className="mt-3 overflow-hidden rounded-xl border border-[#e1e9e3] bg-[#f8faf9]">
                        <div className="bg-[#ebf4ef] px-3 py-1.5 text-[11px] font-extrabold text-[#11382f] flex justify-between">
                          <span>Transactions ({count})</span>
                          <span>Date / Amount</span>
                        </div>
                        {count === 0 ? (
                          <div className="p-3 text-xs text-[#718d84] text-center">
                            No individual voucher lines recorded for this period.
                          </div>
                        ) : (
                          <div className="divide-y divide-[#e1e9e3] max-h-48 overflow-y-auto">
                            {cat.vouchers.map((v, idx) => (
                              <div key={idx} className="px-3 py-2 text-xs flex items-center justify-between hover:bg-white transition">
                                <div>
                                  <div className="flex items-center gap-1.5 font-bold text-[#11382f]">
                                    <span>{v.date}</span>
                                    <span className="text-[#6d8880] text-[11px]">#{v.voucher_no || v.voucher_type}</span>
                                    {v.party_name && (
                                      <span className="text-[#718d84] text-[11px]">({v.party_name})</span>
                                    )}
                                  </div>
                                  {v.narration && (
                                    <p className="text-[11px] text-[#718d84] truncate max-w-xs">{v.narration}</p>
                                  )}
                                </div>
                                <span className="font-mono font-bold text-[#b73725]">
                                  ₹{Number(v.amount).toLocaleString('en-IN')}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })
            ) : (
              <div className="py-6 text-center">
                <p className="text-sm font-bold text-[#11382f]">
                  No expenses recorded for {period === 'thisMonth' ? monthNames.current : monthNames.previous}
                </p>
                <p className="text-xs text-[#6e8a81] mt-1">
                  Import Tally Payment vouchers or expense ledgers to populate categories.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Admin Edit Modal */}
        <AdminEditModal
          isOpen={Boolean(editingExpense)}
          onClose={() => setEditingExpense(null)}
          type="ledger"
          item={editingExpense}
          onSaved={() => loadExpenses()}
        />
      </main>
    </div>
  )
}
