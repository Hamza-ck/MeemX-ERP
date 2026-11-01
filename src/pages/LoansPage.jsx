import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  FileSpreadsheet,
  Edit3,
} from 'lucide-react'
import Nav from '../components/Nav'
import { accDb } from '../lib/accountingDb'
import AdminEditModal from '../components/AdminEditModal'

export default function LoansPage() {
  const navigate = useNavigate()
  const [loansOwed, setLoansOwed] = useState([])
  const [advancesGiven, setAdvancesGiven] = useState([])
  const [editingLoan, setEditingLoan] = useState(null)

  // Load from Dexie ledgers
  const loadLoans = useCallback(async () => {
    try {
      const allLedgers = await accDb.ledgers.toArray()
      const owed = allLedgers.filter((l) => (l.group || '').toLowerCase().includes('loans (liability)'))
      const given = allLedgers.filter((l) => (l.group || '').toLowerCase().includes('loans & advances (asset)'))

      if (owed.length > 0) {
        setLoansOwed(
          owed.map((l) => ({
            id: l.id,
            name: l.name,
            amount: Number(l.current_balance) || 0,
            note: l.note || '',
          }))
        )
      } else {
        setLoansOwed([])
      }

      if (given.length > 0) {
        setAdvancesGiven(
          given.map((l) => ({
            id: l.id,
            name: l.name,
            amount: Number(l.current_balance) || 0,
            note: l.note || '',
          }))
        )
      } else {
        setAdvancesGiven([])
      }
    } catch {
      setLoansOwed([])
      setAdvancesGiven([])
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
            <h2 className="text-[17px] font-extrabold text-[#11382f]">
              Loans you owe
            </h2>
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
              {loansOwed.map((l) => (
                <div key={l.id || l.name} className="py-4 flex items-start justify-between group">
                  <div>
                    <div className="flex items-center gap-2">
                      <strong className="block text-sm font-extrabold text-[#11382f]">
                        {l.name}
                      </strong>
                      <button
                        type="button"
                        onClick={() => setEditingLoan({ id: l.id, name: l.name, current_balance: l.amount, group: 'Loans (Liability)', note: l.note })}
                        className="opacity-75 group-hover:opacity-100 inline-flex items-center gap-1 rounded-md border border-[#cfded6] bg-[#f8faf9] px-2 py-0.5 text-[10px] font-bold text-[#0e655d] hover:bg-[#ebf3ef] transition"
                        title="Admin Edit loan record"
                      >
                        <Edit3 size={11} />
                        <span>Edit</span>
                      </button>
                    </div>
                    {l.note && (
                      <span className="mt-1 block text-xs text-[#718d84]">
                        {l.note}
                      </span>
                    )}
                  </div>
                  <strong className="text-base font-extrabold text-[#11382f]">
                    {formatAmount(l.amount)}
                  </strong>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Section 2: Advances given (PDF Page 9) */}
        <section className="rounded-3xl border border-[#e1e9e3] border-l-4 border-l-[#0b786e] bg-white p-5 sm:p-6 shadow-xs">
          <div className="flex items-center justify-between pb-4 border-b border-[#edf3f0]">
            <h2 className="text-[17px] font-extrabold text-[#11382f]">
              Advances given
            </h2>
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
              {advancesGiven.map((a) => (
                <div key={a.id || a.name} className="py-4 flex items-start justify-between group">
                  <div>
                    <div className="flex items-center gap-2">
                      <strong className="block text-sm font-extrabold text-[#11382f]">
                        {a.name}
                      </strong>
                      <button
                        type="button"
                        onClick={() => setEditingLoan({ id: a.id, name: a.name, current_balance: a.amount, group: 'Loans & Advances (Asset)', note: a.note })}
                        className="opacity-75 group-hover:opacity-100 inline-flex items-center gap-1 rounded-md border border-[#cfded6] bg-[#f8faf9] px-2 py-0.5 text-[10px] font-bold text-[#0e655d] hover:bg-[#ebf3ef] transition"
                        title="Admin Edit advance record"
                      >
                        <Edit3 size={11} />
                        <span>Edit</span>
                      </button>
                    </div>
                    {a.note && (
                      <span className="mt-1 block text-xs text-[#718d84]">
                        {a.note}
                      </span>
                    )}
                  </div>
                  <strong className="text-base font-extrabold text-[#11382f]">
                    {formatAmount(a.amount)}
                  </strong>
                </div>
              ))}
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
