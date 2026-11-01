import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
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
  const [categories, setCategories] = useState([])
  const [editingExpense, setEditingExpense] = useState(null)

  const [summary, setSummary] = useState({ total: 0, previousTotal: 0, changePct: null })

  // This month's operating expenses, built from dated postings. The old version summed the
  // ledgers' cumulative closing balances (year-to-date, including purchases) and labelled it "This month".
  const loadExpenses = useCallback(async () => {
    try {
      const [ledgers, vouchers] = await Promise.all([accDb.ledgers.toArray(), accDb.vouchers.toArray()])
      const result = calculateExpenseBreakdown(vouchers, ledgers)
      setCategories(result.categories.map((c) => ({ id: c.name, name: c.name, rawAmount: c.amount })))
      setSummary({ total: result.total, previousTotal: result.previousTotal, changePct: result.changePct })
    } catch {
      setCategories([])
      setSummary({ total: 0, previousTotal: 0, changePct: null })
    }
  }, [])

  useEffect(() => {
    loadExpenses()
    const onUpdate = () => loadExpenses()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadExpenses])

  const totalExpenses = summary.total

  // Bars are scaled to the largest category this month (no hardcoded 1.2L ceiling).
  const maxExpense = useMemo(() => Math.max(1, ...categories.map((c) => Number(c.rawAmount) || 0)), [categories])

  const formatAmount = (amt) => {
    if (amt < 0) return `-${formatAmount(-amt)}`
    if (amt >= 100000) return `₹${(amt / 100000).toFixed(1)}L`
    if (amt >= 1000) return `₹${(amt / 1000).toFixed(0)}K`
    return `₹${amt}`
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

          <button
            type="button"
            onClick={() => navigate('/tally')}
            className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
            title="Import vouchers from Tally XML"
          >
            <FileSpreadsheet size={16} />
            <span>Tally import</span>
          </button>
        </header>

        {/* Featured This Month Card (PDF Page 8) */}
        <div className="mb-6 rounded-3xl border border-[#e1e9e3] bg-white p-6 shadow-xs">
          <span className="text-xs font-bold text-[#6a847c]">This month</span>
          <strong className="mt-1 block text-[38px] font-extrabold tracking-tight text-[#c25e19]">
            {formatAmount(totalExpenses)}
          </strong>
          {summary.changePct === null ? (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-[#6a847c]">
              No expenses in the same days last month to compare
            </span>
          ) : (
            <span className={`mt-1 inline-flex items-center gap-1 text-xs font-bold ${summary.changePct <= 0 ? 'text-[#147366]' : 'text-[#b83e29]'}`}>
              <TrendingDown size={14} className={summary.changePct > 0 ? 'rotate-180' : ''} />
              {Math.abs(summary.changePct)}% {summary.changePct <= 0 ? 'lower' : 'higher'} than the same days last month
            </span>
          )}
        </div>

        {/* By Category Section (PDF Page 8) */}
        <section className="rounded-3xl border border-[#e1e9e3] bg-white p-6 shadow-xs">
          <h2 className="text-[17px] font-extrabold text-[#11382f] mb-4">
            By category
          </h2>
          <p className="-mt-2 mb-4 text-[11px] font-semibold text-[#6e8a81]">Operating expenses only — stock purchases are cost of goods, not expenses.</p>

          <div className="space-y-5">
            {categories.length > 0 ? (
              categories.map((cat) => {
                const amt = Number(cat.rawAmount) || 0
                const percentage = Math.min(100, Math.max(4, Math.round((amt / maxExpense) * 100)))
                const barColor = amt >= maxExpense * 0.6 ? 'bg-[#b8521a]' : 'bg-[#cfa472]'

                return (
                  <div key={cat.id || cat.name} className="group">
                    <div className="flex items-center justify-between text-sm font-extrabold text-[#11382f] mb-1.5">
                      <div className="flex items-center gap-2">
                        <span>{cat.name}</span>
                        <button
                          type="button"
                          onClick={async () => { const ledger = await accDb.ledgers.where('name').equalsIgnoreCase(cat.name).first(); if (ledger) setEditingExpense(ledger) }}
                          className="opacity-75 group-hover:opacity-100 inline-flex items-center gap-1 rounded-md border border-[#cfded6] bg-[#f8faf9] px-2 py-0.5 text-[10px] font-bold text-[#0e655d] hover:bg-[#ebf3ef] transition"
                          title="Admin Edit expense"
                        >
                          <Edit3 size={11} />
                          <span>Edit</span>
                        </button>
                      </div>
                      <span>{formatAmount(amt)}</span>
                    </div>
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[#edebe9]">
                      <div
                        className={`h-full rounded-full ${barColor} transition-all duration-300`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="py-6 text-center">
                <p className="text-sm font-bold text-[#11382f]">No expenses recorded</p>
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
