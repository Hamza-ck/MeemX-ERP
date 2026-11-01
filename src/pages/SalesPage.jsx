import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  ArrowDownToLine,
  Receipt,
  Search,
  Edit3,
  FileSpreadsheet,
} from 'lucide-react'
import Nav from '../components/Nav'
import InvoicePrintModal from '../components/InvoicePrintModal'
import AdminEditModal from '../components/AdminEditModal'
import SalesBarChart from '../components/SalesBarChart'
import { accDb } from '../lib/accountingDb'
import { calculateSalesMetrics, computeDebtorAging } from '../lib/dashboardMetrics'

export default function SalesPage() {
  const navigate = useNavigate()
  const [selectedInvoice, setSelectedInvoice] = useState(null)
  const [editingInvoice, setEditingInvoice] = useState(null)
  const [search, setSearch] = useState('')
  const [invoices, setInvoices] = useState([])

  // Format date helper for invoice cards
  const formatInvoiceDate = (dateStr) => {
    if (!dateStr) return 'Today'
    try {
      const d = new Date(dateStr)
      if (isNaN(d.getTime())) return dateStr
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    } catch {
      return dateStr
    }
  }

  // Derive the 7-day summary from the same local-calendar metric helper as the dashboard.
  const { sales7Days, sales7DaysTotal } = useMemo(() => calculateSalesMetrics(invoices), [invoices])
  const formatChartMoney = (amount) => `₹${Number(amount || 0).toLocaleString('en-IN')}`

  // Load live invoices from Dexie DB
  const loadInvoices = useCallback(async () => {
    try {
      const [dbVouchers, parties] = await Promise.all([
        accDb.vouchers.where('voucher_type').anyOf('sales', 'credit_note').toArray(),
        accDb.parties.where('type').equals('debtor').toArray(),
      ])
      // Paid/Due comes from the debtor's live balance (receipts settle the oldest invoices first),
      // not from the due_amount frozen at invoice time, which never clears for credit sales.
      const { outstandingByVoucher, byParty } = computeDebtorAging(parties, dbVouchers)
      const partiesByName = new Map(parties.map((p) => [String(p.name).trim().toLowerCase(), p]))
      // Newest invoice first by DOCUMENT date — the local row id is just sync order.
      dbVouchers.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.voucher_no).localeCompare(String(a.voucher_no), undefined, { numeric: true }))

      if (dbVouchers && dbVouchers.length > 0) {
        const mapped = dbVouchers.map((v) => {
          const isCreditNote = v.voucher_type === 'credit_note'
          const knownParty = partiesByName.has(String(v.party_name).trim().toLowerCase()) && byParty.size > 0
          const outstanding = v.source_system === 'tally' && knownParty
            ? (outstandingByVoucher.get(v.id ?? v.voucher_no) || 0)
            : Number(v.due_amount) || 0
          const isDue = !isCreditNote && (outstanding > 0 || (!knownParty && v.status === 'Due'))
          return {
            ...v,
            outstanding,
            displayDate: v.displayDate || formatInvoiceDate(v.date),
            status: isCreditNote ? 'Return' : isDue ? 'Due' : 'Paid',
            statusTone: isCreditNote
              ? 'bg-[#eef1f6] text-[#4a5a78]'
              : isDue
              ? 'bg-[#fef3eb] text-[#c25e19]'
              : 'bg-[#e2f3ec] text-[#0d786d]',
          }
        })
        setInvoices(mapped)
      } else {
        setInvoices([])
      }
    } catch (err) {
      console.warn('Error fetching invoices from Dexie:', err)
      setInvoices([])
    }
  }, [])

  useEffect(() => {
    loadInvoices()

    const handleUpdate = () => {
      loadInvoices()
    }

    window.addEventListener('accounting-data-updated', handleUpdate)
    return () => {
      window.removeEventListener('accounting-data-updated', handleUpdate)
    }
  }, [loadInvoices])

  const filteredInvoices = useMemo(() => {
    if (!search.trim()) return invoices
    const q = search.toLowerCase()
    return invoices.filter(
      (inv) =>
        String(inv.voucher_no || '').toLowerCase().includes(q) ||
        String(inv.party_name || '').toLowerCase().includes(q) ||
        String(inv.party_uid || '').toLowerCase().includes(q)
    )
  }, [invoices, search])

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-28 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header with Back button and "+ New invoice" button (PDF Page 3) */}
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
              Sales
            </h1>
          </div>

          <button
            type="button"
            onClick={() => navigate('/tally')}
            className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
            title="Import vouchers directly from Tally XML / Excel"
          >
            <FileSpreadsheet size={16} strokeWidth={2.5} />
            <span>Tally import</span>
          </button>
        </header>

        {/* 7 Days Performance & Bar Chart (PDF Page 3) */}
        <section className="mb-6 rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs">
          <div className="flex items-start justify-between">
            <div>
              <span className="text-xs font-bold text-[#6a847c]">Last 7 days</span>
              <strong className="mt-1 block text-[34px] font-extrabold tracking-tight text-[#11382f]">
                {formatChartMoney(sales7DaysTotal)}
              </strong>
            </div>
            <span className="inline-flex items-center rounded-full bg-[#e2f3ec] px-3 py-1 text-xs font-bold text-[#0d786d]">
              Actual sales
            </span>
          </div>

          {/* Interactive Bar Chart */}
          <div className="mt-5 h-44 w-full">
            <SalesBarChart data={sales7Days} formatMoney={formatChartMoney} barColor="#8dc1b4" />
          </div>
        </section>

        {/* Recent Invoices Section Header (PDF Page 3) */}
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[17px] font-extrabold text-[#11382f]">
            Recent invoices
          </h2>
          <span className="text-xs font-medium text-[#6e8a81]">
            {filteredInvoices.length} invoices
          </span>
        </div>

        {/* Search Bar */}
        <div className="mb-3 flex items-center gap-2 rounded-2xl border border-[#dbe6df] bg-white px-3.5 py-2.5 shadow-2xs focus-within:border-[#0e655d] transition">
          <Search size={16} className="text-[#7c978f] shrink-0" />
          <input
            type="text"
            className="w-full bg-transparent text-xs font-semibold text-[#11382f] outline-none placeholder:text-[#88a098]"
            placeholder="Search invoice number, customer or UID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Invoice Items List (PDF Page 3) */}
        <div className="space-y-3">
          {filteredInvoices.length > 0 ? (
            filteredInvoices.map((inv) => (
              <article
                key={inv.id || inv.voucher_no}
                onClick={() => setSelectedInvoice(inv)}
                className="flex items-center justify-between rounded-3xl border border-[#e1e9e3] bg-white p-4 sm:p-5 shadow-xs transition hover:shadow-md cursor-pointer hover:border-[#ccdcd2]"
              >
                {/* Left Column: Number, Customer & Date */}
                <div className="min-w-0 pr-3">
                  <h3 className="truncate text-sm font-extrabold text-[#11382f]">
                    {inv.voucher_no} · {inv.party_name}
                  </h3>
                  <div className="mt-1 flex items-center gap-2 text-xs text-[#708c83]">
                    <span>{inv.displayDate || inv.date}</span>
                    {inv.party_uid && (
                      <span className="font-mono text-[10px] text-[#0d786d] font-bold">
                        · {inv.party_uid}
                      </span>
                    )}
                  </div>
                </div>

                {/* Right Column: Amount, Status & Download Button (PDF Page 3) */}
                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <strong className="block text-base font-extrabold text-[#11382f]">
                      ₹{Number(inv.amount || 0).toLocaleString('en-IN')}
                    </strong>
                    <span
                      className={`mt-0.5 inline-block rounded-md px-2 py-0.5 text-[11px] font-bold ${inv.statusTone}`}
                    >
                      {inv.status}
                    </span>
                  </div>

                  {/* Admin Edit button */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingInvoice(inv)
                    }}
                    className="grid h-10 w-10 place-items-center rounded-2xl bg-[#f0f9f5] border border-[#0e655d]/20 text-[#0e655d] hover:bg-[#e3f4ee] transition active:scale-95"
                    title="Admin edit invoice details"
                  >
                    <Edit3 size={16} strokeWidth={2.5} />
                  </button>

                  {/* Solid teal square download/arrow button matching PDF */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setSelectedInvoice(inv)
                    }}
                    className="grid h-10 w-10 place-items-center rounded-2xl bg-[#0e655d] text-white shadow-xs hover:bg-[#095049] transition active:scale-95"
                    title="View and print invoice"
                  >
                    <ArrowDownToLine size={18} strokeWidth={2.5} />
                  </button>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-3xl border border-[#e1e9e3] bg-white p-8 text-center">
              <Receipt size={32} className="mx-auto text-[#88a39b] mb-2" />
              <p className="text-sm font-bold text-[#11382f]">No invoices found</p>
              <p className="text-xs text-[#6e8a81] mt-1">
                Import day book or sales vouchers from Tally Integration.
              </p>
            </div>
          )}
        </div>

        {/* Tax Invoice Print & Share Modal */}
        <InvoicePrintModal
          isOpen={Boolean(selectedInvoice)}
          onClose={() => setSelectedInvoice(null)}
          invoice={selectedInvoice}
        />

        {/* Admin Edit Modal for Invoices & Vouchers */}
        <AdminEditModal
          isOpen={Boolean(editingInvoice)}
          onClose={() => setEditingInvoice(null)}
          type="voucher"
          item={editingInvoice}
          onSaved={() => loadInvoices()}
        />
      </main>
    </div>
  )
}
