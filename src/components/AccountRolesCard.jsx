import { useCallback, useEffect, useState } from 'react'
import { Check, Loader2, RefreshCw, Shield, UserPlus, Users } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function AccountRolesCard() {
  const { user, supabaseConfigured, listAccounts, changeAccountRole, createAccount } = useAuth()
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [feedback, setFeedback] = useState({ type: '', text: '' })
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    role: 'owner',
  })
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!supabaseConfigured || !user) return
    setLoading(true)
    try {
      const rows = await listAccounts()
      setAccounts(rows)
    } catch (err) {
      setFeedback({ type: 'error', text: err?.message || 'Could not load cloud accounts.' })
    } finally {
      setLoading(false)
    }
  }, [listAccounts, supabaseConfigured, user])

  useEffect(() => {
    load()
  }, [load])

  async function handleRoleChange(account, nextRole) {
    if (account.role === nextRole) return
    setBusyId(account.id)
    setFeedback({ type: '', text: '' })
    try {
      const updated = await changeAccountRole(account.id, nextRole)
      setAccounts((prev) =>
        prev.map((row) => (row.id === account.id ? { ...row, role: updated.role } : row))
      )
      setFeedback({
        type: 'ok',
        text: `${account.full_name || account.email} is now ${updated.role.toUpperCase()}.`,
      })
    } catch (err) {
      setFeedback({ type: 'error', text: err?.message || 'Role update failed.' })
    } finally {
      setBusyId('')
    }
  }

  async function handleCreate(e) {
    e.preventDefault()
    setCreating(true)
    setFeedback({ type: '', text: '' })
    try {
      await createAccount(form)
      setForm({ full_name: '', email: '', password: '', role: 'owner' })
      setShowCreate(false)
      await load()
      setFeedback({ type: 'ok', text: 'Cloud account created and role assigned.' })
    } catch (err) {
      setFeedback({ type: 'error', text: err?.message || 'Account creation failed.' })
    } finally {
      setCreating(false)
    }
  }

  if (!supabaseConfigured || !user) {
    return null
  }

  return (
    <div className="rounded-3xl border border-slate-800/80 bg-slate-900/50 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-amber-500/20 bg-amber-500/10 text-amber-400">
            <Users size={16} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-white">Cloud Accounts &amp; Role Assignment</h2>
            <p className="text-xs text-slate-500">
              Switch any user between <span className="text-amber-300 font-medium">Admin</span> (full control) and{' '}
              <span className="text-indigo-300 font-medium">Owner</span> (read-only live dashboard)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 hover:text-white transition"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 px-3.5 py-2 text-xs font-semibold text-white transition"
          >
            <UserPlus size={13} /> {showCreate ? 'Close' : 'New Account'}
          </button>
        </div>
      </div>

      {feedback.text && (
        <div
          className={`mb-4 rounded-xl border px-3.5 py-2.5 text-xs flex items-center gap-2 ${
            feedback.type === 'error'
              ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {feedback.type === 'ok' && <Check size={14} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-5 rounded-2xl border border-slate-800 bg-slate-950/70 p-4 grid grid-cols-1 sm:grid-cols-2 gap-3"
        >
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">Full Name</label>
            <input
              type="text"
              required
              value={form.full_name}
              onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
              placeholder="e.g. Managing Partner"
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">Email</label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="partner@company.com"
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">Temporary Password</label>
            <input
              type="password"
              required
              minLength={6}
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              placeholder="At least 6 characters"
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-400 mb-1">Assigned Role</label>
            <select
              value={form.role}
              onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 text-xs text-white focus:border-amber-500 focus:outline-none"
            >
              <option value="owner">Owner (Read-Only Dashboard)</option>
              <option value="admin">Admin (Full Control &amp; Tally Sync)</option>
            </select>
          </div>
          <div className="sm:col-span-2 flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="rounded-xl border border-slate-800 px-3.5 py-2 text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className="inline-flex items-center gap-1.5 rounded-xl bg-amber-600 hover:bg-amber-500 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Shield size={13} />}
              Create Account
            </button>
          </div>
        </form>
      )}

      <div className="divide-y divide-slate-800/70 rounded-2xl border border-slate-800/80 bg-slate-950/40">
        {accounts.length === 0 ? (
          <div className="p-4 text-xs text-slate-500 text-center">
            {loading ? 'Loading cloud accounts...' : 'No cloud user profiles found.'}
          </div>
        ) : (
          accounts.map((acc) => {
            const isSelf = acc.id === user.id
            const isBusy = busyId === acc.id
            return (
              <div
                key={acc.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-white truncate">
                      {acc.full_name || acc.email}
                    </p>
                    {isSelf && (
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-300">
                        You
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400 truncate">{acc.email}</p>
                </div>

                <div className="flex items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/90 p-1">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleRoleChange(acc, 'admin')}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                      acc.role === 'admin'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Admin
                  </button>
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleRoleChange(acc, 'owner')}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                      acc.role === 'owner'
                        ? 'bg-indigo-500/20 text-indigo-300 border border-indigo-500/30'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    Owner
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
