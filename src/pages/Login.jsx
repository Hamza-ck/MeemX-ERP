import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Delete, AlertCircle, LogOut } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function Login() {
  const [pin, setPin] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [shaking, setShaking] = useState(false)
  const navigate = useNavigate()
  const { signIn, signOut, unlockWithPin, hasSession, isPinLocked, isAuthenticated } = useAuth()

  // If already authenticated, redirect to home
  useEffect(() => {
    if (isAuthenticated) {
      navigate('/')
    }
  }, [isAuthenticated, navigate])

  const validatePin = useCallback(async (inputPin) => {
    const result = await unlockWithPin(inputPin)
    if (result.success) {
      navigate('/')
    } else {
      setShaking(true)
      setError(result.error)
      setTimeout(() => {
        setShaking(false)
        setPin('')
      }, 700)
    }
  }, [unlockWithPin, navigate])

  const handleDigit = useCallback((digit) => {
    if (pin.length >= 4) return
    const nextPin = pin + digit
    setPin(nextPin)
    setError('')

    if (nextPin.length === 4) validatePin(nextPin)
  }, [pin, validatePin])

  const handleBackspace = useCallback(() => {
    setError('')
    setPin((prev) => prev.slice(0, -1))
  }, [])

  const handleClear = () => {
    setError('')
    setPin('')
  }

  // Listen to physical keyboard events while the local PIN lock is visible.
  useEffect(() => {
    function handleKeyDown(event) {
      if (!isPinLocked) return
      if (/^[0-9]$/.test(event.key)) handleDigit(event.key)
      else if (event.key === 'Backspace') handleBackspace()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pin, isPinLocked, handleDigit, handleBackspace])

  const handleSignIn = async (event) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const result = await signIn(email, password)
      if (!result.success) setError(result.error)
    } catch (err) {
      setError(err.message || 'Could not sign in. Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (!hasSession) {
    return (
      <main className="grid min-h-screen place-items-center bg-[#f4f7f4] p-4 sm:p-6">
        <div className="w-full max-w-[360px]">
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-[#0e655d] text-2xl font-black text-white shadow-md">M</div>
          <h1 className="text-center text-[26px] font-extrabold tracking-tight text-[#11382f]">Sign in to MEEMX</h1>
          <p className="mb-6 mt-1 text-center text-xs font-medium text-[#6c877e]">Use your business account to continue</p>
          <form onSubmit={handleSignIn} className="space-y-4 rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-[0_16px_48px_rgba(14,101,93,0.06)]">
            <label className="block text-xs font-bold text-[#35584e]">
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-[#d9e5df] bg-[#fafcfb] px-3 py-3 text-sm text-[#173d33] outline-none focus:border-[#0e655d] focus:ring-2 focus:ring-[#0e655d]/15"
              />
            </label>
            <label className="block text-xs font-bold text-[#35584e]">
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-1.5 w-full rounded-xl border border-[#d9e5df] bg-[#fafcfb] px-3 py-3 text-sm text-[#173d33] outline-none focus:border-[#0e655d] focus:ring-2 focus:ring-[#0e655d]/15"
              />
            </label>
            {error && <p role="alert" className="flex items-center gap-1.5 text-xs font-semibold text-[#b83e29]"><AlertCircle size={15} />{error}</p>}
            <button disabled={submitting} className="w-full rounded-xl bg-[#0e655d] py-3 text-sm font-extrabold text-white transition hover:bg-[#0a4f49] disabled:opacity-60">
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>
      </main>
    )
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f4f7f4] p-4 sm:p-6">
      <div className="w-full max-w-[360px] text-center">
        {/* Brand Circular Logo 'S' */}
        <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-2xl bg-[#0e655d] text-white text-2xl font-black shadow-md">
          S
        </div>

        {/* Screen Title */}
        <h1 className="text-[26px] font-extrabold tracking-tight text-[#11382f]">
          Enter 4-Digit PIN
        </h1>
        <p className="mt-1 text-xs font-medium text-[#6c877e]">
          Enter your local PIN to unlock this device
        </p>

        {/* 4-Digit PIN Indicators */}
        <div className={`mt-8 mb-6 flex justify-center gap-4 ${shaking ? 'animate-shake' : ''}`}>
          {[0, 1, 2, 3].map((index) => {
            const isFilled = pin.length > index
            return (
              <div
                key={index}
                className={`grid h-13 w-13 place-items-center rounded-2xl border-2 transition-all duration-150 ${
                  isFilled
                    ? 'border-[#0e655d] bg-[#0e655d] text-white shadow-sm scale-105'
                    : 'border-[#d0ded7] bg-white text-transparent'
                }`}
              >
                <div
                  className={`h-3.5 w-3.5 rounded-full transition-all ${
                    isFilled ? 'bg-white scale-100' : 'bg-transparent scale-50'
                  }`}
                />
              </div>
            )
          })}
        </div>

        {/* Error message */}
        {error ? (
          <div className="mb-4 flex items-center justify-center gap-1.5 text-xs font-bold text-[#b83e29]">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        ) : (
          <div className="mb-4 h-4 text-[11px] text-[#718d84]">
            Type with keyboard or use keypad
          </div>
        )}

        {/* Keypad Container */}
        <div className="rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-[0_16px_48px_rgba(14,101,93,0.06)]">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((num) => (
              <button
                key={num}
                type="button"
                onClick={() => handleDigit(String(num))}
                className="grid h-13 place-items-center rounded-2xl border border-[#edf3f0] bg-[#fafcfb] text-lg font-bold text-[#11382f] shadow-2xs hover:bg-[#eef7f3] hover:border-[#b4d6cc] active:scale-95 transition"
              >
                {num}
              </button>
            ))}

            {/* Clear Button */}
            <button
              type="button"
              onClick={handleClear}
              className="grid h-13 place-items-center rounded-2xl text-xs font-extrabold text-[#759187] hover:bg-[#f1f6f3] active:scale-95 transition"
            >
              Clear
            </button>

            {/* Zero Button */}
            <button
              type="button"
              onClick={() => handleDigit('0')}
              className="grid h-13 place-items-center rounded-2xl border border-[#edf3f0] bg-[#fafcfb] text-lg font-bold text-[#11382f] shadow-2xs hover:bg-[#eef7f3] hover:border-[#b4d6cc] active:scale-95 transition"
            >
              0
            </button>

            {/* Backspace Button */}
            <button
              type="button"
              onClick={handleBackspace}
              className="grid h-13 place-items-center rounded-2xl text-[#759187] hover:bg-[#f1f6f3] active:scale-95 transition"
              aria-label="Backspace"
            >
              <Delete size={20} />
            </button>
          </div>

        </div>
        <button type="button" onClick={() => signOut()} className="mx-auto mt-4 flex items-center gap-1.5 text-xs font-bold text-[#6c857d] hover:text-[#ba3b2a]">
          <LogOut size={14} /> Sign out of account
        </button>
      </div>
    </main>
  )
}
