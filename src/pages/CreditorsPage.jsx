import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  Search,
  Phone,
  MessageCircle,
  FileSpreadsheet,
  Edit3,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import Nav from '../components/Nav'
import { accDb } from '../lib/accountingDb'
import AdminEditModal from '../components/AdminEditModal'

export default function CreditorsPage() {
  const { shopName } = useAuth()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [suppliers, setSuppliers] = useState([])
  const [editingCreditor, setEditingCreditor] = useState(null)

  // Load suppliers from Dexie
  const loadSuppliers = useCallback(async () => {
    try {
      const dbParties = await accDb.parties.where('type').equals('creditor').toArray()
      if (dbParties && dbParties.length > 0) {
        setSuppliers(dbParties)
      } else {
        setSuppliers([])
      }
    } catch {
      setSuppliers([])
    }
  }, [])

  useEffect(() => {
    loadSuppliers()
    const onUpdate = () => loadSuppliers()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadSuppliers])

  // Total you owe calculations
  const totalOwed = useMemo(() => {
    return suppliers.reduce((acc, s) => acc + (Number(s.current_balance) || 0), 0)
  }, [suppliers])

  // 3-segment Aging Breakdown
  const agingStats = useMemo(() => {
    let dueNow = 0
    let next15d = 0
    let later = 0

    suppliers.forEach((s) => {
      const bal = Number(s.current_balance) || 0
      const days = Number(s.due_days) || 15
      if (days <= 1) dueNow += bal
      else if (days <= 15) next15d += bal
      else later += bal
    })

    const total = dueNow + next15d + later || 1
    const p1 = Math.round((dueNow / total) * 100)
    const p2 = Math.round((next15d / total) * 100)
    const p3 = Math.max(0, 100 - p1 - p2)

    return {
      dueNow,
      next15d,
      later,
      p1: `${p1}%`,
      p2: `${p2}%`,
      p3: `${p3}%`,
    }
  }, [suppliers])

  const filteredSuppliers = useMemo(() => {
    if (!search.trim()) return suppliers
    const q = search.toLowerCase()
    return suppliers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        (s.phone && s.phone.includes(q))
    )
  }, [suppliers, search])

  const handleWhatsAppNotify = (supp) => {
    const text = encodeURIComponent(
      `Hello ${supp.name}, this is ${shopName || 'Shop'}. We have scheduled your payment of ₹${Number(supp.current_balance).toLocaleString('en-IN')} (${supp.due_status || 'due soon'}). Thank you for your partnership!`
    )
    window.open(`https://wa.me/${(supp.phone || '').replace(/[^0-9]/g, '')}?text=${text}`, '_blank')
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header with Back button and Tally Import button (PDF Page 6) */}
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
              Creditors
            </h1>
          </div>

          <button
            type="button"
            onClick={() => navigate('/tally')}
            className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
            title="Import suppliers and payables from Tally"
          >
            <FileSpreadsheet size={16} strokeWidth={2.5} />
            <span>Tally import</span>
          </button>
        </header>

        {/* Total You Owe & 3-segment Aging Bar (PDF Page 6) */}
        <div className="mb-5 rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs">
          <span className="text-xs font-bold text-[#627d75]">Total you owe</span>
          <strong className="mt-1 block text-[34px] font-extrabold tracking-tight text-[#c25e19]">
            ₹{(totalOwed / 100000).toFixed(1)}L
          </strong>

          {/* 3-segment horizontal progress bar */}
          <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-[#e8ecea]">
            <div
              className="bg-[#c25e19] transition-all"
              style={{ width: agingStats.p1 }}
              title={`Due now: ₹${(agingStats.dueNow / 100000).toFixed(1)}L`}
            />
            <div
              className="bg-[#d4995f] transition-all"
              style={{ width: agingStats.p2 }}
              title={`Next 15d: ₹${(agingStats.next15d / 100000).toFixed(1)}L`}
            />
            <div
              className="bg-[#e4cbaf] transition-all"
              style={{ width: agingStats.p3 }}
              title={`Later: ₹${(agingStats.later / 100000).toFixed(1)}L`}
            />
          </div>

          {/* Aging labels */}
          <div className="mt-3 flex items-center justify-between text-xs font-bold">
            <span className="flex items-center gap-1.5 text-[#c25e19]">
              <span className="h-2 w-2 rounded-full bg-[#c25e19]" />
              Due now ₹{(agingStats.dueNow / 100000).toFixed(1)}L
            </span>
            <span className="flex items-center gap-1.5 text-[#ad7339]">
              <span className="h-2 w-2 rounded-full bg-[#d4995f]" />
              Next 15d ₹{(agingStats.next15d / 100000).toFixed(1)}L
            </span>
            <span className="flex items-center gap-1.5 text-[#977b5a]">
              <span className="h-2 w-2 rounded-full bg-[#e4cbaf]" />
              Later ₹{(agingStats.later / 100000).toFixed(1)}L
            </span>
          </div>
        </div>

        {/* Search Supplier Input (PDF Page 6) */}
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-[#dbe6df] bg-white px-3.5 py-2.5 shadow-2xs focus-within:border-[#0e655d] transition">
          <Search size={18} className="text-[#7c978f] shrink-0" />
          <input
            type="text"
            className="w-full bg-transparent text-xs font-semibold text-[#11382f] outline-none placeholder:text-[#88a098]"
            placeholder="Search supplier name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Supplier Cards List (PDF Page 6) */}
        <div className="space-y-3">
          {filteredSuppliers.length > 0 ? (
            filteredSuppliers.map((supp) => {
              const bal = Number(supp.current_balance) || 0
              const isDueNow = (Number(supp.due_days) || 15) <= 1

              return (
                <article
                  key={supp.id}
                  className="rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs transition hover:shadow-md"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h2 className="text-[16px] font-extrabold text-[#11382f]">
                        {supp.name}
                      </h2>
                      <span className="mt-0.5 block text-xs text-[#718d84]">
                        Next payment {supp.next_payment || 'Soon'}
                      </span>
                    </div>
                    <div className="text-right">
                      <strong className="block text-[17px] font-extrabold text-[#c25e19]">
                        ₹{bal.toLocaleString('en-IN')}
                      </strong>
                      <span
                        className={`mt-1 inline-block rounded-md px-2.5 py-0.5 text-[11px] font-bold ${
                          isDueNow
                            ? 'bg-[#fceee9] text-[#b84628]'
                            : 'bg-[#e3f3ec] text-[#0f7366]'
                        }`}
                      >
                        {supp.due_status || (isDueNow ? 'Due now' : `Due in ${supp.due_days || 14}d`)}
                      </span>
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    {supp.phone && (
                      <a
                        href={`tel:${supp.phone}`}
                        className="flex items-center gap-1.5 rounded-xl border border-[#cbe1d7] px-3 py-1.5 text-xs font-bold text-[#145347] no-underline hover:bg-[#eef7f3] transition"
                      >
                        <Phone size={13} /> Call
                      </a>
                    )}

                    {supp.phone && (
                      <button
                        type="button"
                        onClick={() => handleWhatsAppNotify(supp)}
                        className="flex items-center gap-1.5 rounded-xl border border-[#cbe1d7] px-3 py-1.5 text-xs font-bold text-[#145347] hover:bg-[#eef7f3] transition"
                      >
                        <MessageCircle size={13} /> WhatsApp
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={() => setEditingCreditor(supp)}
                      className="flex items-center gap-1.5 rounded-xl border border-[#0e655d]/30 bg-[#f0f9f5] px-3.5 py-1.5 text-xs font-bold text-[#0e655d] hover:bg-[#e2f3ec] transition active:scale-95"
                      title="Admin edit supplier details"
                    >
                      <Edit3 size={13} />
                      <span>Edit</span>
                    </button>
                  </div>
                </article>
              )
            })
          ) : (
            <div className="rounded-3xl border border-[#e1e9e3] bg-white p-8 text-center">
              <p className="text-sm font-bold text-[#11382f]">No supplier accounts found</p>
              <p className="text-xs text-[#6e8a81] mt-1">
                Import Sundry Creditors from Tally XML to track payables.
              </p>
            </div>
          )}
        </div>

        {/* Admin Edit Modal for Creditors */}
        <AdminEditModal
          isOpen={Boolean(editingCreditor)}
          onClose={() => setEditingCreditor(null)}
          type="creditor"
          item={editingCreditor}
          onSaved={() => loadSuppliers()}
        />

      </main>
    </div>
  )
}
