import { useState, useEffect } from 'react'
import {
  UserPlus,
  X,
  User,
  Phone,
  KeyRound,
  Sparkles,
  Trash2,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function AddUserModal({
  isOpen,
  onClose,
  editingUser = null,
  onSuccess,
}) {
  const { teamUsers, saveTeamUser, removeTeamUser } = useAuth()

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [role, setRole] = useState('owner') // 'owner' | 'employee' | 'admin'
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    setError('')
    if (editingUser) {
      setName(editingUser.name || '')
      setPhone(editingUser.phone || '')
      setRole(editingUser.role === 'admin' ? 'admin' : editingUser.role === 'employee' ? 'employee' : 'owner')
      setPin(editingUser.pin || '')
    } else {
      setName('')
      setPhone('+91 ')
      setRole('owner')
      // Generate a unique 4-digit PIN not currently in use
      const usedPins = new Set(teamUsers.map((u) => String(u.pin)))
      let candidate = '2468'
      while (usedPins.has(candidate)) {
        candidate = String(Math.floor(1000 + Math.random() * 9000))
      }
      setPin(candidate)
    }
  }, [isOpen, editingUser, teamUsers])

  if (!isOpen) return null

  const generateRandomPin = () => {
    const usedPins = new Set(
      teamUsers
        .filter((u) => u.id !== editingUser?.id)
        .map((u) => String(u.pin))
    )
    let candidate = String(Math.floor(1000 + Math.random() * 9000))
    while (usedPins.has(candidate)) {
      candidate = String(Math.floor(1000 + Math.random() * 9000))
    }
    setPin(candidate)
    setError('')
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')

    const cleanName = name.trim()
    const cleanPin = pin.replace(/[^0-9]/g, '').trim()

    if (!cleanName) {
      setError('Please enter the user’s name.')
      return
    }

    if (cleanPin.length !== 4) {
      setError('Please enter a valid 4-digit numeric PIN.')
      return
    }

    // Check if another user already uses this PIN
    const conflictingUser = teamUsers.find(
      (u) => u.id !== editingUser?.id && String(u.pin) === cleanPin
    )
    if (conflictingUser) {
      setError(`PIN ${cleanPin} is already assigned to ${conflictingUser.name}. Choose a different 4-digit PIN.`)
      return
    }

    setSaving(true)
    try {
      const savedList = await saveTeamUser({
        id: editingUser?.id,
        name: cleanName,
        phone: phone.trim(),
        role,
        pin: cleanPin,
      })
      if (onSuccess) {
        onSuccess(savedList)
      }
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save user.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!editingUser?.id) return
    await removeTeamUser(editingUser.id)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-3xl border border-[#e1e9e3] bg-white p-6 sm:p-7 shadow-[0_24px_64px_rgba(14,101,93,0.16)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[#edf3f0]">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#e3f4ee] text-[#0e655d] shrink-0">
              <UserPlus size={20} strokeWidth={2.3} />
            </div>
            <div>
              <h3 className="text-[17px] font-extrabold tracking-tight text-[#11382f]">
                {editingUser ? 'Edit Local PIN' : 'Add Local PIN'}
              </h3>
              <p className="text-xs text-[#6b867e]">
                {editingUser
                  ? 'Update the local 4-digit unlock PIN'
                  : 'Add a local PIN for this device'}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-1.5 text-[#6d8a81] hover:bg-[#f0f6f3] hover:text-[#11382f] transition"
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {/* Full Name */}
          <div>
            <label className="block text-xs font-bold text-[#143d35] mb-1.5">
              Full name <span className="text-[#c25e19]">*</span>
            </label>
            <div className="flex items-center gap-2.5 rounded-2xl border border-[#d8e3de] bg-[#fafcfb] px-3.5 py-2.5 focus-within:border-[#0e655d] focus-within:bg-white transition">
              <User size={16} className="text-[#78968d] shrink-0" />
              <input
                type="text"
                required
                placeholder="e.g. A. Sharma"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-transparent text-xs font-bold text-[#11382f] outline-none placeholder:font-normal placeholder:text-[#8ea59d]"
              />
            </div>
          </div>

          {/* WhatsApp / Phone Number */}
          <div>
            <label className="block text-xs font-bold text-[#143d35] mb-1.5">
              WhatsApp / phone number
            </label>
            <div className="flex items-center gap-2.5 rounded-2xl border border-[#d8e3de] bg-[#fafcfb] px-3.5 py-2.5 focus-within:border-[#0e655d] focus-within:bg-white transition">
              <Phone size={16} className="text-[#78968d] shrink-0" />
              <input
                type="tel"
                placeholder="+91 98765 43210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full bg-transparent text-xs font-semibold text-[#11382f] outline-none placeholder:font-normal placeholder:text-[#8ea59d]"
              />
            </div>
          </div>

          {/* Role Selector */}
          <div>
            <label className="block text-xs font-bold text-[#143d35] mb-1.5">
              Role <span className="text-[#c25e19]">*</span>
            </label>
            <div className="flex items-center gap-2.5 rounded-2xl border border-[#d8e3de] bg-[#fafcfb] px-3.5 py-2.5 focus-within:border-[#0e655d] focus-within:bg-white transition">
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full bg-transparent text-xs font-bold text-[#11382f] outline-none cursor-pointer"
              >
                <option value="owner">Owner (view only)</option>
                <option value="employee">Employee (view only)</option>
                <option value="admin">Admin (full access)</option>
              </select>
            </div>
          </div>

          <p className="rounded-xl bg-[#f3f8f5] p-3 text-[11px] leading-relaxed text-[#5e7d73]">
            This PIN only unlocks the current device after account sign-in. Account roles come from your profile.
          </p>

          {/* 4-Digit Device PIN */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="block text-xs font-bold text-[#143d35]">
                4-Digit device PIN <span className="text-[#c25e19]">*</span>
              </label>
              <button
                type="button"
                onClick={generateRandomPin}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0e655d] hover:underline"
              >
                <Sparkles size={12} /> Generate new PIN
              </button>
            </div>
            <div className="flex items-center gap-2.5 rounded-2xl border border-[#d8e3de] bg-[#fafcfb] px-3.5 py-2.5 focus-within:border-[#0e655d] focus-within:bg-white transition">
              <KeyRound size={16} className="text-[#78968d] shrink-0" />
              <input
                type="text"
                inputMode="numeric"
                maxLength={4}
                pattern="[0-9]*"
                required
                placeholder="Enter 4 digits"
                value={pin}
                onChange={(e) => {
                  setError('')
                  setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))
                }}
                className="w-full bg-transparent font-mono text-sm font-extrabold tracking-[0.35em] text-[#11382f] outline-none placeholder:tracking-normal"
              />
              <span className="rounded-lg bg-[#e4f3eb] px-2 py-0.5 text-[10px] font-bold text-[#0d7568] shrink-0">
                4 digits
              </span>
            </div>
          </div>

          {/* Error Alert */}
          {error && (
            <div className="flex items-center gap-2 rounded-2xl border border-[#f5d0c8] bg-[#fff4f2] p-3 text-xs font-semibold text-[#b43c29]">
              <AlertCircle size={15} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Action Footer */}
          <div className="mt-6 flex items-center justify-between gap-2.5 pt-2 border-t border-[#edf3f0]">
            {editingUser && !editingUser.isSelf ? (
              <button
                type="button"
                onClick={handleDelete}
                className="inline-flex items-center gap-1.5 rounded-2xl border border-[#f2d0c9] bg-[#fff6f5] px-3.5 py-2.5 text-xs font-bold text-[#b83b2a] hover:bg-[#ffece9] transition"
              >
                <Trash2 size={14} /> Remove
              </button>
            ) : (
              <div />
            )}

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl border border-[#d6e2dd] bg-white px-4 py-2.5 text-xs font-bold text-[#55736a] hover:bg-[#f2f7f4] transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-5 py-2.5 text-xs font-extrabold text-white shadow-xs hover:bg-[#094e48] disabled:opacity-50 transition active:scale-98"
              >
                <CheckCircle2 size={15} />
                {saving
                  ? 'Saving…'
                  : editingUser
                  ? 'Save Changes'
                  : 'Add User'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
