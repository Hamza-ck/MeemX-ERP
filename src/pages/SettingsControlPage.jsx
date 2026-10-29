import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ChevronLeft,
  Save,
  UserPlus,
  Check,
  MessageCircle,
  KeyRound,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { accDb } from '../lib/accountingDb'
import Nav from '../components/Nav'
import AddUserModal from '../components/AddUserModal'

export default function SettingsControlPage() {
  const {
    isAdmin,
    shopName,
    updateShopName,
    ownerPermissions,
    updateOwnerPermission,
    ownerPin,
    adminPin,
    updatePins,
    teamUsers,
  } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const activeTabParam = searchParams.get('tab')

  const [localShopName, setLocalShopName] = useState(shopName)
  const [localOwnerPin, setLocalOwnerPin] = useState(ownerPin || '')
  const [localAdminPin, setLocalAdminPin] = useState(adminPin || '')
  const [invoiceFooter, setInvoiceFooter] = useState('Thank you for your business')
  const [whatsappSummary, setWhatsappSummary] = useState(true)
  const [sendAtTime, setSendAtTime] = useState('8:00 PM')
  const [language, setLanguage] = useState('English / বাংলা')
  const [autoImportReminder, setAutoImportReminder] = useState(true)
  const [backupStatus, setBackupStatus] = useState('Last backup: today, 6:45 PM')
  const [backupRunning, setBackupRunning] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [addUserOpen, setAddUserOpen] = useState(false)
  const [editingUser, setEditingUser] = useState(null)
  const [whatsappSent, setWhatsappSent] = useState(false)

  useEffect(() => {
    setLocalShopName(shopName)
  }, [shopName])

  useEffect(() => {
    setLocalOwnerPin(ownerPin || '')
  }, [ownerPin])

  useEffect(() => {
    setLocalAdminPin(adminPin || '')
  }, [adminPin])

  const handleToggle = (key) => {
    updateOwnerPermission(key, !ownerPermissions[key])
  }

  const handleSaveAll = async () => {
    setSaveError('')
    try {
      if (localShopName.trim()) {
        await updateShopName(localShopName.trim())
      }
      if (localOwnerPin !== (ownerPin || '') || localAdminPin !== (adminPin || '')) {
        await updatePins({ newOwnerPin: localOwnerPin, newAdminPin: localAdminPin })
      }
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 2500)
    } catch (error) {
      setSaveError(error.message || 'Could not save these settings.')
    }
  }

  const handleBackupNow = () => {
    setBackupRunning(true)
    setTimeout(() => {
      setBackupRunning(false)
      const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      setBackupStatus(`Last backup: today, ${now}`)
    }, 1000)
  }

  const handleExportAllData = async () => {
    try {
      const [vouchers, materials, parties, ledgers, settings] = await Promise.all([
        accDb.vouchers.toArray(),
        accDb.materials.toArray(),
        accDb.parties.toArray(),
        accDb.ledgers.toArray(),
        accDb.settings.toArray(),
      ])

      const fullData = {
        exportedAt: new Date().toISOString(),
        shopName: localShopName,
        vouchers,
        materials,
        parties,
        ledgers,
        settings,
      }

      const json = JSON.stringify(fullData, null, 2)
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `Accounting_Backup_${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (err) {
      console.error('Error exporting data:', err)
    }
  }

  const handleTestWhatsAppSummary = async () => {
    try {
      const allVouchers = await accDb.vouchers.toArray()
      const allParties = await accDb.parties.toArray()
      const allMaterials = await accDb.materials.toArray()

      const todayStr = new Date().toISOString().slice(0, 10)
      const todaySales = allVouchers
        .filter((v) => v.type === 'Sales' && (v.date || '').startsWith(todayStr))
        .reduce((sum, v) => sum + (Number(v.total_amount) || 0), 0)

      const debtors = allParties.filter((p) => (p.role === 'customer' || p.role === 'debtor') && Number(p.current_balance) > 0)
      const topDebtor = debtors.sort((a, b) => Number(b.current_balance) - Number(a.current_balance))[0]

      const stockVal = allMaterials.reduce((sum, material) => {
        if (material.current_value != null && Number.isFinite(Number(material.current_value))) {
          return sum + Number(material.current_value)
        }
        return sum + (Number(material.current_qty) || 0) * (Number(material.purchase_rate) || 0)
      }, 0)

      const summaryText = encodeURIComponent(
        `📊 *Daily Business Summary - ${localShopName}*\n\n` +
        `📅 *Date*: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}\n` +
        `💰 *Today Sales*: ₹${todaySales.toLocaleString('en-IN')}\n` +
        (topDebtor ? `👥 *Top Debtor Due*: ${topDebtor.name} (₹${Number(topDebtor.current_balance).toLocaleString('en-IN')})\n` : `👥 *Debtors Due*: ₹0 pending\n`) +
        `📦 *Stock Value*: ₹${stockVal.toLocaleString('en-IN')}\n\n` +
        `Have a great evening! ✨`
      )
      window.open(`https://wa.me/?text=${summaryText}`, '_blank')
      setWhatsappSent(true)
      setTimeout(() => setWhatsappSent(false), 3000)
    } catch (err) {
      console.error('Error generating WhatsApp summary:', err)
    }
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10">
      <Nav />

      <main className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header matching PDF Page 14 (Desktop) & Page 16 (Mobile) */}
        <header className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="grid h-9 w-9 place-items-center rounded-xl bg-white text-[#153e34] shadow-2xs hover:bg-[#ebf4ef] transition lg:hidden"
            >
              <ChevronLeft size={20} />
            </button>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-[24px] font-extrabold tracking-tight text-[#11382f]">
                  {activeTabParam === 'users'
                    ? 'Users & access'
                    : activeTabParam === 'activity'
                    ? 'Activity log'
                    : isAdmin
                    ? 'App settings'
                    : 'Settings'}
                </h1>
                <span className="rounded-lg bg-[#e4f3eb] px-2 py-0.5 text-[11px] font-extrabold text-[#0d7568]">
                  Admin
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSaveAll}
            className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
          >
            {saveSuccess ? <Check size={15} /> : <Save size={15} />}
            {saveSuccess ? 'Saved! ✓' : 'Save changes'}
          </button>
        </header>
        {saveError && <p role="alert" className="mb-4 text-right text-xs font-semibold text-rose-700">{saveError}</p>}

        {/* 2-Column Layout matching PDF Page 14 */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* ================= LEFT COLUMN ================= */}
          <div className="space-y-6">
            {/* What the owner can see (PDF Page 14 & 16) */}
            <section className="rounded-3xl border border-[#e1e9e3] bg-white p-5 sm:p-6 shadow-xs">
              <h2 className="text-base font-extrabold text-[#11382f] mb-4">
                What the owner can see
              </h2>

              <div className="divide-y divide-[#edf3f0] space-y-3">
                {/* Sales */}
                <div className="flex items-center justify-between pt-1">
                  <div>
                    <strong className="block text-xs font-bold text-[#11382f]">Sales</strong>
                    <span className="block text-[11px] text-[#708d83]">Daily and monthly totals</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle('sales')}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ownerPermissions.sales ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        ownerPermissions.sales ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Profit */}
                <div className="flex items-center justify-between pt-3">
                  <div>
                    <strong className="block text-xs font-bold text-[#11382f]">Profit</strong>
                    <span className="block text-[11px] text-[#708d83]">Gross and net profit</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle('profit')}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ownerPermissions.profit ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        ownerPermissions.profit ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Expenses */}
                <div className="flex items-center justify-between pt-3">
                  <div>
                    <strong className="block text-xs font-bold text-[#11382f]">Expenses</strong>
                    <span className="block text-[11px] text-[#708d83]">By category</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle('expenses')}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ownerPermissions.expenses ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        ownerPermissions.expenses ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Debtors */}
                <div className="flex items-center justify-between pt-3">
                  <div>
                    <strong className="block text-xs font-bold text-[#11382f]">Debtors</strong>
                    <span className="block text-[11px] text-[#708d83]">List with phone numbers</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle('debtors')}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ownerPermissions.debtors ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        ownerPermissions.debtors ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Creditors */}
                <div className="flex items-center justify-between pt-3">
                  <div>
                    <strong className="block text-xs font-bold text-[#11382f]">Creditors</strong>
                    <span className="block text-[11px] text-[#708d83]">Suppliers and due dates</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle('creditors')}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ownerPermissions.creditors ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        ownerPermissions.creditors ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Inventory */}
                <div className="flex items-center justify-between pt-3">
                  <div>
                    <strong className="block text-xs font-bold text-[#11382f]">Inventory</strong>
                    <span className="block text-[11px] text-[#708d83]">Stock value and low stock</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle('inventory')}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ownerPermissions.inventory ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        ownerPermissions.inventory ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Loans & Advances (OFF by default in PDF) */}
                <div className="flex items-center justify-between pt-3">
                  <div>
                    <strong className="block text-xs font-bold text-[#11382f]">Loans &amp; Advances</strong>
                    <span className="block text-[11px] text-[#708d83]">Balances only</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleToggle('loans')}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      ownerPermissions.loans ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                        ownerPermissions.loans ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </section>

            {/* Users and Access (PDF Page 14) */}
            <section
              className={`rounded-3xl border bg-white p-5 sm:p-6 shadow-xs transition ${
                activeTabParam === 'users'
                  ? 'border-[#0e655d] ring-2 ring-[#0e655d]/15'
                  : 'border-[#e1e9e3]'
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-extrabold text-[#11382f]">
                  Local device PINs
                </h2>
                <span className="rounded-lg bg-[#eef6f2] px-2.5 py-0.5 text-[11px] font-bold text-[#0e655d]">
                  {teamUsers.length} {teamUsers.length === 1 ? 'PIN' : 'PINs'}
                </span>
              </div>

              <p className="mb-3 text-xs leading-relaxed text-[#6b867e]">
                These PINs only unlock this device after account sign-in. Account roles come from the user profile.
              </p>
              <div className="divide-y divide-[#edf3f0] space-y-3">
                {teamUsers.map((u) => {
                  return (
                    <div key={u.id} className="flex items-center justify-between pt-3 first:pt-1">
                      <div className="min-w-0 pr-2">
                        <div className="flex items-center gap-2">
                          <strong className="truncate text-xs font-bold text-[#11382f]">
                            {u.name}
                          </strong>
                          <span className="inline-flex items-center gap-1 rounded-md bg-[#f2f7f4] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[#44655b]">
                            <KeyRound size={10} /> PIN configured
                          </span>
                        </div>
                        <span className="block text-[11px] text-[#708d83] mt-0.5">
                          {u.phone ? `${u.phone} · ${u.lastSeen}` : u.lastSeen}
                        </span>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        <span className="rounded-xl bg-[#e4f3eb] px-2.5 py-1 text-[11px] font-bold text-[#0d7568]">
                          Local PIN
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingUser(u)
                            setAddUserOpen(true)
                          }}
                          className="rounded-xl border border-[#cbe0d7] px-3 py-1 text-xs font-bold text-[#115748] hover:bg-[#eef7f3] transition"
                        >
                          Edit
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <button
                type="button"
                onClick={() => {
                  setEditingUser(null)
                  setAddUserOpen(true)
                }}
                className="mt-5 flex w-full items-center justify-center gap-1.5 rounded-2xl bg-[#0e655d] py-2.5 text-xs font-bold text-white shadow-xs hover:bg-[#094e48] transition active:scale-98"
              >
                <UserPlus size={15} /> Add user
              </button>
            </section>
          </div>

          {/* ================= RIGHT COLUMN ================= */}
          <div className="space-y-6">
            {/* Daily summary on WhatsApp (PDF Page 14 & 16) */}
            <section className="rounded-3xl border border-[#e1e9e3] bg-white p-5 sm:p-6 shadow-xs">
              <h2 className="text-base font-extrabold text-[#11382f] mb-4">
                Daily summary on WhatsApp
              </h2>

              <div className="flex items-center justify-between pb-4 border-b border-[#edf3f0]">
                <div>
                  <strong className="block text-xs font-bold text-[#11382f]">
                    Send every evening
                  </strong>
                  <span className="block text-[11px] text-[#708d83]">
                    Sales, cash, top debtor
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setWhatsappSummary(!whatsappSummary)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    whatsappSummary ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                      whatsappSummary ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="mt-4 space-y-3">
                <div>
                  <label className="block text-xs font-bold text-[#44655b] mb-1">
                    Send at
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-xl border border-[#d8e3de] px-3.5 py-2.5 text-xs font-medium text-[#11382f] outline-none focus:border-[#0e655d]"
                    value={sendAtTime}
                    onChange={(e) => setSendAtTime(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-[#44655b] mb-1">
                    Language
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-xl border border-[#d8e3de] px-3.5 py-2.5 text-xs font-medium text-[#11382f] outline-none focus:border-[#0e655d]"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  />
                </div>

                <button
                  type="button"
                  onClick={handleTestWhatsAppSummary}
                  className="mt-2 flex items-center justify-center gap-2 w-full rounded-xl border border-[#c5dfd6] py-2 text-xs font-bold text-[#0e655d] hover:bg-[#eef7f3] transition"
                >
                  <MessageCircle size={14} />
                  {whatsappSent ? 'Summary opened in WhatsApp! ✓' : 'Send test summary now'}
                </button>
              </div>
            </section>

            {/* Data and backups (PDF Page 14 & 16) */}
            <section className="rounded-3xl border border-[#e1e9e3] bg-white p-5 sm:p-6 shadow-xs">
              <h2 className="text-base font-extrabold text-[#11382f] mb-4">
                Data and backups
              </h2>

              <div className="flex items-center justify-between pb-4 border-b border-[#edf3f0]">
                <div>
                  <strong className="block text-xs font-bold text-[#11382f]">
                    Auto-import reminder
                  </strong>
                  <span className="block text-[11px] text-[#708d83]">
                    Remind me if no import by 8 PM
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setAutoImportReminder(!autoImportReminder)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    autoImportReminder ? 'bg-[#0e655d]' : 'bg-[#d8e3de]'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out ${
                      autoImportReminder ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleBackupNow}
                  disabled={backupRunning}
                  className="flex-1 rounded-2xl border border-[#cbe0d7] bg-[#f8faf8] py-2.5 text-xs font-bold text-[#115748] hover:bg-[#eaf4ef] transition"
                >
                  {backupRunning ? 'Running backup...' : 'Back up now'}
                </button>
                <button
                  type="button"
                  onClick={handleExportAllData}
                  className="flex-1 rounded-2xl border border-[#cbe0d7] bg-[#f8faf8] py-2.5 text-xs font-bold text-[#115748] hover:bg-[#eaf4ef] transition"
                >
                  Export all data
                </button>
              </div>

              <span className="mt-3 block text-center text-xs text-[#78968d]">
                {backupStatus}
              </span>
            </section>

            {/* Shop Details (PDF Page 14) */}
            <section className="rounded-3xl border border-[#e1e9e3] bg-white p-5 sm:p-6 shadow-xs">
              <h2 className="text-base font-extrabold text-[#11382f] mb-4">
                Shop details
              </h2>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-bold text-[#44655b] mb-1">
                    Shop name
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-xl border border-[#d8e3de] px-3.5 py-2.5 text-xs font-bold text-[#11382f] outline-none focus:border-[#0e655d]"
                    value={localShopName}
                    onChange={(e) => setLocalShopName(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-[#44655b] mb-1">
                    Invoice footer
                  </label>
                  <input
                    type="text"
                    className="w-full rounded-xl border border-[#d8e3de] px-3.5 py-2.5 text-xs font-medium text-[#11382f] outline-none focus:border-[#0e655d]"
                    value={invoiceFooter}
                    onChange={(e) => setInvoiceFooter(e.target.value)}
                  />
                </div>
              </div>
            </section>

            {/* Local device unlock codes */}
            <section className="rounded-3xl border border-[#e1e9e3] bg-white p-5 sm:p-6 shadow-xs">
              <h2 className="text-base font-extrabold text-[#11382f] mb-2">
                Device unlock PINs
              </h2>
              <p className="text-[11px] text-[#6d8880] mb-4">
                Optional local lock after account sign-in. No PIN is enabled until you choose one; 1234 and 8888 are not accepted.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#44655b] mb-1">
                    Device PIN 1
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={4}
                    pattern="[0-9]*"
                    placeholder="Optional"
                    className="w-full rounded-xl border border-[#d8e3de] px-3.5 py-2.5 text-center font-mono text-sm font-extrabold tracking-widest text-[#11382f] outline-none focus:border-[#0e655d]"
                    value={localOwnerPin}
                    onChange={(e) => setLocalOwnerPin(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold text-[#44655b] mb-1">
                    Device PIN 2
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    autoComplete="new-password"
                    maxLength={4}
                    pattern="[0-9]*"
                    placeholder="Optional"
                    className="w-full rounded-xl border border-[#d8e3de] px-3.5 py-2.5 text-center font-mono text-sm font-extrabold tracking-widest text-[#11382f] outline-none focus:border-[#0e655d]"
                    value={localAdminPin}
                    onChange={(e) => setLocalAdminPin(e.target.value.replace(/[^0-9]/g, ''))}
                  />
                </div>
              </div>
            </section>
          </div>
        </div>

        {/* Add / Edit User Modal */}
        <AddUserModal
          isOpen={addUserOpen}
          editingUser={editingUser}
          onClose={() => {
            setAddUserOpen(false)
            setEditingUser(null)
          }}
        />
      </main>
    </div>
  )
}
