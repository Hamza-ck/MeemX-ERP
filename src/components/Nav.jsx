import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Users,
  CreditCard,
  BarChart3,
  Box,
  MinusCircle,
  Banknote,
  Upload,
  UserCheck,
  Settings,
  Activity,
  SlidersHorizontal,
  LogOut,
  X,
  FileSpreadsheet,
  RefreshCw,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Nav() {
  const { isAdmin, user, role, shopName, signOut, syncCloudNow, cloudSyncStatus, cloudSyncError } = useAuth()
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)

  // Overview links matching PDF Page 5 & Page 11
  const overviewLinks = [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/debtors', label: 'Debtors', icon: Users },
    { to: '/creditors', label: 'Creditors', icon: CreditCard },
    { to: '/sales', label: 'Sales & Invoices', icon: BarChart3 },
    { to: '/inventory', label: 'Inventory', icon: Box },
    { to: '/expenses', label: 'Expenses', icon: MinusCircle },
    { to: '/loans', label: 'Loans & Advances', icon: Banknote },
  ]

  // Control links for Admin matching PDF Page 11 & Page 14
  const controlLinks = [
    { to: '/tally', label: 'Imports', icon: Upload },
    { to: '/settings?tab=users', label: 'Device PINs', icon: UserCheck },
    { to: '/settings', label: 'App settings', icon: Settings },
    { to: '/settings?tab=activity', label: 'Activity log', icon: Activity },
  ]

  const desktopLinkStyle = ({ isActive }) =>
    'flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-[13px] font-semibold transition-all duration-150 no-underline ' +
    (isActive
      ? 'bg-white/15 text-white font-bold shadow-xs'
      : 'text-[#bad4cb] hover:bg-white/10 hover:text-white')

  const mobileBottomLinkStyle = ({ isActive }) =>
    'flex flex-1 flex-col items-center justify-center py-1.5 px-2 rounded-2xl text-[10px] font-semibold transition no-underline ' +
    (isActive ? 'bg-[#dbeef4] text-[#0b5f55] font-bold shadow-xs' : 'text-[#58736a] hover:text-[#0b5f55]')

  const syncStatusLabel = {
    idle: 'Cloud sync is ready',
    syncing: 'Syncing cloud data…',
    synced: 'Cloud data is up to date',
    pending: 'Local changes are waiting for an administrator sync',
    error: cloudSyncError || 'Cloud sync needs attention',
  }[cloudSyncStatus] || 'Cloud sync is ready'

  return (
    <>
      {/* ================= DESKTOP SIDEBAR (PDF Page 5, 11, 13, 14) ================= */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-[#0b3832] px-4 py-5 text-white shadow-xl lg:flex">
        {/* Brand Header */}
        <div className="mb-6 flex items-center justify-between px-2">
          <NavLink to="/" className="flex items-center gap-3 text-white no-underline">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#0e7467] text-base font-extrabold text-white shadow-sm">
              {isAdmin ? 'B' : 'S'}
            </span>
            <div className="min-w-0">
              <strong className="block truncate text-[15px] font-bold tracking-tight text-white">
                {isAdmin ? 'Books Console' : shopName}
              </strong>
              <small className="block text-[11px] font-medium text-[#86b5a8]">
                {isAdmin ? 'Admin Console' : 'Owner view'}
              </small>
            </div>
          </NavLink>
        </div>

        {/* Navigation Groups */}
        <div className="flex-1 overflow-y-auto space-y-5 pr-1">
          {isAdmin && (
            <NavLink
              to="/tally"
              className="w-full flex items-center justify-center gap-2 rounded-2xl bg-[#0f7d6f] hover:bg-[#139181] text-white py-2.5 px-3 text-xs font-extrabold shadow-sm transition active:scale-98 no-underline"
            >
              <FileSpreadsheet size={16} strokeWidth={2.2} />
              <span>Tally XML Import</span>
            </NavLink>
          )}

          <div>
            <p className="mb-2 px-3 text-[10px] font-extrabold tracking-[1.2px] text-[#78a89a]">
              OVERVIEW
            </p>
            <nav className="grid gap-1">
              {overviewLinks.map((item) => {
                const Icon = item.icon
                return (
                  <NavLink key={item.to} to={item.to} end={item.end} className={desktopLinkStyle}>
                    <Icon size={17} strokeWidth={2.2} />
                    <span>{item.label}</span>
                  </NavLink>
                )
              })}
            </nav>
          </div>

          {isAdmin && (
            <div>
              <p className="mb-2 px-3 text-[10px] font-extrabold tracking-[1.2px] text-[#78a89a]">
                CONTROL
              </p>
              <nav className="grid gap-1">
                {controlLinks.map((item) => {
                  const Icon = item.icon
                  return (
                    <NavLink key={item.to} to={item.to} className={desktopLinkStyle}>
                      <Icon size={17} strokeWidth={2.2} />
                      <span>{item.label}</span>
                    </NavLink>
                  )
                })}
              </nav>
            </div>
          )}
        </div>

        {/* Footer info & Session */}
        <div className="mt-auto border-t border-white/10 pt-4">
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="truncate pr-2 text-[10px] text-[#86b5a8]" role="status" title={syncStatusLabel}>
              {cloudSyncStatus === 'synced' ? 'Cloud synced' : cloudSyncStatus === 'syncing' ? 'Syncing…' : cloudSyncStatus === 'pending' ? 'Changes pending' : cloudSyncStatus === 'error' ? 'Sync needs attention' : 'Cloud sync ready'}
            </span>
            <button
              type="button"
              onClick={() => syncCloudNow()}
              disabled={cloudSyncStatus === 'syncing'}
              className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold text-[#c8e7dc] hover:bg-white/10 disabled:opacity-60"
              title={syncStatusLabel}
            >
              <RefreshCw size={11} className={cloudSyncStatus === 'syncing' ? 'animate-spin' : ''} />
              Sync now
            </button>
          </div>
          <div className="flex items-center justify-between rounded-xl bg-white/5 p-2 text-xs">
            <div className="min-w-0 pr-2">
              <span className="block truncate font-bold text-white text-[12px]">
                {user?.name || 'Account'}
              </span>
              <span className="block text-[10px] text-[#89b3a6]">
                {role === 'admin' ? 'Admin' : role === 'employee' ? 'Employee · view only' : 'Owner · view only'}
              </span>
            </div>
            <button
              type="button"
              onClick={() => signOut()}
              className="grid h-7 w-7 place-items-center rounded-lg text-[#bad4cb] hover:bg-white/10 hover:text-white transition"
              title="Sign out"
            >
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* ================= MOBILE BOTTOM NAVIGATION (PDF Page 1, 2, 3, 7, 15, 16) ================= */}
      <nav
        className="fixed inset-x-4 bottom-3 z-40 flex items-center justify-around gap-1 rounded-full border border-white/80 bg-white/95 px-2 py-1.5 shadow-[0_12px_36px_rgba(11,56,50,0.18)] backdrop-blur-md lg:hidden"
        aria-label="Mobile navigation"
      >
        <NavLink to="/" end className={mobileBottomLinkStyle}>
          <LayoutDashboard size={19} strokeWidth={2.2} />
          <span>Home</span>
        </NavLink>
        <NavLink to="/debtors" className={mobileBottomLinkStyle}>
          <Users size={19} strokeWidth={2.2} />
          <span>Debtors</span>
        </NavLink>
        <NavLink to="/sales" className={mobileBottomLinkStyle}>
          <BarChart3 size={19} strokeWidth={2.2} />
          <span>Sales</span>
        </NavLink>
        <NavLink to="/inventory" className={mobileBottomLinkStyle}>
          <Box size={19} strokeWidth={2.2} />
          <span>Stock</span>
        </NavLink>
        {isAdmin ? (
          <NavLink to="/control" className={mobileBottomLinkStyle}>
            <SlidersHorizontal size={19} strokeWidth={2.2} />
            <span>Control</span>
          </NavLink>
        ) : (
          <button
            type="button"
            onClick={() => setMobileMoreOpen(true)}
            className="flex flex-1 flex-col items-center justify-center py-1.5 px-2 rounded-2xl text-[10px] font-semibold text-[#58736a] hover:text-[#0b5f55]"
          >
            <span className="text-base leading-none font-bold">•••</span>
            <span className="mt-0.5">More</span>
          </button>
        )}
      </nav>

      {/* Mobile "More" Drawer / Modal for Owner view */}
      {mobileMoreOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-xs lg:hidden"
          onClick={() => setMobileMoreOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-3xl bg-white p-5 pb-8 shadow-2xl animate-in slide-in-from-bottom"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1 w-12 rounded-full bg-[#d0ded6]" />
            <div className="flex items-center justify-between pb-3 border-b border-[#e5ece8]">
              <h3 className="text-sm font-bold text-[#143d35]">All Sections</h3>
              <button
                type="button"
                onClick={() => setMobileMoreOpen(false)}
                className="p-1 text-[#6c857d]"
              >
                <X size={18} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-4">
              <button
                type="button"
                onClick={() => syncCloudNow()}
                disabled={cloudSyncStatus === 'syncing'}
                title={syncStatusLabel}
                className="col-span-2 flex items-center justify-center gap-2 rounded-2xl border border-[#c5dfd6] bg-[#eff7f3] p-3 text-xs font-bold text-[#0e655d] disabled:opacity-60"
              >
                <RefreshCw size={16} className={cloudSyncStatus === 'syncing' ? 'animate-spin' : ''} />
                {cloudSyncStatus === 'syncing' ? 'Syncing…' : 'Sync cloud data'}
                <span className="sr-only">{syncStatusLabel}</span>
              </button>
              <NavLink
                to="/creditors"
                onClick={() => setMobileMoreOpen(false)}
                className="flex items-center gap-2.5 rounded-2xl border border-[#e1eae5] bg-[#f8faf8] p-3 text-xs font-bold text-[#1a443b] no-underline"
              >
                <CreditCard size={18} className="text-[#0d786d]" /> Creditors
              </NavLink>
              <NavLink
                to="/expenses"
                onClick={() => setMobileMoreOpen(false)}
                className="flex items-center gap-2.5 rounded-2xl border border-[#e1eae5] bg-[#f8faf8] p-3 text-xs font-bold text-[#1a443b] no-underline"
              >
                <MinusCircle size={18} className="text-[#b4622a]" /> Expenses
              </NavLink>
              <NavLink
                to="/loans"
                onClick={() => setMobileMoreOpen(false)}
                className="flex items-center gap-2.5 rounded-2xl border border-[#e1eae5] bg-[#f8faf8] p-3 text-xs font-bold text-[#1a443b] no-underline"
              >
                <Banknote size={18} className="text-[#0d786d]" /> Loans & Adv.
              </NavLink>
            </div>

            {isAdmin && (
              <NavLink
                to="/tally"
                onClick={() => setMobileMoreOpen(false)}
                className="mt-3 w-full flex items-center justify-center gap-2 rounded-2xl bg-[#0e655d] text-white p-3 text-xs font-extrabold shadow-xs transition active:scale-98 no-underline"
              >
                <FileSpreadsheet size={16} strokeWidth={2.2} />
                <span>Tally XML Import</span>
              </NavLink>
            )}
            <div className="mt-4 pt-3 border-t border-[#e5ece8] flex items-center justify-between">
              <span className="text-[11px] text-[#6e847c]">Signed in as {user?.name || 'Account'}</span>
              <button
                type="button"
                onClick={() => signOut()}
                className="flex items-center gap-1.5 text-xs font-bold text-[#ba3b2a]"
              >
                <LogOut size={14} /> Sign out
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  )
}
