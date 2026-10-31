import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { accDb, initDefaultAccountingData } from '../lib/accountingDb'
import { supabase, supabaseConfigured } from '../lib/supabaseClient'
import { syncFromSupabase } from '../lib/syncService'

const AuthContext = createContext(null)

const DEFAULT_USERS = []

/**
 * Hash a 4-digit PIN using PBKDF2-SHA-256 (100,000 iterations).
 * Stored as { salt, hash } in hex strings.
 */
async function hashPin(pin, saltHex = null) {
  const enc = new TextEncoder()
  const salt = saltHex
    ? Uint8Array.from(saltHex.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)))
    : crypto.getRandomValues(new Uint8Array(16))
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(pin)),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  )
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  )
  const hashHex = Array.from(new Uint8Array(derivedBits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const outSaltHex = Array.from(salt)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return { salt: outSaltHex, hash: hashHex }
}

function parsePinRecord(val) {
  if (!val) return null
  if (typeof val === 'object' && val.salt && val.hash) return val
  if (typeof val === 'string') {
    try {
      const p = JSON.parse(val)
      if (p && p.salt && p.hash) return p
    } catch { }
  }
  return null
}

async function verifyPin(enteredPin, stored) {
  if (!stored) return false
  const record = parsePinRecord(stored)
  if (record) {
    const computed = await hashPin(enteredPin, record.salt)
    if (computed.hash.length !== record.hash.length) return false
    let diff = 0
    for (let i = 0; i < record.hash.length; i++) {
      diff |= record.hash.charCodeAt(i) ^ computed.hash.charCodeAt(i)
    }
    return diff === 0
  }
  // Plaintext fallback for pre-migration
  return String(stored) === String(enteredPin)
}

export function AuthProvider({ children }) {
  const [loading, setLoading] = useState(true)
  const [cloudSyncStatus, setCloudSyncStatus] = useState('idle')
  const [cloudSyncError, setCloudSyncError] = useState('')
  const [blockedSyncState, setBlockedSyncState] = useState(null)
  const [sessionUser, setSessionUser] = useState(null)
  const [isPinUnlocked, setIsPinUnlocked] = useState(false)
  const [currentRole, setCurrentRole] = useState('')
  const [activeUserName, setActiveUserName] = useState('')
  const [ownerPin, setOwnerPin] = useState('')
  const [adminPin, setAdminPin] = useState('')
  const [teamUsers, setTeamUsers] = useState(DEFAULT_USERS)
  const [shopName, setShopName] = useState('[Shop name]')
  const [ownerPermissions, setOwnerPermissions] = useState({
    sales: true,
    profit: true,
    expenses: true,
    debtors: true,
    creditors: true,
    inventory: true,
    loans: false,
  })
  const [cardOrder, setCardOrder] = useState([
    'sales', 'profit', 'expenses', 'debtors', 'creditors', 'inventory', 'loans'
  ])

  const loadSettingsFromDb = async () => {
    const settings = await accDb.settings.toArray()

    const sName = settings.find((s) => s.key === 'shop_name')?.value
    if (sName) setShopName(sName)

    const oPinRaw = settings.find((s) => s.key === 'owner_pin')?.value || ''
    let loadedOwnerPin = ''
    if (oPinRaw) {
      const parsed = parsePinRecord(oPinRaw)
      if (parsed) {
        loadedOwnerPin = JSON.stringify(parsed)
      } else if (/^\d{4}$/.test(String(oPinRaw))) {
        // Plaintext PIN - migrate once on first load
        const hashed = await hashPin(oPinRaw)
        loadedOwnerPin = JSON.stringify(hashed)
        await accDb.settings.put({ key: 'owner_pin', value: loadedOwnerPin })
      }
    }
    setOwnerPin(loadedOwnerPin)

    const aPinRaw = settings.find((s) => s.key === 'admin_pin')?.value || ''
    let loadedAdminPin = ''
    if (aPinRaw) {
      const parsed = parsePinRecord(aPinRaw)
      if (parsed) {
        loadedAdminPin = JSON.stringify(parsed)
      } else if (/^\d{4}$/.test(String(aPinRaw))) {
        // Plaintext PIN - migrate once on first load
        const hashed = await hashPin(aPinRaw)
        loadedAdminPin = JSON.stringify(hashed)
        await accDb.settings.put({ key: 'admin_pin', value: loadedAdminPin })
      }
    }
    setAdminPin(loadedAdminPin)

    const savedUsers = settings.find((s) => s.key === 'team_users')?.value
    if (savedUsers) {
      try {
        const parsed = JSON.parse(savedUsers)
        if (Array.isArray(parsed)) {
          let needsSave = false
          const migratedUsers = await Promise.all(parsed.map(async (user) => {
            if (user.pin && typeof user.pin === 'string' && /^\d{4}$/.test(user.pin)) {
              needsSave = true
              const hashed = await hashPin(user.pin)
              return { ...user, pin: hashed }
            }
            return user
          }))
          setTeamUsers(migratedUsers)
          if (needsSave) {
            await accDb.settings.put({ key: 'team_users', value: JSON.stringify(migratedUsers) })
          }
        }
      } catch { }
    } else {
      await accDb.settings.put({ key: 'team_users', value: JSON.stringify(DEFAULT_USERS) })
    }

    const perms = settings.find((s) => s.key === 'owner_permissions')?.value
    if (perms) {
      try { setOwnerPermissions(JSON.parse(perms)) } catch { }
    }

    const order = settings.find((s) => s.key === 'card_order')?.value
    if (order) {
      try { setCardOrder(JSON.parse(order)) } catch { }
    }
  }

  const clearAccountSession = () => {
    setSessionUser(null)
    setCurrentRole('')
    setActiveUserName('')
    setIsPinUnlocked(false)
    setCloudSyncStatus('idle')
    setCloudSyncError('')
    localStorage.setItem('tallyflow_locked', 'true')
  }

  const applyAccountSession = async (session, unlock = false) => {
    if (!session?.user) {
      clearAccountSession()
      return false
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('role, full_name')
      .eq('id', session.user.id)
      .maybeSingle()

    let resolvedProfile = profile
    if (error && !navigator.onLine) {
      try {
        const cachedProfile = JSON.parse(localStorage.getItem('tallyflow_verified_profile') || 'null')
        if (cachedProfile?.id === session.user.id) resolvedProfile = cachedProfile
      } catch { }
    }

    if ((error && !resolvedProfile) || !resolvedProfile || !['admin', 'owner', 'employee'].includes(resolvedProfile.role)) {
      clearAccountSession()
      if (!error || navigator.onLine) {
        localStorage.removeItem('tallyflow_verified_profile')
        await supabase.auth.signOut()
      }
      return false
    }

    setSessionUser(session.user)
    setCurrentRole(resolvedProfile.role)
    setActiveUserName(resolvedProfile.full_name || session.user.email || '')
    const [savedOwnerPin, savedAdminPin, savedUsers] = await Promise.all([
      accDb.settings.get('owner_pin'),
      accDb.settings.get('admin_pin'),
      accDb.settings.get('team_users'),
    ])
    let savedUserPins = []
    try { savedUserPins = JSON.parse(savedUsers?.value || '[]').map((localUser) => localUser.pin) } catch { }
    const hasLocalPin = [...savedUserPins, savedOwnerPin?.value, savedAdminPin?.value]
      .some((pin) => Boolean(parsePinRecord(pin) || /^\d{4}$/.test(String(pin || ''))))
    const shouldUnlock = unlock || !hasLocalPin
    setIsPinUnlocked(shouldUnlock)
    localStorage.setItem('tallyflow_locked', shouldUnlock ? 'false' : 'true')
    if (!error) {
      localStorage.setItem('tallyflow_verified_profile', JSON.stringify({
        id: session.user.id,
        role: resolvedProfile.role,
        full_name: resolvedProfile.full_name || '',
      }))
    }
    return true
  }

  useEffect(() => {
    let active = true
    async function bootstrap() {
      try {
        await initDefaultAccountingData()
        if (active) {
          await loadSettingsFromDb()
          if (supabaseConfigured) {
            const { data: { session } } = await supabase.auth.getSession()
            if (active && session) await applyAccountSession(session, false)
          }
        }
      } catch (err) {
        console.warn('Accounting DB bootstrap warning:', err)
      } finally {
        if (active) setLoading(false)
      }
    }

    bootstrap()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') clearAccountSession()
      if (event === 'TOKEN_REFRESHED' && session?.user) setSessionUser(session.user)
    })

    const onSettingsUpdate = () => {
      loadSettingsFromDb().catch((e) => console.debug('Settings reload error:', e))
    }

    window.addEventListener('accounting-settings-updated', onSettingsUpdate)
    return () => {
      active = false
      window.removeEventListener('accounting-settings-updated', onSettingsUpdate)
      subscription.unsubscribe()
    }
  }, [])

  const syncCloudNow = useCallback(async () => {
    setCloudSyncStatus('syncing')
    setCloudSyncError('')
    try {
      const result = await syncFromSupabase()
      if (!result.success) {
        setCloudSyncStatus('error')
        setCloudSyncError(result.error || 'Cloud sync failed.')
        return result
      }

      if (result.pushResult?.reason === 'role_not_permitted' || result.reason === 'role_not_permitted') {
        const skipped = result.skipped || result.pushResult?.skipped || 0
        setBlockedSyncState({ reason: 'role_not_permitted', skipped })
      } else {
        setBlockedSyncState(null)
      }

      const dirtyCounts = await Promise.all(['parties', 'ledgers', 'materials', 'vouchers'].map(async (tableName) =>
        (await accDb.table(tableName).filter((row) => row.local_dirty).toArray()).length
      ))
      const hasPendingChanges = dirtyCounts.some((count) => count > 0)
      if (!hasPendingChanges) {
        setBlockedSyncState(null)
      }
      setCloudSyncStatus(hasPendingChanges ? 'pending' : 'synced')
      return result
    } catch (error) {
      setCloudSyncStatus('error')
      setCloudSyncError(error.message || 'Cloud sync failed.')
      return { success: false, error: error.message || 'Cloud sync failed.' }
    }
  }, [])

  const sessionUserId = sessionUser?.id

  // Real-time role propagation (Step 5)
  useEffect(() => {
    if (!sessionUserId) return
    const channel = supabase
      .channel(`profile-${sessionUserId}`)
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles',
          filter: `id=eq.${sessionUserId}` },
        (p) => {
          const r = p.new?.role
          if (['admin', 'owner', 'employee'].includes(r)) setCurrentRole(r)
        })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [sessionUserId])

  useEffect(() => {
    if (!sessionUserId || !isPinUnlocked) return undefined

    let active = true
    let debounceTimer = null
    const initialSyncTimer = setTimeout(() => {
      if (active) syncCloudNow()
    }, 0)

    const onLocalDataChanged = () => {
      if (!['admin', 'owner'].includes(currentRole)) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (active) syncCloudNow()
      }, 600)
    }

    window.addEventListener('accounting-local-data-changed', onLocalDataChanged)
    return () => {
      active = false
      clearTimeout(initialSyncTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      window.removeEventListener('accounting-local-data-changed', onLocalDataChanged)
    }
  }, [sessionUserId, isPinUnlocked, currentRole, syncCloudNow])

  const signIn = async (email, password) => {
    if (!supabaseConfigured) {
      return { success: false, error: 'Account sign-in is not configured for this app.' }
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) return { success: false, error: error.message }

    const hasProfile = await applyAccountSession(data.session, false)
    if (!hasProfile) {
      return { success: false, error: 'This account does not have a valid app role. Contact your administrator.' }
    }
    return { success: true }
  }

  const unlockWithPin = async (enteredPin) => {
    if (!sessionUser) return { success: false, error: 'Sign in to your account first.' }
    const cleanPin = String(enteredPin).trim()
    if (!/^\d{4}$/.test(cleanPin)) {
      return { success: false, error: 'Incorrect 4-digit PIN.' }
    }

    const pinCandidates = [ownerPin, adminPin, ...teamUsers.map((user) => user.pin)].filter(Boolean)
    let matched = false
    for (const candidate of pinCandidates) {
      if (await verifyPin(cleanPin, candidate)) {
        matched = true
        break
      }
    }
    if (!matched) {
      return { success: false, error: 'Incorrect 4-digit PIN.' }
    }

    setIsPinUnlocked(true)
    localStorage.setItem('tallyflow_locked', 'false')
    return { success: true, role: currentRole }
  }

  const lockApp = () => {
    setIsPinUnlocked(false)
    localStorage.setItem('tallyflow_locked', 'true')
  }

  const signOut = async () => {
    if (supabaseConfigured) await supabase.auth.signOut()
    localStorage.removeItem('tallyflow_verified_profile')
    clearAccountSession()
  }

  const updateOwnerPermission = async (key, val) => {
    const updated = { ...ownerPermissions, [key]: val }
    setOwnerPermissions(updated)
    await accDb.settings.put({ key: 'owner_permissions', value: JSON.stringify(updated) })
    window.dispatchEvent(new Event('accounting-settings-updated'))
  }

  const updateCardOrder = async (newOrder) => {
    setCardOrder(newOrder)
    await accDb.settings.put({ key: 'card_order', value: JSON.stringify(newOrder) })
    window.dispatchEvent(new Event('accounting-settings-updated'))
  }

  const updateShopName = async (name) => {
    setShopName(name)
    await accDb.settings.put({ key: 'shop_name', value: name })
    window.dispatchEvent(new Event('accounting-settings-updated'))
  }

  const updatePins = async ({ newOwnerPin, newAdminPin }) => {
    let updatedUsers = [...teamUsers]
    if (newOwnerPin !== undefined) {
      if (newOwnerPin !== '' && !/^\d{4}$/.test(newOwnerPin)) {
        throw new Error('Choose a 4-digit device PIN.')
      }
      let hashedOwner = ''
      if (newOwnerPin !== '') {
        const hashed = await hashPin(newOwnerPin)
        hashedOwner = JSON.stringify(hashed)
      }
      setOwnerPin(hashedOwner)
      await accDb.settings.put({ key: 'owner_pin', value: hashedOwner })
      updatedUsers = updatedUsers.map((u) =>
        u.id === 'user-owner-1' ? { ...u, pin: hashedOwner ? JSON.parse(hashedOwner) : '' } : u
      )
    }
    if (newAdminPin !== undefined) {
      if (newAdminPin !== '' && !/^\d{4}$/.test(newAdminPin)) {
        throw new Error('Choose a 4-digit device PIN.')
      }
      let hashedAdmin = ''
      if (newAdminPin !== '') {
        const hashed = await hashPin(newAdminPin)
        hashedAdmin = JSON.stringify(hashed)
      }
      setAdminPin(hashedAdmin)
      await accDb.settings.put({ key: 'admin_pin', value: hashedAdmin })
      updatedUsers = updatedUsers.map((u) =>
        u.id === 'user-admin-1' ? { ...u, pin: hashedAdmin ? JSON.parse(hashedAdmin) : '' } : u
      )
    }
    setTeamUsers(updatedUsers)
    await accDb.settings.put({ key: 'team_users', value: JSON.stringify(updatedUsers) })
    window.dispatchEvent(new Event('accounting-settings-updated'))
  }

  const saveTeamUser = async (userData) => {
    const cleanRole = ['admin', 'owner', 'employee'].includes(userData.role) ? userData.role : 'owner'
    const roleLabel = cleanRole === 'admin' ? 'Admin' : cleanRole === 'employee' ? 'Employee · view only' : 'Owner · view only'
    const rawPin = String(userData.pin || '').trim().slice(0, 4)
    let pinRecord = null
    if (rawPin && /^\d{4}$/.test(rawPin)) {
      pinRecord = await hashPin(rawPin)
    } else if (cleanRole === 'admin' && adminPin) {
      pinRecord = parsePinRecord(adminPin)
    } else if (ownerPin) {
      pinRecord = parsePinRecord(ownerPin)
    }

    let nextUsers
    const exists = teamUsers.some((u) => u.id === userData.id)
    if (exists) {
      nextUsers = teamUsers.map((u) =>
        u.id === userData.id
          ? {
            ...u,
            name: userData.name.trim(),
            phone: (userData.phone || '').trim(),
            role: cleanRole,
            roleLabel,
            pin: pinRecord || u.pin,
          }
          : u
      )
    } else {
      const newUser = {
        id: `user-${Date.now()}`,
        name: userData.name.trim(),
        phone: (userData.phone || '').trim(),
        role: cleanRole,
        roleLabel,
        pin: pinRecord,
        lastSeen: 'Added just now',
      }
      nextUsers = [...teamUsers, newUser]
    }

    setTeamUsers(nextUsers)
    await accDb.settings.put({ key: 'team_users', value: JSON.stringify(nextUsers) })

    // If primary owner or admin pin was changed via user edit, keep in sync
    const primaryOwner = nextUsers.find((u) => u.id === 'user-owner-1')
    if (primaryOwner?.pin && primaryOwner.pin !== ownerPin) {
      setOwnerPin(primaryOwner.pin)
      await accDb.settings.put({ key: 'owner_pin', value: primaryOwner.pin })
    }
    const primaryAdmin = nextUsers.find((u) => u.id === 'user-admin-1')
    if (primaryAdmin?.pin && primaryAdmin.pin !== adminPin) {
      setAdminPin(primaryAdmin.pin)
      await accDb.settings.put({ key: 'admin_pin', value: primaryAdmin.pin })
    }

    window.dispatchEvent(new Event('accounting-settings-updated'))
    return nextUsers
  }

  const removeTeamUser = async (userId) => {
    const nextUsers = teamUsers.filter((u) => u.id !== userId)
    setTeamUsers(nextUsers)
    await accDb.settings.put({ key: 'team_users', value: JSON.stringify(nextUsers) })
    window.dispatchEvent(new Event('accounting-settings-updated'))
  }

  const isAuthenticated = Boolean(sessionUser && isPinUnlocked)
  const isOwner = currentRole === 'owner' || currentRole === 'employee'
  const isAdmin = currentRole === 'admin'
  const user = isAuthenticated
    ? { id: sessionUser.id, name: activeUserName || sessionUser.email || 'User', role: currentRole }
    : null

  const value = {
    isAuthenticated,
    hasSession: Boolean(sessionUser),
    isPinLocked: Boolean(sessionUser && !isPinUnlocked),
    user,
    role: currentRole,
    isAdmin,
    isOwner,
    loading,
    cloudSyncStatus,
    cloudSyncError,
    blockedSyncState,
    shopName,
    ownerPin,
    adminPin,
    teamUsers,
    ownerPermissions,
    cardOrder,
    signIn,
    unlockWithPin,
    lock: lockApp,
    signOut,
    syncCloudNow,
    updateOwnerPermission,
    updateCardOrder,
    updateShopName,
    updatePins,
    saveTeamUser,
    removeTeamUser,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
