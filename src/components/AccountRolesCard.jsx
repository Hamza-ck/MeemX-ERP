import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck, UserPlus } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const ROLE_LABEL = { admin: 'Admin · full access', owner: 'Owner · view only', employee: 'Employee · view only' }

/**
 * The accounts that can actually sign in, with their REAL role (profiles.role).
 * The "Local device PINs" card below only locks a device and never carries a role.
 */
export default function AccountRolesCard() {
  const { user, listAccounts, changeAccountRole, createAccount } = useAuth()
  const [accounts, setAccounts] = useState([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busyId, setBusyId] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', fullName: '', role: 'owner' })

  const load = useCallback(async () => {
    try { setAccounts(await listAccounts()); setError('') } catch (err) { setError(err.message) }
  }, [listAccounts])

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [])

  const onRoleChange = async (account, role) => {
    setBusyId(account.id); setError(''); setNotice('')
    try {
      await changeAccountRole(account.id, role)
      setNotice(`${account.full_name || 'Account'} is now ${ROLE_LABEL[role]}. Their open session updates within a minute.`)
      await load()
    } catch (err) { setError(err.message) } finally { setBusyId('') }
  }

  const onCreate = async (event) => {
    event.preventDefault()
    setError(''); setNotice(''); setBusyId('new')
    try {
      await createAccount(form)
      setNotice(`Account created for ${form.email}.`)
      setForm({ email: '', password: '', fullName: '', role: 'owner' })
      setAdding(false)
      await load()
    } catch (err) { setError(err.message) } finally { setBusyId('') }
  }

  return (
    <section className="mb-5 rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-extrabold text-[#11382f]"><ShieldCheck size={17} /> Accounts &amp; roles</h2>
        <button type="button" onClick={() => setAdding((v) => !v)} className="flex items-center gap-1 rounded-xl border border-[#cbe0d7] px-3 py-1 text-xs font-bold text-[#115748] hover:bg-[#eef7f3]">
          <UserPlus size={13} /> Add account
        </button>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-[#6b867e]">These are the sign-in accounts. A role change here is the real one and reaches that person's devices.</p>
      {error && <p role="alert" className="mb-2 text-xs font-semibold text-rose-700">{error}</p>}
      {notice && <p role="status" className="mb-2 text-xs font-semibold text-[#0d7568]">{notice}</p>}

      {adding && (
        <form onSubmit={onCreate} className="mb-4 grid gap-2 rounded-2xl bg-[#f4f8f6] p-3">
          <input required type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="rounded-xl border border-[#cbe0d7] px-3 py-2 text-xs" />
          <input required minLength={6} type="password" placeholder="Temporary password (6+ characters)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="rounded-xl border border-[#cbe0d7] px-3 py-2 text-xs" />
          <input placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} className="rounded-xl border border-[#cbe0d7] px-3 py-2 text-xs" />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="rounded-xl border border-[#cbe0d7] px-3 py-2 text-xs">
            {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button disabled={busyId === 'new'} className="rounded-xl bg-[#0e655d] py-2 text-xs font-bold text-white disabled:opacity-60">{busyId === 'new' ? 'Creating…' : 'Create account'}</button>
        </form>
      )}

      <ul className="divide-y divide-[#edf3f0]">
        {accounts.map((account) => (
          <li key={account.id} className="flex items-center justify-between gap-2 py-2.5">
            <span className="min-w-0 truncate text-xs font-bold text-[#11382f]">
              {account.full_name || account.id.slice(0, 8)}{account.id === user?.id ? ' (you)' : ''}
            </span>
            <select
              aria-label={`Role for ${account.full_name || account.id}`}
              value={account.role}
              disabled={busyId === account.id}
              onChange={(e) => onRoleChange(account, e.target.value)}
              className="rounded-xl border border-[#cbe0d7] bg-white px-2 py-1 text-xs font-bold text-[#115748]"
            >
              {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </li>
        ))}
      </ul>
    </section>
  )
}
