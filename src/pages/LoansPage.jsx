import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  Edit3,
} from 'lucide-react'
import Nav from '../components/Nav'
import { accDb } from '../lib/accountingDb'
import { classifyLoanLedgers, ledgerTransactions, ledgerActivitySummary } from '../lib/ledgerActivity'
import AdminEditModal from '../components/AdminEditModal'

export default function LoansPage() {
  const navigate = useNavigate()
  const [loansOwed, setLoansOwed] = useState([])
  const [advancesGiven, setAdvancesGiven] = useState([])
  const [vouchers, setVouchers] = useState([])
  const [activity, setActivity] = useState(new Map())
  const [expandedLedger, setExpandedLedger] = useState(null)
  const [editingLoan, setEditingLoan] = useState(null)

  // Load from Dexie ledgers and vouchers
  const loadLoans = useCallback(async () => {
    try {
      const [allLedgers, allVouchers] = await Promise.all([
        accDb.ledgers.toArray(),
        accDb.vouchers.toArray(),
      ])

      const { owed, given } = classifyLoanLedgers(allLedgers)
      const activityMap = ledgerActivitySummary(allVouchers)

      setVouchers(allVouchers)
      setActivity(activityMap)

      setLoansOwed(
        owed.map((l) => ({
          id: l.id,
          name: l.name,
          amount: Math.abs(Number(l.current_balance) || 0),
          group: l.group || l.primary_group || 'Loans (Liability)',
          note: l.note || '',
        }))
      )

      setAdvancesGiven(
        given.map((l) => ({
          id: l.id,
          name: l.name,
          amount: Math.abs(Number(l.current_balance) || 0),
          group: l.group || l.primary_group || 'Loans & Advances (Asset)',
          note: l.note || '',
        }))
      )
    } catch {
      setLoansOwed([])
      setAdvancesGiven([])
      setVouchers([])
      setActivity(new Map())
    }
  }, [])

  useEffect(() => {
    loadLoans()
    const onUpdate = () => loadLoans()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadLoans])

  // Total Loans you owe
  const totalLoansOwed = useMemo(() => {
    return loansOwed.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
  }, [loansOwed])

  // Total Advances given
  const totalAdvancesGiven = useMemo(() => {
    return advancesGiven.reduce((sum, a) => sum + (Number(a.amount) || 0), 0)
  }, [advancesGiven])

  // Net you owe
  const netYouOwe = useMemo(() => {
    return Math.max(0, totalLoansOwed - totalAdvancesGiven)
  }, [totalLoansOwed, totalAdvancesGiven])

  const formatAmount = (amt) => {
    if (amt >= 100000) return `₹${(amt / 100000).toFixed(1)}L`
    if (amt >= 1000) return `₹${(amt / 1000).toFixed(0)}K`
    return `₹${amt}`
  }

  const toggleExpand = (name) => {
    setExpandedLedger((prev) => (prev === name ? null : name))
  }

  const renderTransactions = (ledgerName) => {
    const { total, rows } = ledgerTransactions(vouchers, ledgerName, { limit: 20 })
    if (total === 0) {
      return (
        <div className="mt-2 rounded-xl bg-[#f8faf9] p-3 text-xs text-[#718d84] text-center border border-[#e1e9e3]">
          No dated voucher postings found for this ledger. Balance may be from opening master.
        </div>
      )
    }

    return (
      <div className="mt-2 overflow-hidden rounded-xl border border-[#e1e9e3] bg-[#f8faf9]">
        <div className="bg-[#ebf4ef] px-3 py-1.5 text-[11px] font-extrabold text-[#11382f] flex justify-between">
          <span>Recent Transactions ({total})</span>
          <span>Date / Type / Amount</span>
        </div>
        <div className="divide-y divide-[#e1e9e3] max-h-56 overflow-y-auto">
          {rows.map((row, idx) => (
            <div key={idx} className="px-3 py-2 text-xs flex items-center justify-between hover:bg-white transition">
              <div>
                <div className="flex items-center gap-1.5 font-bold text-[#11382f]">
                  <span>{row.date}</span>
                  <span className="rounded bg-[#e2f0ea] px-1.5 py-0.2 text-[10px] text-[#0d6e63] font-semibold uppercase">
                    {row.voucher_type}
                  </span>
                  {row.voucher_no && (
                    <span className="text-[#6d8880] text-[11px]">#{row.voucher_no}</span>
                  )}
                </div>
                {row.narration && (
                  <p className="text-[11px] text-[#718d84] truncate max-w-xs sm:max-w-md">{row.narration}</p>
                )}
              </div>
              <div className="text-right">
                <span className={`font-mono font-bold ${row.isDebit ? 'text-[#b73725]' : 'text-[#0d786d]'}`}>
                  {row.isDebit ? 'Dr' : 'Cr'} ₹{row.amount.toLocaleString('en-IN')}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header with Back button and "+ Record Entry" (PDF Page 9) */}
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
              Loans &amp; Advances
            </h1>
          </div>

          <button
            type="button"
            onClick={() => navigate('/tally')}
            className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
            title="Import vouchers & masters from Tally XML"
          >
            <FileSpreadsheet size={16} />
            <span>Tally import</span>
          </button>
        </header>

        {/* Featured Net You Owe Card (PDF Page 9) */}
        <div className="mb-6 rounded-3xl bg-[#0e655d] p-6 text-white shadow-xs">
          <span className="text-xs font-semibold text-[#a5dcd0]">
            Net you owe
          </span>
          <strong className="mt-2 block text-[38px] font-extrabold tracking-tight sm:text-[44px]">
            {formatAmount(netYouOwe)}
          </strong>
        </div>

        {/* Section 1: Loans you owe (PDF Page 9) */}
        <section className="mb-5 rounded-3xl border border-[#e1e9e3] border-l-4 border-l-[#c25e19] bg-white p-5 sm:p-6 shadow-xs">
          <div className="flex items-center justify-between pb-4 border-b border-[#edf3f0]">
            <div>
              <h2 className="text-[17px] font-extrabold text-[#11382f]">
                Loans you owe
              </h2>
              <span className="text-[11px] text-[#718d84]">
                Tap any ledger to view underlying voucher transactions
              </span>
            </div>
            <strong className="text-[18px] font-extrabold text-[#c25e19]">
              {formatAmount(totalLoansOwed)}
            </strong>
          </div>

          {loansOwed.length === 0 ? (
            <div className="py-6 text-center text-xs text-[#718d84]">
              No loans owed recorded. Import from Tally to sync loan liability ledgers.
            </div>
          ) : (
            <div className="divide-y divide-[#edf3f0]">
              {loansOwed.map((l) => {
                const isExpanded = expandedLedger === l.name
                const count = activity.get(l.name.toLowerCase())?.count || 0

                return (
                  <div key={l.id || l.name} className="py-3">
                    <div className="flex items-start justify-between group">
                      <div className="flex-1 cursor-pointer" onClick={() => toggleExpand(l.name)}>
                        <div className="flex items-center gap-2">
                          <strong className="block text-sm font-extrabold text-[#11382f] hover:text-[#0e655d] transition">
                            {l.name}
                          </strong>
                          {count > 0 && (
                            <span className="rounded bg-[#e8f3ee] px-1.5 py-0.5 text-[10px] font-extrabold text-[#0e655d]">
                              {count} tx
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingLoan({ id: l.id, name: l.name, current_balance: l.amount, group: l.group, note: l.note })
                            }}
                            className="opacity-75 group-hover:opacity-100 inline-flex items-center gap-1 rounded-md border border-[#cfded6] bg-[#f8faf9] px-2 py-0.5 text-[10px] font-bold text-[#0e655d] hover:bg-[#ebf3ef] transition"
                            title="Admin Edit loan record"
                          >
                            <Edit3 size={11} />
                            <span>Edit</span>
                          </button>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-[#718d84]">{l.group}</span>
                          {l.note && <span className="text-xs text-[#718d84]">· {l.note}</span>}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <strong className="text-base font-extrabold text-[#11382f]">
                          ₹{l.amount.toLocaleString('en-IN')}
                        </strong>
                        <button
                          type="button"
                          onClick={() => toggleExpand(l.name)}
                          className="grid h-7 w-7 place-items-center rounded-lg text-[#6d8880] hover:bg-[#eef5f1] transition"
                          aria-label={isExpanded ? 'Collapse' : 'Expand transactions'}
                        >
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      </div>
                    </div>

                    {isExpanded && renderTransactions(l.name)}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Section 2: Advances given (PDF Page 9) */}
        <section className="rounded-3xl border border-[#e1e9e3] border-l-4 border-l-[#0b786e] bg-white p-5 sm:p-6 shadow-xs">
          <div className="flex items-center justify-between pb-4 border-b border-[#edf3f0]">
            <div>
              <h2 className="text-[17px] font-extrabold text-[#11382f]">
                Advances given
              </h2>
              <span className="text-[11px] text-[#718d84]">
                Tap any ledger to view underlying voucher transactions
              </span>
            </div>
            <strong className="text-[18px] font-extrabold text-[#0e655d]">
              {formatAmount(totalAdvancesGiven)}
            </strong>
          </div>

          {advancesGiven.length === 0 ? (
            <div className="py-6 text-center text-xs text-[#718d84]">
              No advances given recorded. Import from Tally to sync advance ledgers.
            </div>
          ) : (
            <div className="divide-y divide-[#edf3f0]">
              {advancesGiven.map((a) => {
                const isExpanded = expandedLedger === a.name
                const count = activity.get(a.name.toLowerCase())?.count || 0

                return (
                  <div key={a.id || a.name} className="py-3">
                    <div className="flex items-start justify-between group">
                      <div className="flex-1 cursor-pointer" onClick={() => toggleExpand(a.name)}>
                        <div className="flex items-center gap-2">
                          <strong className="block text-sm font-extrabold text-[#11382f] hover:text-[#0e655d] transition">
                            {a.name}
                          </strong>
                          {count > 0 && (
                            <span className="rounded bg-[#e8f3ee] px-1.5 py-0.5 text-[10px] font-extrabold text-[#0e655d]">
                              {count} tx
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              setEditingLoan({ id: a.id, name: a.name, current_balance: a.amount, group: a.group, note: a.note })
                            }}
                            className="opacity-75 group-hover:opacity-100 inline-flex items-center gap-1 rounded-md border border-[#cfded6] bg-[#f8faf9] px-2 py-0.5 text-[10px] font-bold text-[#0e655d] hover:bg-[#ebf3ef] transition"
                            title="Admin Edit advance record"
                          >
                            <Edit3 size={11} />
                            <span>Edit</span>
                          </button>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[11px] text-[#718d84]">{a.group}</span>
                          {a.note && <span className="text-xs text-[#718d84]">· {a.note}</span>}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <strong className="text-base font-extrabold text-[#11382f]">
                          ₹{a.amount.toLocaleString('en-IN')}
                        </strong>
                        <button
                          type="button"
                          onClick={() => toggleExpand(a.name)}
                          className="grid h-7 w-7 place-items-center rounded-lg text-[#6d8880] hover:bg-[#eef5f1] transition"
                          aria-label={isExpanded ? 'Collapse' : 'Expand transactions'}
                        >
                          {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                        </button>
                      </div>
                    </div>

                    {isExpanded && renderTransactions(a.name)}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Admin Edit Modal */}
        <AdminEditModal
          isOpen={Boolean(editingLoan)}
          onClose={() => setEditingLoan(null)}
          type="ledger"
          item={editingLoan}
          onSaved={() => loadLoans()}
        />
      </main>
    </div>
  )
}
