import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  Search,
  Phone,
  MessageCircle,
  FileSpreadsheet,
  Edit3,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { accDb } from '../lib/accountingDb'
import { computeDebtorAging } from '../lib/dashboardMetrics'
import Nav from '../components/Nav'
import AdminEditModal from '../components/AdminEditModal'

export default function DebtorsPage() {
  const { shopName, isAdmin } = useAuth()
  const navigate = useNavigate()
  const [searchTerm, setSearchTerm] = useState('')
  const [customers, setCustomers] = useState([])
  const [vouchers, setVouchers] = useState([])
  const [whatsappSent, setWhatsappSent] = useState(null)
  const [callModal, setCallModal] = useState(null)
  const [editingDebtor, setEditingDebtor] = useState(null)

  // Load debtors & vouchers from Dexie DB
  const loadDebtors = useCallback(async () => {
    try {
      const [dbDebtors, dbVouchers] = await Promise.all([
        accDb.parties.where('type').equals('debtor').toArray(),
        accDb.vouchers.toArray(),
      ])
      setCustomers(dbDebtors || [])
      setVouchers(dbVouchers || [])
    } catch {
      setCustomers([])
      setVouchers([])
    }
  }, [])

  useEffect(() => {
    loadDebtors()
    const onUpdate = () => loadDebtors()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadDebtors])

  // Real invoice-based aging breakdown (0–30d, 31–60d, 60d+)
  const agingStats = useMemo(() => {
    return computeDebtorAging(customers, vouchers)
  }, [customers, vouchers])

  const totalOwed = agingStats.totalOwed

  const filteredCustomers = useMemo(() => {
    const list = agingStats.enrichedDebtors
    if (!searchTerm.trim()) return list
    const term = searchTerm.toLowerCase()
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        (c.phone && c.phone.includes(term)) ||
        (c.uid && c.uid.toLowerCase().includes(term))
    )
  }, [agingStats.enrichedDebtors, searchTerm])

  const handleCall = (cust) => {
    setCallModal(cust)
  }

  const handleWhatsApp = (cust) => {
    const balStr = `₹${(Number(cust.current_balance) || 0).toLocaleString('en-IN')}`
    const text = encodeURIComponent(
      `Dear ${cust.name}, polite payment reminder from ${shopName || 'Shop'} regarding your outstanding balance of ${balStr} (aging ${cust.age_bucket || 'due'}). Kindly arrange transfer or settlement. Thank you!`
    )
    window.open(`https://wa.me/${(cust.phone || '').replace(/[^0-9]/g, '')}?text=${text}`, '_blank')
    setWhatsappSent(cust.id)
    setTimeout(() => setWhatsappSent(null), 3500)
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Bar with Back Button & Tally Import (PDF Page 2) */}
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
              Debtors
            </h1>
          </div>

          {isAdmin && (
            <button
              type="button"
              onClick={() => navigate('/tally')}
              className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
              title="Import debtors and closing balances from Tally"
            >
              <FileSpreadsheet size={16} strokeWidth={2.5} />
              <span>Tally import</span>
            </button>
          )}
        </header>

        {/* Total Owed Card & 3-segment Aging Progress Bar (PDF Page 2) */}
        <div className="mb-5 rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs">
          <span className="text-xs font-bold text-[#627d75]">Total owed to you</span>
          <strong className="mt-1 block text-[34px] font-extrabold tracking-tight text-[#0e655d]">
            ₹{(totalOwed / 100000).toFixed(1)}L
          </strong>

          {/* 3-segment horizontal progress bar matching PDF */}
          <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-[#e8ecea]">
            <div
              className="bg-[#0e655d] transition-all"
              style={{ width: agingStats.p1 }}
              title={`0–30d: ₹${(agingStats.cat0to30 / 100000).toFixed(1)}L`}
            />
            <div
              className="bg-[#3b9b8b] transition-all"
              style={{ width: agingStats.p2 }}
              title={`31–60d: ₹${(agingStats.cat31to60 / 100000).toFixed(1)}L`}
            />
            <div
              className="bg-[#c25e19] transition-all"
              style={{ width: agingStats.p3 }}
              title={`60d+: ₹${(agingStats.cat60plus / 100000).toFixed(1)}L`}
            />
          </div>

          {/* Aging labels matching PDF */}
          <div className="mt-3 flex items-center justify-between text-xs font-bold">
            <span className="flex items-center gap-1.5 text-[#0e655d]">
              <span className="h-2 w-2 rounded-full bg-[#0e655d]" />
              0–30d ₹{(agingStats.cat0to30 / 100000).toFixed(1)}L
            </span>
            <span className="flex items-center gap-1.5 text-[#2b7f71]">
              <span className="h-2 w-2 rounded-full bg-[#3b9b8b]" />
              31–60d ₹{(agingStats.cat31to60 / 100000).toFixed(1)}L
            </span>
            <span className="flex items-center gap-1.5 text-[#c25e19]">
              <span className="h-2 w-2 rounded-full bg-[#c25e19]" />
              60d+ ₹{(agingStats.cat60plus / 100000).toFixed(1)}L
            </span>
          </div>
        </div>

        {/* Search Customer or Phone (PDF Page 2) */}
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-[#dbe6df] bg-white px-3.5 py-2.5 shadow-2xs focus-within:border-[#0e655d] transition">
          <Search size={18} className="text-[#7c978f] shrink-0" />
          <input
            type="text"
            className="w-full bg-transparent text-xs font-semibold text-[#11382f] outline-none placeholder:text-[#88a098]"
            placeholder="Search customer, phone or permanent UID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {/* Customer Cards List matching PDF Page 2 */}
        <div className="space-y-3">
          {filteredCustomers.length > 0 ? (
            filteredCustomers.map((cust) => {
              const bal = Number(cust.current_balance) || 0
              const age = cust.age_bucket || '0–30d'
              const isCritical = age === '60d+'

              return (
                <article
                  key={cust.id || cust.name}
                  className="rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs transition hover:shadow-md"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-[17px] font-extrabold text-[#11382f]">
                          {cust.name}
                        </h2>
                        {cust.uid && (
                          <span className="font-mono text-[10px] text-[#0d786d] font-extrabold bg-[#e4f3eb] px-1.5 py-0.5 rounded">
                            {cust.uid}
                          </span>
                        )}
                      </div>
                      <span className="mt-0.5 block text-xs text-[#718d84]">
                        Last invoice {cust.last_invoice || 'Recent'}
                      </span>
                    </div>

                    <div className="text-right">
                      <strong className="block text-[18px] font-extrabold text-[#11382f]">
                        ₹{bal.toLocaleString('en-IN')}
                      </strong>
                      <span
                        className={`mt-1 inline-block rounded-md px-2.5 py-0.5 text-[11px] font-bold ${
                          isCritical
                            ? 'bg-[#feeae6] text-[#b73725]'
                            : age === '31–60d'
                            ? 'bg-[#e2f3ec] text-[#0d786d]'
                            : 'bg-[#e4f1eb] text-[#146b60]'
                        }`}
                      >
                        {age}
                      </span>
                    </div>
                  </div>

                  {/* Call, WhatsApp & Collect Dues Actions */}
                  <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                    {cust.phone && (
                      <button
                        type="button"
                        onClick={() => handleCall(cust)}
                        className="flex items-center gap-1.5 rounded-xl border border-[#cbe1d7] bg-white px-3 py-1.5 text-xs font-bold text-[#145347] hover:bg-[#eef7f3] transition"
                      >
                        <Phone size={13} />
                        <span>Call</span>
                      </button>
                    )}

                    {cust.phone && (
                      <button
                        type="button"
                        onClick={() => handleWhatsApp(cust)}
                        className="flex items-center gap-1.5 rounded-xl bg-[#0e655d] px-3.5 py-1.5 text-xs font-bold text-white shadow-2xs hover:bg-[#0a4f49] transition active:scale-95"
                      >
                        <MessageCircle size={13} />
                        <span>
                          {whatsappSent === cust.id ? 'Reminder sent ✓' : 'WhatsApp reminder'}
                        </span>
                      </button>
                    )}

                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => setEditingDebtor(cust)}
                        className="flex items-center gap-1.5 rounded-xl border border-[#0e655d]/30 bg-[#f0f9f5] px-3.5 py-1.5 text-xs font-bold text-[#0e655d] hover:bg-[#e2f3ec] transition active:scale-95"
                        title="Admin edit debtor details"
                      >
                        <Edit3 size={13} />
                        <span>Edit</span>
                      </button>
                    )}
                  </div>
                </article>
              )
            })
          ) : (
            <div className="rounded-3xl border border-[#e1e9e3] bg-white p-8 text-center">
              <p className="text-sm font-bold text-[#11382f]">No debtor accounts found</p>
              <p className="text-xs text-[#6e8a81] mt-1">
                Import customer ledgers or day book from Tally to populate debtors.
              </p>
            </div>
          )}
        </div>

        {/* Admin Edit Modal for Debtors */}
        <AdminEditModal
          isOpen={Boolean(editingDebtor)}
          onClose={() => setEditingDebtor(null)}
          type="debtor"
          item={editingDebtor}
          onSaved={() => loadDebtors()}
        />

        {/* Modal: Call Dialog */}
        {callModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs"
            onClick={() => setCallModal(null)}
          >
            <div
              className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between pb-3 border-b border-[#e5ebe7]">
                <h3 className="text-base font-extrabold text-[#11382f]">Call Customer</h3>
                <button
                  type="button"
                  onClick={() => setCallModal(null)}
                  className="text-[#6d8a81]"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="mt-4 text-center">
                <span className="block text-xs text-[#6e8a81]">Customer</span>
                <strong className="block text-lg font-bold text-[#11382f]">
                  {callModal.name}
                </strong>
                <span className="text-sm font-semibold text-[#0d786d]">
                  {callModal.phone}
                </span>
                <div className="mt-3 rounded-2xl bg-[#f7faf8] p-3 text-xs text-[#527267]">
                  Outstanding balance: <strong>₹{Number(callModal.current_balance).toLocaleString('en-IN')}</strong> ({callModal.age_bucket})
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCallModal(null)}
                  className="rounded-xl border border-[#d6e2dd] py-2.5 text-xs font-bold text-[#55736a]"
                >
                  Cancel
                </button>
                <a
                  href={`tel:${callModal.phone}`}
                  className="rounded-xl bg-[#0e655d] py-2.5 text-center text-xs font-bold text-white shadow-xs no-underline flex items-center justify-center gap-1.5"
                >
                  <Phone size={14} /> Call now
                </a>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
