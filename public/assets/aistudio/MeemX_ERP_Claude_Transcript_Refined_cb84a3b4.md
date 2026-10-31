# MeemX ERP — Refined Claude Engineering Transcript

**Repository:** https://github.com/Hamza-ck/MeemX-ERP.git  
**Source:** Captured Claude session, cleaned to remove repetitive progress narration and interface noise. Terminal commands, outputs, code excerpts, test results, and substantive findings are retained in chronological order.

## Initial request

Review the repository for:

- Mathematical and accounting logic flaws.
- Broken or disorganized data flow.
- Reliable daily extraction of data from Tally.
- Cloud synchronization defects, including new Tally transactions not reaching Supabase.
- Bugs and dysfunctional features.
- Role-switching and role-based views.

The reported symptoms were that the app was not using live Tally data, expense and profit calculations were unreliable, Debtors and Sales data were disorganized, and Supabase was not receiving new Tally transactions.

## Engineering log

There are already several parser-level math flaws here (sign loss on balances, substring-matched voucher types, amount derived via max()). Next the DB side: schema, the commit RPC, and RLS.

Found a real cause already: normalizeCloudParty hardcodes age_bucket: '0–30d', so synced debtor aging is fake. Next: when does the app actually trigger a sync?

**Command**

```bash
cd /home/claude/MeemX-ERP/src && grep -rn "syncFromSupabase\|setInterval\|realtime\|\.channel(\|visibilitychange\|accounting-local-data-changed\|last_cloud_sync" --include=*.jsx --include=*.js . | grep -v "^./lib/syncServiceCore" | head -40; echo ----; cat -n context/AuthContext.jsx
```

**Output**

```text
./lib/syncService.js:13:export const syncFromSupabase = syncService.syncFromSupabase
./lib/accountingDb.js:41:    window.dispatchEvent(new Event('accounting-local-data-changed'))
./pages/TallyIntegrationPage.jsx:19:import { syncFromSupabase } from '../lib/syncService'
./pages/TallyIntegrationPage.jsx:218:      const res = await syncFromSupabase()
./context/AuthContext.jsx:4:import { syncFromSupabase } from '../lib/syncService'
./context/AuthContext.jsx:188:      const result = await syncFromSupabase()
./context/AuthContext.jsx:227:    window.addEventListener('accounting-local-data-changed', onLocalDataChanged)
./context/AuthContext.jsx:232:      window.removeEventListener('accounting-local-data-changed', onLocalDataChanged)
----
     1	import { createContext, useCallback, useContext, useEffect, useState } from 'react'
     2	import { accDb, initDefaultAccountingData } from '../lib/accountingDb'
     3	import { supabase, supabaseConfigured } from '../lib/supabaseClient'
     4	import { syncFromSupabase } from '../lib/syncService'
     5	
     6	const AuthContext = createContext(null)
     7	
     8	const DEFAULT_USERS = []
     9	const DEFAULT_PINS = new Set(['1234', '8888'])
    10	
    11	export function AuthProvider({ children }) {
    12	  const [loading, setLoading] = useState(true)
    13	  const [cloudSyncStatus, setCloudSyncStatus] = useState('idle')
    14	  const [cloudSyncError, setCloudSyncError] = useState('')
    15	  const [sessionUser, setSessionUser] = useState(null)
    16	  const [isPinUnlocked, setIsPinUnlocked] = useState(false)
    17	  const [currentRole, setCurrentRole] = useState('')
    18	  const [activeUserName, setActiveUserName] = useState('')
    19	  const [ownerPin, setOwnerPin] = useState('')
    20	  const [adminPin, setAdminPin] = useState('')
    21	  const [teamUsers, setTeamUsers] = useState(DEFAULT_USERS)
    22	  const [shopName, setShopName] = useState('[Shop name]')
    23	  const [ownerPermissions, setOwnerPermissions] = useState({
    24	    sales: true,
    25	    profit: true,
    26	    expenses: true,
    27	    debtors: true,
    28	    creditors: true,
    29	    inventory: true,
    30	    loans: false,
    31	  })
    32	  const [cardOrder, setCardOrder] = useState([
    33	    'sales', 'profit', 'expenses', 'debtors', 'creditors', 'inventory', 'loans'
    34	  ])
    35	
    36	  const loadSettingsFromDb = async () => {
    37	    const settings = await accDb.settings.toArray()
    38	
    39	    const sName = settings.find((s) => s.key === 'shop_name')?.value
    40	    if (sName) setShopName(sName)
    41	
    42	    const oPin = settings.find((s) => s.key === 'owner_pin')?.value || ''
    43	    const safeOwnerPin = oPin === '1234' ? '' : oPin
    44	    setOwnerPin(safeOwnerPin)
    45	    if (oPin === '1234') await accDb.settings.put({ key: 'owner_pin', value: '' })
    46	
    47	    const aPin = settings.find((s) => s.key === 'admin_pin')?.value || ''
    48	    const safeAdminPin = aPin === '8888' ? '' : aPin
    49	    setAdminPin(safeAdminPin)
    50	    if (aPin === '8888') await accDb.settings.put({ key: 'admin_pin', value: '' })
    51	
    52	    const savedUsers = settings.find((s) => s.key === 'team_users')?.value
    53	    if (savedUsers) {
    54	      try {
    55	        const parsed = JSON.parse(savedUsers)
    56	        if (Array.isArray(parsed)) {
    57	          const filteredUsers = parsed.filter((user) => !(
    58	            (user.id === 'user-owner-1' && String(user.pin) === '1234') ||
    59	            (user.id === 'user-admin-1' && String(user.pin) === '8888')
    60	          ))
    61	          setTeamUsers(filteredUsers)
    62	          if (filteredUsers.length !== parsed.length) {
    63	            await accDb.settings.put({ key: 'team_users', value: JSON.stringify(filteredUsers) })
    64	          }
    65	        }
    66	      } catch { }
    67	    } else {
    68	      await accDb.settings.put({ key: 'team_users', value: JSON.stringify(DEFAULT_USERS) })
    69	    }
    70	
    71	    const perms = settings.find((s) => s.key === 'owner_permissions')?.value
    72	    if (perms) {
    73	      try { setOwnerPermissions(JSON.parse(perms)) } catch { }
    74	    }
    75	
    76	    const order = settings.find((s) => s.key === 'card_order')?.value
    77	    if (order) {
    78	      try { setCardOrder(JSON.parse(order)) } catch { }
    79	    }
    80	  }
    81	
    82	  const clearAccountSession = () => {
    83	    setSessionUser(null)
    84	    setCurrentRole('')
    85	    setActiveUserName('')
    86	    setIsPinUnlocked(false)
    87	    setCloudSyncStatus('idle')
    88	    setCloudSyncError('')
    89	    localStorage.setItem('tallyflow_locked', 'true')
    90	  }
    91	
    92	  const applyAccountSession = async (session, unlock = false) => {
    93	    if (!session?.user) {
    94	      clearAccountSession()
    95	      return false
    96	    }
    97	
    98	    const { data: profile, error } = await supabase
    99	      .from('profiles')
   100	      .select('role, full_name')
   101	      .eq('id', session.user.id)
   102	      .maybeSingle()
   103	
   104	    let resolvedProfile = profile
   105	    if (error && !navigator.onLine) {
   106	      try {
   107	        const cachedProfile = JSON.parse(localStorage.getItem('tallyflow_verified_profile') || 'null')
   108	        if (cachedProfile?.id === session.user.id) resolvedProfile = cachedProfile
   109	      } catch { }
   110	    }
   111	
   112	    if ((error && !resolvedProfile) || !resolvedProfile || !['admin', 'owner', 'employee'].includes(resolvedProfile.role)) {
   113	      clearAccountSession()
   114	      if (!error || navigator.onLine) {
   115	        localStorage.removeItem('tallyflow_verified_profile')
   116	        await supabase.auth.signOut()
   117	      }
   118	      return false
   119	    }
   120	
   121	    setSessionUser(session.user)
   122	    setCurrentRole(resolvedProfile.role)
   123	    setActiveUserName(resolvedProfile.full_name || session.user.email || '')
   124	    const [savedOwnerPin, savedAdminPin, savedUsers] = await Promise.all([
   125	      accDb.settings.get('owner_pin'),
   126	      accDb.settings.get('admin_pin'),
   127	      accDb.settings.get('team_users'),
   128	    ])
   129	    let savedUserPins = []
   130	    try { savedUserPins = JSON.parse(savedUsers?.value || '[]').map((localUser) => localUser.pin) } catch { }
   131	    const hasLocalPin = [...savedUserPins, savedOwnerPin?.value, savedAdminPin?.value]
   132	      .some((pin) => /^\d{4}$/.test(String(pin || '')) && !DEFAULT_PINS.has(String(pin)))
   133	    const shouldUnlock = unlock || !hasLocalPin
   134	    setIsPinUnlocked(shouldUnlock)
   135	    localStorage.setItem('tallyflow_locked', shouldUnlock ? 'false' : 'true')
   136	    if (!error) {
   137	      localStorage.setItem('tallyflow_verified_profile', JSON.stringify({
   138	        id: session.user.id,
   139	        role: resolvedProfile.role,
   140	        full_name: resolvedProfile.full_name || '',
   141	      }))
   142	    }
   143	    return true
   144	  }
   145	
   146	  useEffect(() => {
   147	    let active = true
   148	    async function bootstrap() {
   149	      try {
   150	        await initDefaultAccountingData()
   151	        if (active) {
   152	          await loadSettingsFromDb()
   153	          if (supabaseConfigured) {
   154	            const { data: { session } } = await supabase.auth.getSession()
   155	            if (active && session) await applyAccountSession(session, false)
   156	          }
   157	        }
   158	      } catch (err) {
   159	        console.warn('Accounting DB bootstrap warning:', err)
   160	      } finally {
   161	        if (active) setLoading(false)
   162	      }
   163	    }
   164	
   165	    bootstrap()
   166	
   167	    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
   168	      if (event === 'SIGNED_OUT') clearAccountSession()
   169	      if (event === 'TOKEN_REFRESHED' && session?.user) setSessionUser(session.user)
   170	    })
   171	
   172	    const onSettingsUpdate = () => {
   173	      loadSettingsFromDb().catch((e) => console.debug('Settings reload error:', e))
   174	    }
   175	
   176	    window.addEventListener('accounting-settings-updated', onSettingsUpdate)
   177	    return () => {
   178	      active = false
   179	      window.removeEventListener('accounting-settings-updated', onSettingsUpdate)
   180	      subscription.unsubscribe()
   181	    }
   182	  }, [])
   183	
   184	  const syncCloudNow = useCallback(async () => {
   185	    setCloudSyncStatus('syncing')
   186	    setCloudSyncError('')
   187	    try {
   188	      const result = await syncFromSupabase()
   189	      if (!result.success) {
   190	        setCloudSyncStatus('error')
   191	        setCloudSyncError(result.error || 'Cloud sync failed.')
   192	        return result
   193	      }
   194	
   195	      const dirtyCounts = await Promise.all(['parties', 'ledgers', 'materials', 'vouchers'].map(async (tableName) =>
   196	        (await accDb.table(tableName).filter((row) => row.local_dirty).toArray()).length
   197	      ))
   198	      const hasPendingChanges = dirtyCounts.some((count) => count > 0)
   199	      setCloudSyncStatus(hasPendingChanges ? 'pending' : 'synced')
   200	      return result
   201	    } catch (error) {
   202	      setCloudSyncStatus('error')
   203	      setCloudSyncError(error.message || 'Cloud sync failed.')
   204	      return { success: false, error: error.message || 'Cloud sync failed.' }
   205	    }
   206	  }, [])
   207	
   208	  const sessionUserId = sessionUser?.id
   209	
   210	  useEffect(() => {
   211	    if (!sessionUserId || !isPinUnlocked) return undefined
   212	
   213	    let active = true
   214	    let debounceTimer = null
   215	    const initialSyncTimer = setTimeout(() => {
   216	      if (active) syncCloudNow()
   217	    }, 0)
   218	
   219	    const onLocalDataChanged = () => {
   220	      if (currentRole !== 'admin') return
   221	      if (debounceTimer) clearTimeout(debounceTimer)
   222	      debounceTimer = setTimeout(() => {
   223	        if (active) syncCloudNow()
   224	      }, 600)
   225	    }
   226	
   227	    window.addEventListener('accounting-local-data-changed', onLocalDataChanged)
   228	    return () => {
   229	      active = false
   230	      clearTimeout(initialSyncTimer)
   231	      if (debounceTimer) clearTimeout(debounceTimer)
   232	      window.removeEventListener('accounting-local-data-changed', onLocalDataChanged)
   233	    }
   234	  }, [sessionUserId, isPinUnlocked, currentRole, syncCloudNow])
   235	
   236	  const signIn = async (email, password) => {
   237	    if (!supabaseConfigured) {
   238	      return { success: false, error: 'Account sign-in is not configured for this app.' }
   239	    }
   240	
   241	    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
   242	    if (error) return { success: false, error: error.message }
   243	
   244	    const hasProfile = await applyAccountSession(data.session, false)
   245	    if (!hasProfile) {
   246	      return { success: false, error: 'This account does not have a valid app role. Contact your administrator.' }
   247	    }
   248	    return { success: true }
   249	  }
   250	
   251	  const unlockWithPin = (enteredPin) => {
   252	    if (!sessionUser) return { success: false, error: 'Sign in to your account first.' }
   253	    const cleanPin = String(enteredPin).trim()
   254	
   255	    const knownPins = [...teamUsers.map((user) => user.pin), ownerPin, adminPin]
   256	      .filter((pin) => /^\d{4}$/.test(String(pin || '')) && !DEFAULT_PINS.has(String(pin)))
   257	    if (!knownPins.some((pin) => String(pin).trim() === cleanPin)) {
   258	      return { success: false, error: 'Incorrect 4-digit PIN.' }
   259	    }
   260	
   261	    setIsPinUnlocked(true)
   262	    localStorage.setItem('tallyflow_locked', 'false')
   263	    return { success: true, role: currentRole }
   264	  }
   265	
   266	  const lockApp = () => {
   267	    setIsPinUnlocked(false)
   268	    localStorage.setItem('tallyflow_locked', 'true')
   269	  }
   270	
   271	  const signOut = async () => {
   272	    if (supabaseConfigured) await supabase.auth.signOut()
   273	    localStorage.removeItem('tallyflow_verified_profile')
   274	    clearAccountSession()
   275	  }
   276	
   277	  const updateOwnerPermission = async (key, val) => {
   278	    const updated = { ...ownerPermissions, [key]: val }
   279	    setOwnerPermissions(updated)
   280	    await accDb.settings.put({ key: 'owner_permissions', value: JSON.stringify(updated) })
   281	    window.dispatchEvent(new Event('accounting-settings-updated'))
   282	  }
   283	
   284	  const updateCardOrder = async (newOrder) => {
   285	    setCardOrder(newOrder)
   286	    await accDb.settings.put({ key: 'card_order', value: JSON.stringify(newOrder) })
   287	    window.dispatchEvent(new Event('accounting-settings-updated'))
   288	  }
   289	
   290	  const updateShopName = async (name) => {
   291	    setShopName(name)
   292	    await accDb.settings.put({ key: 'shop_name', value: name })
   293	    window.dispatchEvent(new Event('accounting-settings-updated'))
   294	  }
   295	
   296	  const updatePins = async ({ newOwnerPin, newAdminPin }) => {
   297	    let updatedUsers = [...teamUsers]
   298	    if (newOwnerPin !== undefined) {
   299	      if (newOwnerPin !== '' && (!/^\d{4}$/.test(newOwnerPin) || DEFAULT_PINS.has(newOwnerPin))) {
   300	        throw new Error('Choose a 4-digit device PIN other than 1234 or 8888.')
   301	      }
   302	      setOwnerPin(newOwnerPin)
   303	      await accDb.settings.put({ key: 'owner_pin', value: newOwnerPin })
   304	      updatedUsers = updatedUsers.map((u) =>
   305	        u.id === 'user-owner-1' ? { ...u, pin: newOwnerPin } : u
   306	      )
   307	    }
   308	    if (newAdminPin !== undefined) {
   309	      if (newAdminPin !== '' && (!/^\d{4}$/.test(newAdminPin) || DEFAULT_PINS.has(newAdminPin))) {
   310	        throw new Error('Choose a 4-digit device PIN other than 1234 or 8888.')
   311	      }
   312	      setAdminPin(newAdminPin)
   313	      await accDb.settings.put({ key: 'admin_pin', value: newAdminPin })
   314	      updatedUsers = updatedUsers.map((u) =>
   315	        u.id === 'user-admin-1' ? { ...u, pin: newAdminPin } : u
   316	      )
   317	    }
   318	    setTeamUsers(updatedUsers)
   319	    await accDb.settings.put({ key: 'team_users', value: JSON.stringify(updatedUsers) })
   320	    window.dispatchEvent(new Event('accounting-settings-updated'))
   321	  }
   322	
   323	  const saveTeamUser = async (userData) => {
   324	    const cleanRole = userData.role === 'admin' ? 'admin' : 'owner'
   325	    const roleLabel = cleanRole === 'admin' ? 'Admin' : 'Owner · view only'
   326	    const pin = String(userData.pin || (cleanRole === 'admin' ? adminPin : ownerPin)).slice(0, 4)
   327	    if (DEFAULT_PINS.has(pin)) throw new Error('Choose a PIN other than 1234 or 8888.')
   328	
   329	    let nextUsers
   330	    const exists = teamUsers.some((u) => u.id === userData.id)
   331	    if (exists) {
   332	      nextUsers = teamUsers.map((u) =>
   333	        u.id === userData.id
   334	          ? {
   335	            ...u,
   336	            name: userData.name.trim(),
   337	            phone: (userData.phone || '').trim(),
   338	            role: cleanRole,
   339	            roleLabel,
   340	            pin,
   341	          }
   342	          : u
   343	      )
   344	    } else {
   345	      const newUser = {
   346	        id: `user-${Date.now()}`,
   347	        name: userData.name.trim(),
   348	        phone: (userData.phone || '').trim(),
   349	        role: cleanRole,
   350	        roleLabel,
   351	        pin,
   352	        lastSeen: 'Added just now',
   353	      }
   354	      nextUsers = [...teamUsers, newUser]
   355	    }
   356	
   357	    setTeamUsers(nextUsers)
   358	    await accDb.settings.put({ key: 'team_users', value: JSON.stringify(nextUsers) })
   359	
   360	    // If primary owner or admin pin was changed via user edit, keep in sync
   361	    const primaryOwner = nextUsers.find((u) => u.id === 'user-owner-1')
   362	    if (primaryOwner?.pin && primaryOwner.pin !== ownerPin) {
   363	      setOwnerPin(primaryOwner.pin)
   364	      await accDb.settings.put({ key: 'owner_pin', value: primaryOwner.pin })
   365	    }
   366	    const primaryAdmin = nextUsers.find((u) => u.id === 'user-admin-1')
   367	    if (primaryAdmin?.pin && primaryAdmin.pin !== adminPin) {
   368	      setAdminPin(primaryAdmin.pin)
   369	      await accDb.settings.put({ key: 'admin_pin', value: primaryAdmin.pin })
   370	    }
   371	
   372	    window.dispatchEvent(new Event('accounting-settings-updated'))
   373	    return nextUsers
   374	  }
   375	
   376	  const removeTeamUser = async (userId) => {
   377	    const nextUsers = teamUsers.filter((u) => u.id !== userId)
   378	    setTeamUsers(nextUsers)
   379	    await accDb.settings.put({ key: 'team_users', value: JSON.stringify(nextUsers) })
   380	    window.dispatchEvent(new Event('accounting-settings-updated'))
   381	  }
   382	
   383	  const isAuthenticated = Boolean(sessionUser && isPinUnlocked)
   384	  const isOwner = currentRole === 'owner' || currentRole === 'employee'
   385	  const isAdmin = currentRole === 'admin'
   386	  const user = isAuthenticated
   387	    ? { id: sessionUser.id, name: activeUserName || sessionUser.email || 'User', role: currentRole }
   388	    : null
   389	
   390	  const value = {
   391	    isAuthenticated,
   392	    hasSession: Boolean(sessionUser),
   393	    isPinLocked: Boolean(sessionUser && !isPinUnlocked),
   394	    user,
   395	    role: currentRole,
   396	    isAdmin,
   397	    isOwner,
   398	    loading,
   399	    cloudSyncStatus,
   400	    cloudSyncError,
   401	    shopName,
   402	    ownerPin,
   403	    adminPin,
   404	    teamUsers,
   405	    ownerPermissions,
   406	    cardOrder,
   407	    signIn,
   408	    unlockWithPin,
   409	    lock: lockApp,
   410	    signOut,
   411	    syncCloudNow,
   412	    updateOwnerPermission,
   413	    updateCardOrder,
   414	    updateShopName,
   415	    updatePins,
   416	    saveTeamUser,
   417	    removeTeamUser,
   418	  }
   419	
   420	  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
   421	}
   422	
   423	export function useAuth() {
   424	  const context = useContext(AuthContext)
   425	  if (!context) throw new Error('useAuth must be used inside AuthProvider')
   426	  return context
   427	}

Listing when local data triggers a refetch.

```

That explains the “not live” symptom: the browser syncs once at login (and only on local edits for admins). There is no polling, realtime, or refetch on focus. Now the role/view code.

```

**Command**

```bash
cd /home/claude/MeemX-ERP/src && cat -n App.jsx components/ProtectedRoute.jsx && sed -n 1,140p components/Nav.jsx && grep -n "role\|Role" pages/SettingsControlPage.jsx components/AddUserModal.jsx pages/Login.jsx | head -80; cat ../supabase/functions/create-user/index.ts | sed -n 1,146p
```

**Output**

```text
     1	import { Suspense, lazy } from 'react'
     2	import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
     3	import { AuthProvider } from './context/AuthContext'
     4	import ProtectedRoute from './components/ProtectedRoute'
     5	import Login from './pages/Login'
     6	
     7	// Route-level code splitting matching PDF specification
     8	const DashboardPage = lazy(() => import('./pages/DashboardPage'))
     9	const DebtorsPage = lazy(() => import('./pages/DebtorsPage'))
    10	const CreditorsPage = lazy(() => import('./pages/CreditorsPage'))
    11	const SalesPage = lazy(() => import('./pages/SalesPage'))
    12	const InventoryPage = lazy(() => import('./pages/InventoryPage'))
    13	const ExpensesPage = lazy(() => import('./pages/ExpensesPage'))
    14	const LoansPage = lazy(() => import('./pages/LoansPage'))
    15	const TallyIntegrationPage = lazy(() => import('./pages/TallyIntegrationPage'))
    16	const SettingsControlPage = lazy(() => import('./pages/SettingsControlPage'))
    17	
    18	export default function App() {
    19	  return (
    20	    <BrowserRouter>
    21	      <AuthProvider>
    22	        <Suspense
    23	          fallback={
    24	            <div className="min-h-screen bg-[#f4f7f4] flex items-center justify-center text-[#11382f]">
    25	              <div className="flex items-center gap-3">
    26	                <div className="w-5 h-5 border-2 border-[#0e655d] border-t-transparent rounded-full animate-spin" />
    27	                <span className="text-xs font-bold text-[#55736a]">Loading books...</span>
    28	              </div>
    29	            </div>
    30	          }
    31	        >
    32	          <Routes>
    33	            <Route path="/login" element={<Login />} />
    34	
    35	            {/* Dashboard routes */}
    36	            <Route
    37	              path="/"
    38	              element={
    39	                <ProtectedRoute>
    40	                  <DashboardPage />
    41	                </ProtectedRoute>
    42	              }
    43	            />
    44	            <Route
    45	              path="/dashboard"
    46	              element={
    47	                <ProtectedRoute>
    48	                  <DashboardPage />
    49	                </ProtectedRoute>
    50	              }
    51	            />
    52	
    53	            {/* Debtors / Parties */}
    54	            <Route
    55	              path="/debtors"
    56	              element={
    57	                <ProtectedRoute>
    58	                  <DebtorsPage />
    59	                </ProtectedRoute>
    60	              }
    61	            />
    62	            <Route path="/parties" element={<Navigate to="/debtors" replace />} />
    63	
    64	            {/* Creditors */}
    65	            <Route
    66	              path="/creditors"
    67	              element={
    68	                <ProtectedRoute>
    69	                  <CreditorsPage />
    70	                </ProtectedRoute>
    71	              }
    72	            />
    73	
    74	            {/* Sales */}
    75	            <Route
    76	              path="/sales"
    77	              element={
    78	                <ProtectedRoute>
    79	                  <SalesPage />
    80	                </ProtectedRoute>
    81	              }
    82	            />
    83	
    84	            {/* Inventory / Stock */}
    85	            <Route
    86	              path="/inventory"
    87	              element={
    88	                <ProtectedRoute>
    89	                  <InventoryPage />
    90	                </ProtectedRoute>
    91	              }
    92	            />
    93	            <Route path="/stock" element={<Navigate to="/inventory" replace />} />
    94	            <Route path="/materials" element={<Navigate to="/inventory" replace />} />
    95	
    96	            {/* Expenses */}
    97	            <Route
    98	              path="/expenses"
    99	              element={
   100	                <ProtectedRoute>
   101	                  <ExpensesPage />
   102	                </ProtectedRoute>
   103	              }
   104	            />
   105	
   106	            {/* Loans & Advances */}
   107	            <Route
   108	              path="/loans"
   109	              element={
   110	                <ProtectedRoute>
   111	                  <LoansPage />
   112	                </ProtectedRoute>
   113	              }
   114	            />
   115	            <Route path="/banking" element={<Navigate to="/loans" replace />} />
   116	
   117	            {/* Tally Import */}
   118	            <Route
   119	              path="/tally"
   120	              element={
   121	                <ProtectedRoute adminOnly>
   122	                  <TallyIntegrationPage />
   123	                </ProtectedRoute>
   124	              }
   125	            />
   126	            <Route path="/imports" element={<Navigate to="/tally" replace />} />
   127	
   128	            {/* App Settings & Admin Control */}
   129	            <Route
   130	              path="/settings"
   131	              element={
   132	                <ProtectedRoute adminOnly>
   133	                  <SettingsControlPage />
   134	                </ProtectedRoute>
   135	              }
   136	            />
   137	            <Route
   138	              path="/control"
   139	              element={
   140	                <ProtectedRoute adminOnly>
   141	                  <SettingsControlPage />
   142	                </ProtectedRoute>
   143	              }
   144	            />
   145	
   146	            <Route path="*" element={<Navigate to="/" replace />} />
   147	          </Routes>
   148	        </Suspense>
   149	      </AuthProvider>
   150	    </BrowserRouter>
   151	  )
   152	}
   153	import { Navigate } from 'react-router-dom'
   154	import { useAuth } from '../context/AuthContext'
   155	
   156	export default function ProtectedRoute({ children, adminOnly = false }) {
   157	  const { isAuthenticated, isAdmin, loading } = useAuth()
   158	
   159	  if (loading) {
   160	    return (
   161	      <div className="flex min-h-screen items-center justify-center gap-3 bg-[#f4f7f4] text-[#11382f]">
   162	        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#0e655d] border-t-transparent" />
   163	        <span className="text-xs font-bold text-[#56736a]">Loading books…</span>
   164	      </div>
   165	    )
   166	  }
   167	
   168	  if (!isAuthenticated) {
   169	    return <Navigate to="/login" replace />
   170	  }
   171	
   172	  if (adminOnly && !isAdmin) {
   173	    return <Navigate to="/" replace />
   174	  }
   175	
   176	  return children
   177	}
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
pages/SettingsControlPage.jsx:134:      const debtors = allParties.filter((p) => (p.role === 'customer' || p.role === 'debtor') && Number(p.current_balance) > 0)
pages/SettingsControlPage.jsx:202:        {saveError && <p role="alert" className="mb-4 text-right text-xs font-semibold text-rose-700">{saveError}</p>}
pages/SettingsControlPage.jsx:382:                These PINs only unlock this device after account sign-in. Account roles come from the user profile.
components/AddUserModal.jsx:25:  const [role, setRole] = useState('owner') // 'owner' | 'admin'
components/AddUserModal.jsx:36:      setRole(editingUser.role === 'admin' ? 'admin' : 'owner')
components/AddUserModal.jsx:41:      setRole('owner')
components/AddUserModal.jsx:104:        role,
components/AddUserModal.jsx:199:            This PIN only unlocks the current device after account sign-in. Account roles come from your profile.
pages/Login.jsx:111:            {error && <p role="alert" className="flex items-center gap-1.5 text-xs font-semibold text-[#b83e29]"><AlertCircle size={15} />{error}</p>}
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Server environment not properly configured' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 1. Verify caller session using caller's JWT
    const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const {
      data: { user: callerUser },
      error: userError,
    } = await callerClient.auth.getUser()

    if (userError || !callerUser) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired caller session' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify caller role is owner from profiles table
    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles')
      .select('role')
      .eq('id', callerUser.id)
      .single()

    if (profileError || callerProfile?.role !== 'owner') {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: Only an owner can create new users' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // 2. Parse request payload
    const body = await req.json().catch(() => ({}))
    const { email, password, role, fullName } = body

    if (!email || typeof email !== 'string' || !email.trim()) {
      return new Response(
        JSON.stringify({ error: 'Valid email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!password || typeof password !== 'string' || password.length < 6) {
      return new Response(
        JSON.stringify({ error: 'Password must be at least 6 characters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const assignedRole = role === 'owner' ? 'owner' : 'employee'

    // 3. Admin client with elevated service role
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    // Create user in Auth
    const { data: newUserData, error: createError } = await adminClient.auth.admin.createUser({
      email: email.trim(),
      password: password,
      email_confirm: true,
      user_metadata: {
        full_name: fullName?.trim() || '',
        role: assignedRole,
      },
    })

    if (createError || !newUserData?.user) {
      return new Response(
        JSON.stringify({ error: createError?.message || 'Failed to create user in Auth' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const createdUserId = newUserData.user.id

    // Upsert into profiles table with chosen role
    const { error: upsertError } = await adminClient.from('profiles').upsert({
      id: createdUserId,
      role: assignedRole,
      full_name: fullName?.trim() || email.trim().split('@')[0],
    })

    if (upsertError) {
      return new Response(
        JSON.stringify({ error: `User created, but profile update failed: ${upsertError.message}` }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        user: {
          id: createdUserId,
          email: newUserData.user.email,
          role: assignedRole,
          full_name: fullName?.trim() || '',
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && sed -n 1,200p ExpensesPage.jsx | head -170; echo =====DASH; grep -n "useLiveQuery\|calculateDashboardMetrics\|ownerPermissions\|isAdmin\|isOwner\|current_balance\|age_bucket\|deleted_at\|profit\|Profit" DashboardPage.jsx | head -70
```

**Output**

```text
import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  FileSpreadsheet,
  Edit3,
  TrendingDown,
} from 'lucide-react'
import Nav from '../components/Nav'
import { accDb } from '../lib/accountingDb'
import AdminEditModal from '../components/AdminEditModal'

export default function ExpensesPage() {
  const navigate = useNavigate()
  const [categories, setCategories] = useState([])
  const [editingExpense, setEditingExpense] = useState(null)

  // Load expenses from Dexie ledgers/vouchers
  const loadExpenses = useCallback(async () => {
    try {
      const expLedgers = await accDb.ledgers.where('category').equals('expense').toArray()
      if (expLedgers && expLedgers.length > 0) {
        setCategories(
          expLedgers.map((l) => ({
            id: l.id,
            name: l.name,
            rawAmount: Number(l.current_balance) || 0,
          }))
        )
      } else {
        setCategories([])
      }
    } catch {
      setCategories([])
    }
  }, [])

  useEffect(() => {
    loadExpenses()
    const onUpdate = () => loadExpenses()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadExpenses])

  // Total monthly expenses
  const totalExpenses = useMemo(() => {
    return categories.reduce((sum, c) => sum + (Number(c.rawAmount) || 0), 0)
  }, [categories])

  const maxExpense = useMemo(() => {
    return Math.max(...categories.map((c) => Number(c.rawAmount) || 0), 120000)
  }, [categories])

  const formatAmount = (amt) => {
    if (amt >= 100000) return `₹${(amt / 100000).toFixed(1)}L`
    if (amt >= 1000) return `₹${(amt / 1000).toFixed(0)}K`
    return `₹${amt}`
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header with Back button (PDF Page 8) */}
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
              Expenses
            </h1>
          </div>

          <button
            type="button"
            onClick={() => navigate('/tally')}
            className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
            title="Import vouchers from Tally XML"
          >
            <FileSpreadsheet size={16} />
            <span>Tally import</span>
          </button>
        </header>

        {/* Featured This Month Card (PDF Page 8) */}
        <div className="mb-6 rounded-3xl border border-[#e1e9e3] bg-white p-6 shadow-xs">
          <span className="text-xs font-bold text-[#6a847c]">This month</span>
          <strong className="mt-1 block text-[38px] font-extrabold tracking-tight text-[#c25e19]">
            {formatAmount(totalExpenses)}
          </strong>
          <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-[#147366]">
            <TrendingDown size={14} /> 4% vs last month
          </span>
        </div>

        {/* By Category Section (PDF Page 8) */}
        <section className="rounded-3xl border border-[#e1e9e3] bg-white p-6 shadow-xs">
          <h2 className="text-[17px] font-extrabold text-[#11382f] mb-4">
            By category
          </h2>

          <div className="space-y-5">
            {categories.length > 0 ? (
              categories.map((cat) => {
                const amt = Number(cat.rawAmount) || 0
                const percentage = Math.min(100, Math.max(8, Math.round((amt / maxExpense) * 100)))
                const barColor = amt >= 80000 ? 'bg-[#b8521a]' : 'bg-[#cfa472]'

                return (
                  <div key={cat.id || cat.name} className="group">
                    <div className="flex items-center justify-between text-sm font-extrabold text-[#11382f] mb-1.5">
                      <div className="flex items-center gap-2">
                        <span>{cat.name}</span>
                        <button
                          type="button"
                          onClick={() => setEditingExpense({ id: cat.id, name: cat.name, current_balance: amt, category: 'expense' })}
                          className="opacity-75 group-hover:opacity-100 inline-flex items-center gap-1 rounded-md border border-[#cfded6] bg-[#f8faf9] px-2 py-0.5 text-[10px] font-bold text-[#0e655d] hover:bg-[#ebf3ef] transition"
                          title="Admin Edit expense"
                        >
                          <Edit3 size={11} />
                          <span>Edit</span>
                        </button>
                      </div>
                      <span>{formatAmount(amt)}</span>
                    </div>
                    <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-[#edebe9]">
                      <div
                        className={`h-full rounded-full ${barColor} transition-all duration-300`}
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                )
              })
            ) : (
              <div className="py-6 text-center">
                <p className="text-sm font-bold text-[#11382f]">No expenses recorded</p>
                <p className="text-xs text-[#6e8a81] mt-1">
                  Import Tally Payment vouchers or expense ledgers to populate categories.
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Admin Edit Modal */}
        <AdminEditModal
          isOpen={Boolean(editingExpense)}
          onClose={() => setEditingExpense(null)}
          type="ledger"
          item={editingExpense}
          onSaved={() => loadExpenses()}
        />
      </main>
    </div>
  )
}
=====DASH
14:import { calculateDashboardMetrics } from '../lib/dashboardMetrics'
20:    isAdmin,
22:    ownerPermissions,
65:        const debtorsSum = debtors.reduce((s, d) => s + (Number(d.current_balance) || 0), 0)
66:        const creditorsSum = creditors.reduce((s, c) => s + (Number(c.current_balance) || 0), 0)
76:          .reduce((s, l) => s + (Number(l.current_balance) || 0), 0)
79:          .reduce((s, l) => s + (Number(l.current_balance) || 0), 0)
82:        const calculated = calculateDashboardMetrics(vouchers, ledgers)
115:          .filter((d) => (Number(d.current_balance) || 0) > 0)
116:          .sort((a, b) => (Number(b.current_balance) || 0) - (Number(a.current_balance) || 0))
122:              age: d.age_bucket || (days > 60 ? '60d+' : days > 30 ? '31–60d' : '0–30d'),
129:              amount: `₹${(Number(d.current_balance) || 0).toLocaleString('en-IN')}`,
164:        profit: { value: pVal == null ? '—' : formatMoney(pVal), diff: pVal == null ? 'Profit details incomplete' : liveMetrics?.operatingResultBasis?.today || 'Sales less item costs & expenses', isPositive: pVal != null && pVal >= 0 },
177:        profit: { value: pVal == null ? '—' : formatMoney(pVal), diff: pVal == null ? 'Profit details incomplete' : liveMetrics?.operatingResultBasis?.week || 'Sales less item costs & expenses', isPositive: pVal != null && pVal >= 0 },
190:        profit: { value: pVal == null ? '—' : formatMoney(pVal), diff: pVal == null ? 'Profit details incomplete' : liveMetrics?.operatingResultBasis?.month || 'Sales less item costs & expenses', isPositive: pVal != null && pVal >= 0 },
232:      ['Operating result (sales less item costs & recorded expenses)', metrics.profit.value],
266:    profit: {
267:      id: 'profit',
270:      value: metrics.profit.value,
271:      badge: metrics.profit.diff,
329:    if (editLayout && isAdmin) return true
330:    if (isAdmin) return true
331:    return ownerPermissions[id] !== false
349:            {isAdmin && (
364:              aria-label={isAdmin ? 'Admin account' : 'Owner account'}
366:              {isAdmin ? 'A' : 'S'}
375:              {isAdmin && editLayout ? 'Dashboard' : 'Good evening'}
378:              {isAdmin && editLayout
386:              {isAdmin ? 'Admin account' : 'Owner view'}
436:        {isAdmin && editLayout && (
464:        {isAdmin && !editLayout && (
481:            const isOwnerHidden = ownerPermissions[cardId] === false
495:                  {editLayout && isAdmin && (
501:                          updateOwnerPermission(card.id, isOwnerHidden)
504:                        title={isOwnerHidden ? 'Show to owner' : 'Hide from owner'}
506:                        {isOwnerHidden ? <EyeOff size={16} /> : <Eye size={16} />}
532:                    {isOwnerHidden && (
553:                {editLayout && isAdmin && (
575:                      onClick={() => updateOwnerPermission(card.id, isOwnerHidden)}
577:                        isOwnerHidden
581:                      title={isOwnerHidden ? 'Show to owner' : 'Hide from owner'}
583:                      {isOwnerHidden ? <EyeOff size={14} /> : <Eye size={14} />}
618:                  {isOwnerHidden && (

```

The Expenses page is clearly broken: “This month” is the sum of cumulative ledger balances, “4% vs last month” is hardcoded text, and the scale baseline is hardcoded to 120000. Now Debtors and Sales.

```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && sed -n 1,140p DebtorsPage.jsx; echo =====SALES; sed -n 1,110p SalesPage.jsx
```

**Output**

```text
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
import Nav from '../components/Nav'
import AdminEditModal from '../components/AdminEditModal'

export default function DebtorsPage() {
  const { shopName } = useAuth()
  const navigate = useNavigate()
  const [searchTerm, setSearchTerm] = useState('')
  const [customers, setCustomers] = useState([])
  const [whatsappSent, setWhatsappSent] = useState(null)
  const [callModal, setCallModal] = useState(null)
  const [editingDebtor, setEditingDebtor] = useState(null)

  // Load debtors from Dexie DB
  const loadDebtors = useCallback(async () => {
    try {
      const dbDebtors = await accDb.parties.where('type').equals('debtor').toArray()
      if (dbDebtors && dbDebtors.length > 0) {
        setCustomers(dbDebtors)
      } else {
        setCustomers([])
      }
    } catch {
      setCustomers([])
    }
  }, [])

  useEffect(() => {
    loadDebtors()
    const onUpdate = () => loadDebtors()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadDebtors])

  // Total owed to you
  const totalOwed = useMemo(() => {
    return customers.reduce((acc, c) => acc + (Number(c.current_balance) || 0), 0)
  }, [customers])

  // 3-segment Aging Breakdown (0-30d, 31-60d, 60d+)
  const agingStats = useMemo(() => {
    let cat0to30 = 0
    let cat31to60 = 0
    let cat60plus = 0

    customers.forEach((c) => {
      const bal = Number(c.current_balance) || 0
      const days = Number(c.due_days) || 10
      if (days > 60) cat60plus += bal
      else if (days > 30) cat31to60 += bal
      else cat0to30 += bal
    })

    const total = cat0to30 + cat31to60 + cat60plus || 1
    const p1 = Math.round((cat0to30 / total) * 100)
    const p2 = Math.round((cat31to60 / total) * 100)
    const p3 = Math.max(0, 100 - p1 - p2)

    return {
      cat0to30,
      cat31to60,
      cat60plus,
      p1: `${p1}%`,
      p2: `${p2}%`,
      p3: `${p3}%`,
    }
  }, [customers])

  const filteredCustomers = useMemo(() => {
    if (!searchTerm.trim()) return customers
    const term = searchTerm.toLowerCase()
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        (c.phone && c.phone.includes(term)) ||
        (c.uid && c.uid.toLowerCase().includes(term))
    )
  }, [customers, searchTerm])

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

  // Add Debtor Handler
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

          <button
            type="button"
            onClick={() => navigate('/tally')}
            className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
            title="Import debtors and closing balances from Tally"
          >
            <FileSpreadsheet size={16} strokeWidth={2.5} />
            <span>Tally import</span>
          </button>
        </header>

        {/* Total Owed Card & 3-segment Aging Progress Bar (PDF Page 2) */}
        <div className="mb-5 rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs">
=====SALES
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
import { calculateSalesMetrics } from '../lib/dashboardMetrics'

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
      const dbVouchers = await accDb.vouchers
        .where('voucher_type')
        .equals('sales')
        .reverse()
        .sortBy('id')

      if (dbVouchers && dbVouchers.length > 0) {
        const mapped = dbVouchers.map((v) => {
          const isDue = Number(v.due_amount) > 0 || v.status === 'Due'
          return {
            ...v,
            displayDate: v.displayDate || formatInvoiceDate(v.date),
            status: isDue ? 'Due' : 'Paid',
            statusTone: isDue
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
```

**Command**

```bash
cd /home/claude/MeemX-ERP/tests && cat dashboard_metrics.test.mjs; sed -n 1,60p accounting_voucher.test.mjs; grep -n "test(" sync_service.test.mjs | head -30; sed -n 170,215p test_connector.mjs; ls ../node_modules | grep -i "fast-xml\|fake-indexeddb"
```

**Output**

```text
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calculateDashboardMetrics, calculateExpenseMetrics, calculateSalesMetrics } from '../src/lib/dashboardMetrics.js'

describe('calculateSalesMetrics', () => {
  const now = new Date(2026, 9, 28, 12)

  it('uses local calendar boundaries and the last seven days', () => {
    const result = calculateSalesMetrics([
      { voucher_type: 'sales', date: '2026-10-22', amount: 10 },
      { voucher_type: 'sales', date: '2026-10-28', amount: 20 },
      { voucher_type: 'sales', date: '2026-10-21', amount: 100 },
      { voucher_type: 'sales', date: '2026-09-30', amount: 200 },
      { voucher_type: 'payment', date: '2026-10-28', amount: 500 },
    ], now)

    assert.equal(result.salesToday, 20)
    assert.equal(result.salesWeek, 30)
    assert.equal(result.salesMonth, 130)
    assert.equal(result.sales7DaysTotal, 30)
    assert.equal(result.sales7Days.length, 7)
    assert.equal(result.sales7Days[0].date, '2026-10-22')
    assert.equal(result.sales7Days[6].date, '2026-10-28')
  })

  it('keeps a zero-sales month at zero instead of falling back to all-time sales', () => {
    const result = calculateSalesMetrics([
      { voucher_type: 'sales', date: '2026-09-30', amount: 200 },
    ], now)

    assert.equal(result.salesMonth, 0)
    assert.equal(result.salesToday, 0)
    assert.equal(result.salesWeek, 0)
  })

  it('counts dated expense payments but excludes supplier payments and ledger balances', () => {
    const ledgers = [{ name: 'Transport', category: 'expense', current_balance: 9999 }]
    const vouchers = [
      { voucher_type: 'payment', party_name: 'Transport', date: '2026-10-28', amount: 50 },
      { voucher_type: 'payment', party_name: 'Transport', date: '2026-10-20', amount: 70 },
      { voucher_type: 'payment', party_name: 'Supplier A', date: '2026-10-28', amount: 500 },
    ]
    assert.deepEqual(calculateExpenseMetrics(vouchers, ledgers, now), { today: 50, week: 50, month: 120 })
  })

  it('calculates the operating result only when every sale has recorded item costs', () => {
    const result = calculateDashboardMetrics([
      { voucher_type: 'sales', date: '2026-10-28', amount: 100, items: [{ qty: 5, cost_rate: 6 }] },
      { voucher_type: 'payment', date: '2026-10-28', amount: 10, party_name: 'Transport' },
    ], [{ name: 'Transport', group: 'Indirect Expenses' }], now)

    assert.equal(result.salesToday, 100)
    assert.equal(result.expensesToday, 10)
    assert.equal(result.operatingResultToday, 60)
    assert.equal(result.operatingResultWeek, 60)
  })

  it('marks the operating result unavailable when a sale has no item cost details', () => {
    const result = calculateDashboardMetrics([
      { voucher_type: 'sales', date: '2026-10-28', amount: 100, items: [{ qty: 2 }] },
    ], [], now)

    assert.equal(result.salesToday, 100)
    assert.equal(result.operatingResultToday, null)
  })
})
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cr9yMnTm4NSzvG9rrwjM2ec8xZgh1cafXH8 } from '../src/lib/accountingDb.js'

class MemoryTable {
  constructor(rows = []) {
    this.rows = rows.map((row) => structuredClone(row))
    this.nextId = Math.max(0, ...this.rows.map((row) => Number(row.id) || 0)) + 1
    this.failPut = false
  }
  async toArray() { return this.rows.map((row) => structuredClone(row)) }
  async get(id) { const row = this.rows.find((item) => item.id === id); return row && structuredClone(row) }
  async add(row) {
    const id = this.nextId++
    this.rows.push({ ...structuredClone(row), id })
    return id
  }
  async put(row) {
    if (this.failPut) throw new Error('simulated write failure')
    const index = this.rows.findIndex((item) => item.id === row.id)
    if (index < 0) this.rows.push(structuredClone(row))
    else this.rows[index] = structuredClone(row)
    return row.id
  }
  async update(id, changes) {
    const row = this.rows.find((item) => item.id === id)
    if (!row) return 0
    Object.assign(row, structuredClone(changes))
    return 1
  }
  async delete(id) { this.rows = this.rows.filter((row) => row.id !== id) }
  where(field) {
    return {
      equals: (value) => ({ first: async () => this.rows.find((row) => row[field] === value) && structuredClone(this.rows.find((row) => row[field] === value)) }),
      equalsIgnoreCase: (value) => ({ first: async () => {
        const row = this.rows.find((item) => String(item[field] || '').toLowerCase() === String(value || '').toLowerCase())
        return row && structuredClone(row)
      } }),
    }
  }
}

class MemorySettings {
  constructor(rows = []) { this.rows = new Map(rows.map((row) => [row.key, structuredClone(row)])) }
  async get(key) { const row = this.rows.get(key); return row && structuredClone(row) }
  async put(row) { this.rows.set(row.key, structuredClone(row)) }
}

class MemoryDatabase {
  constructor(seed) {
    for (const [name, rows] of Object.entries(seed)) this[name] = new MemoryTable(rows)
    this.settings = new MemorySettings()
  }
  async transaction(_mode, _tables, work) {
    const tableSnapshots = Object.fromEntries(Object.entries(this)
      .filter(([, value]) => value instanceof MemoryTable)
      .map(([name, table]) => [name, structuredClone(table.rows)]))
    const settingsSnapshot = new Map(this.settings.rows)
    try {
      return await work()

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Connector: config', () => {
  it('refuses non-loopback host without --allow-remote', () => {
    assert.throws(
      () => loadConfig({}, {
        TALLY_HOST: '192.168.1.100',
        TALLY_PORT: '9000',
        TALLY_COMPANY: 'TestCo',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY: 'key',
        SUPABASE_EMAIL: 'a@b.com',
        SUPABASE_PASSWORD: 'pass',
      }),
      /not a loopback address/
    )
  })

  it('allows non-loopback host with --allow-remote', () => {
    // Suppress console.warn for this test
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const cfg = loadConfig({ allowRemote: true }, {
        TALLY_HOST: '10.0.0.5',
        TALLY_PORT: '9000',
        TALLY_COMPANY: 'TestCo',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY: 'key',
        SUPABASE_EMAIL: 'a@b.com',
        SUPABASE_PASSWORD: 'pass',
      })
      assert.equal(cfg.tally.host, '10.0.0.5')
      assert.equal(cfg.allowRemote, true)
    } finally {
      console.warn = origWarn
    }
  })

  it('requires TALLY_COMPANY', () => {
    assert.throws(
      () => loadConfig({}, {
        TALLY_HOST: '127.0.0.1',
        TALLY_PORT: '9000',
        SUPABASE_URL: 'https://test.supabase.co',

Extending the import to tombstone vouchers removed from Tally.
```

**Command**

```bash
cd /home/claude/MeemX-ERP && npm i -D fast-xml-parser@4 --silent 2>&1 | tail -2; ls node_modules/fast-xml-parser/package.json && git status --short | head
```

**Output**

```text
node_modules/fast-xml-parser/package.json
 M package-lock.json
 M package.json
Pure, testable Tally XML parser shared by the edge function and Node tests
parser.js
```

**Command**

```bash
cd /home/claude/MeemX-ERP/supabase/functions/tally-import && python3 - <<'EOF'
src = open('index.ts').read()
start = src.index("const corsHeaders")
tail_start = src.index("async function parseSheet")
header = """import { createClient } from 'npm:@supabase/supabase-js@2'
import { XMLParser, XMLValidator } from 'npm:fast-xml-parser@4'
import * as XLSX from 'npm:xlsx@0.18.5'
import {
  parseTallyXml, classifyVoucherType, normalDate, signedAmount, val, digest,
} from './parser.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
// Tally day-ranges are split by the connector well below this; the cap only guards the function.
const MAX_BYTES = 8 * 1024 * 1024
const rowMessages = (row) => {
  const messages = []
  if (!row.payload?.name && ['ledger','party','stock_item'].includes(row.rowType)) messages.push('Master name is missing')
  if (row.rowType === 'voucher') {
    if (!row.payload?.voucher_no) messages.push('Voucher number is missing')
    if (!row.payload?.date) messages.push('Date is missing or invalid')
    if (!row.payload?.voucher_type) messages.push('Voucher type is not supported')
    if (!Number.isFinite(Number(row.payload?.amount)) || Number(row.payload.amount) <= 0) messages.push('Voucher amount is missing or zero')
  }
  return messages
}

"""
body = src[tail_start:]
# parseSheet: use shared helpers
body = body.replace("const amount = Math.abs(num(rawAmount)) || Math.max(Math.abs(num(debit)), Math.abs(num(credit)))",
                    "const amount = Math.abs(signedAmount(rawAmount)) || Math.max(Math.abs(signedAmount(debit)), Math.abs(signedAmount(credit)))")
body = body.replace("voucher_type: typeNormal(get(/vouchertype|vouchertypename|^type$/)),",
                    "voucher_type: classifyVoucherType(get(/vouchertype|vouchertypename|^type$/)).type,")
open('index.ts','w').write(header + body)
EOF
grep -n "typeNormal\|num(" index.ts | head
```

**Output**

```text
exit code 0
```

**Command**

```bash
cd /home/claude/MeemX-ERP/supabase/functions/tally-import && python3 - <<'EOF'
src = open('index.ts').read()

old_parse = "    let rows = extension === 'xml' ? await parseXml(new TextDecoder().decode(bytes), company) : await parseSheet(bytes, company)\n    if (!rows.length) throw new Error('No supported voucher, ledger, or stock-item rows were found.')\n"
new_parse = """    // Optional sync window: lets commit tombstone vouchers that were deleted/cancelled in Tally.
    let syncWindow = null
    if (body.window) {
      const from = normalDate(body.window.from), to = normalDate(body.window.to)
      if (!from || !to || from > to) throw new Error('window.from / window.to must be valid dates (from <= to).')
      if (!body.companyName) throw new Error('companyName is required when a sync window is supplied.')
      syncWindow = { from, to, company }
    }
    let rows = []
    let ignored = { nonAccounting: 0, cancelled: 0, optional: 0 }
    if (extension === 'xml') {
      // Group hierarchy lets sub-groups of Sundry Debtors/Creditors etc. resolve to their primary group.
      const groupParents = {}
      if (body.groups && typeof body.groups === 'object') {
        for (const [name, parent] of Object.entries(body.groups)) groupParents[String(name)] = String(parent ?? '')
      }
      const { data: cashRows, error: cashError } = await adminClient.from('ledgers').select('name').in('group', ['Cash-in-hand', 'Bank Accounts', 'Bank OD A/c'])
      if (cashError) throw new Error('Could not load cash/bank ledgers: ' + cashError.message)
      const cashLedgerNames = new Set((cashRows || []).map((row) => String(row.name).toLowerCase()))
      const parsed = await parseTallyXml(new TextDecoder().decode(bytes), company, { XMLParser, XMLValidator }, { groupParents, cashLedgerNames })
      rows = parsed.rows
      ignored = parsed.ignored
    } else {
      rows = await parseSheet(bytes, company)
    }
    if (!rows.length && !syncWindow) throw new Error('No supported voucher, ledger, or stock-item rows were found.')
"""
assert old_parse in src
src = src.replace(old_parse, new_parse)

old_counts = "    const counts = { total: staged.length, valid, duplicates, problems }\n"
new_counts = "    const counts = { total: staged.length, valid, duplicates, problems, ignored, ...(syncWindow ? { window: syncWindow } : {}) }\n"
assert old_counts in src
src = src.replace(old_counts, new_counts)
open('index.ts','w').write(src)
EOF
grep -n "disambiguateVoucherNumbers(adminClient, body.jobId)" index.ts
```

**Output**

```text
176:      await disambiguateVoucherNumbers(adminClient, body.jobId)

New migration: live sync, signed balances, deletion reconcile, shared view settings
20261031120000_live_sync_signed_balances_reconcile.sql
```

**Command**

```bash
cd /home/claude/MeemX-ERP/supabase/migrations && python3 - <<'EOF'
p='20261031120000_live_sync_signed_balances_reconcile.sql'
s=open(p).read()
a=s.index("      -- Keep the ledger mirror")
b=s.index("    elsif v_row.row_type = 'stock_item' then")
s=s[:a].rstrip()+"\n\n"+s[b:]
open(p,'w').write(s)
EOF
sed -n 118,135p 20261031120000_live_sync_signed_balances_reconcile.sql
```

**Output**

```text
      nullif(v_payload->>'closing_balance', '')::numeric,
      nullif(v_payload->>'current_balance', '')::numeric,
      v_opening
    );

    if v_row.row_type = 'ledger' then
      select id into v_ledger_id from public.ledgers where lower(name) = lower(v_name) limit 1 for update;
      if v_ledger_id is null then
        insert into public.ledgers(name, "group", primary_group, opening_balance, current_balance, is_system, category)
        values (v_name, coalesce(v_payload->>'group', 'General'), nullif(v_payload->>'primary_group', ''),
                v_opening, v_current, false, coalesce(nullif(v_payload->>'category', ''), 'asset'));
        v_inserted := v_inserted + 1;
      else
        update public.ledgers
        set "group" = coalesce(nullif(v_payload->>'group', ''), "group"),
            primary_group = coalesce(nullif(v_payload->>'primary_group', ''), primary_group),
            opening_balance = v_opening,
            current_balance = v_current,
```

**Command**

```bash
cd /tmp && (which psql pg_ctl postgres 2>/dev/null; ls /usr/lib/postgresql 2>/dev/null) ; (nohup sh -c 'apt-get install -y -qq postgresql >/tmp/pg_install.log 2>&1' >/dev/null 2>&1 &) ; sleep 1; echo started
```

**Output**

```text
started

Meanwhile, the connector. First config.mjs (company required, IPv6 host parsing, empty-env handling, port validation) and tally_client.mjs (HTTP status check, double-backoff).
```

**Command**

```bash
cd /home/claude/MeemX-ERP/connector && python3 - <<'EOF'
p='config.mjs'
s=open(p).read()

# empty env values must not shadow lower-priority sources
s=s.replace("const get = (key) => cliFlags[key] ?? env[key] ?? dotEnv[key] ?? rootEnv[key] ?? ''",
"""// Empty strings count as "unset" so an empty process variable cannot shadow connector/.env.
  const get = (key) => [cliFlags[key], env[key], dotEnv[key], rootEnv[key]].find((v) => v !== undefined && v !== null && v !== '') ?? ''""")

old=s[s.index("  let host = get('TALLY_HOST') || '127.0.0.1'"):s.index("  const supabaseUrl")]
new="""  const host = parseHost(get('TALLY_HOST') || '127.0.0.1')
  const portRaw = get('TALLY_PORT') || '9000'
  const port = Number(portRaw)
  const company = get('TALLY_COMPANY').trim()
  const allowRemote = !!cliFlags.allowRemote

"""
s=s.replace(old,new)

s=s.replace("""  // --- Validation ---
  const errors = []
""","""  // --- Validation ---
  const errors = []
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`TALLY_PORT="${portRaw}" is not a valid port.`)
  // Without an explicit company Tally answers for whichever company is open on screen,
  // which silently syncs the wrong books when someone switches company.
  if (!company) errors.push('TALLY_COMPANY is required (the company name exactly as shown in Tally).')
""")

s=s.replace("""/**
 * Build and validate configuration.""","""/** Strip scheme/path/port from a host string, keeping IPv6 literals intact. */
export function parseHost(raw) {
  let host = String(raw).trim().replace(/^https?:\\/\\//i, '').replace(/\\/.*$/, '')
  const bracketed = host.match(/^\\[([^\\]]+)\\](?::\\d+)?$/)
  if (bracketed) return bracketed[1]
  // A bare IPv6 address contains several colons; host:port contains exactly one.
  if ((host.match(/:/g) || []).length === 1) host = host.split(':')[0]
  return host
}

/**
 * Build and validate configuration.""")
open(p,'w').write(s)

p='tally_client.mjs'
s=open(p).read()
s=s.replace("  const url = `http://${config.host}:${config.port}`\n","  const hostPart = config.host.includes(':') ? `[${config.host}]` : config.host   // IPv6 literal\n  const url = `http://${hostPart}:${config.port}`\n")
# HTTP status check
s=s.replace("""      const buffer = await response.arrayBuffer()
      const text = decodeTallyResponse(buffer)
""","""      if (response.status && !response.ok && response.status >= 500) {
        throw new Error(`Tally HTTP ${response.status}`)   // transient: retried below
      }
      const buffer = await response.arrayBuffer()
      const text = decodeTallyResponse(buffer)
""")
# remove the double backoff: the loop top already sleeps
a=s.index("          if (attempt < maxRetries) {\n            const backoff = initialBackoffMs * Math.pow(2, attempt)")
b=s.index("          throw lastError\n        }\n\n        throw new TallyError")
s=s[:a]+"          if (attempt < maxRetries) {\n            process.stderr.write(`   ⏳ Tally still loading (attempt ${attempt + 1}/${maxRetries + 1}), retrying…\\n`)\n            continue   // the loop top applies the backoff once\n          }\n"+s[b:]
open(p,'w').write(s)
EOF
node -e "import('./config.mjs').then(m=>{console.log(m.parseHost('::1'),m.parseHost('[::1]:9000'),m.parseHost('http://localhost:9000/x'),m.parseHost('10.0.0.5:9000'))})"
```

**Output**

```text
::1 ::1 localhost 10.0.0.5

Working through the connector's sync logic and its safeguards
```

**Command**

```bash
cd /home/claude/MeemX-ERP/connector && cat > state.mjs <<'EOF'
/**
 * connector/state.mjs — small local state: payload hashes (skip unchanged uploads),
 * the date of the last full reconcile, and a lock that prevents overlapping runs
 * (Task Scheduler + --loop, or two scheduled instances, must never run together).
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const STATE_FILE = resolve(__dirname, '.sync-state.json')
export const LOCK_FILE = resolve(__dirname, '.sync.lock')
const STALE_LOCK_MS = 30 * 60 * 1000

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function loadState(file = STATE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return { lastFullSyncDate: parsed.lastFullSyncDate || null, hashes: parsed.hashes || {} }
  } catch {
    return { lastFullSyncDate: null, hashes: {} }
  }
}

export function saveState(state, file = STATE_FILE) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Take the run lock. Returns a release() function, or null when another live run holds it.
 * A lock older than 30 minutes is treated as left over from a crash.
 */
export function acquireLock(file = LOCK_FILE, now = Date.now()) {
  if (existsSync(file)) {
    try {
      const held = JSON.parse(readFileSync(file, 'utf-8'))
      if (now - Number(held.startedAt) < STALE_LOCK_MS) return null
    } catch { /* unreadable lock = stale */ }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: now }), 'utf-8')
  return () => { try { unlinkSync(file) } catch { /* already gone */ } }
}

/** First day of the financial year containing `date` (India default: 1 April). */
export function financialYearStart(date, startMonth = 4) {
  const year = date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}
EOF
python3 - <<'EOF'
# normalize.mjs additions
p='normalize.mjs'
s=open(p).read()
s=s.replace("""export function buildPreviewPayload(xmlText, company, filename) {
  const normalizedXml = prefixVoucherNumbers(xmlText)
  const contentBase64 = Buffer.from(normalizedXml, 'utf-8').toString('base64')
  return {
    action: 'preview',
    filename: filename || `tally-connector-${Date.now()}.xml`,
    contentBase64,
    companyName: company,
  }
}""","""export function buildPreviewPayload(xmlText, company, filename, extra = {}) {
  const normalizedXml = prefixVoucherNumbers(xmlText)
  const contentBase64 = Buffer.from(normalizedXml, 'utf-8').toString('base64')
  return {
    action: 'preview',
    filename: filename || `tally-connector-${Date.now()}.xml`,
    contentBase64,
    companyName: company,
    // extra.window = { from, to } (YYYY-MM-DD) lets the server tombstone vouchers deleted in Tally.
    // extra.groups = { groupName: parentName } resolves sub-groups of Sundry Debtors etc.
    ...extra,
  }
}

const decodeEntities = (text) => text
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#0*4;/g, '').replace(/&amp;/g, '&')

/** Build { groupName: parentName } from a Tally "List of Groups" export. */
export function extractGroupParents(xmlText) {
  const groups = {}
  for (const match of xmlText.matchAll(/<GROUP\\b([^>]*)>([\\s\\S]*?)<\\/GROUP>/gi)) {
    const nameAttr = match[1].match(/NAME="([^"]*)"/i)
    const name = nameAttr ? decodeEntities(nameAttr[1]).trim() : ''
    if (!name) continue
    const parent = match[2].match(/<PARENT[^>]*>([^<]*)<\\/PARENT>/i)
    groups[name] = parent ? decodeEntities(parent[1]).trim() : ''
  }
  return groups
}

const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const toYmd = (date) => date.toISOString().slice(0, 10).replace(/-/g, '')
export const ymdToIso = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`

/** Split a YYYYMMDD range into two halves (null when it is already a single day). */
export function splitRange(fromYmd, toYmdValue) {
  const from = toDate(fromYmd), to = toDate(toYmdValue)
  const days = Math.round((to - from) / 86_400_000)
  if (days < 1) return null
  const mid = new Date(from.getTime() + Math.floor(days / 2) * 86_400_000)
  return [
    { fromDate: fromYmd, toDate: toYmd(mid) },
    { fromDate: toYmd(new Date(mid.getTime() + 86_400_000)), toDate: toYmdValue },
  ]
}""")
open(p,'w').write(s)

# tally_client: groups collection
p='tally_client.mjs'
s=open(p).read()
s=s.replace("  const isLedgerList = reportId === 'List of Accounts'\n","  const isLedgerList = reportId === 'List of Accounts'\n  const isGroupList = reportId === 'List of Groups'\n")
s=s.replace("if (isVoucherCollection || isStockItems || isLedgerList) {","if (isVoucherCollection || isStockItems || isLedgerList || isGroupList) {")
s=s.replace("const colType = isVoucherCollection ? 'Voucher' : isStockItems ? 'StockItem' : 'Ledger'","const colType = isVoucherCollection ? 'Voucher' : isStockItems ? 'StockItem' : isGroupList ? 'Group' : 'Ledger'")
s=s.replace("      : ['Name', 'GUID', 'Parent', 'OpeningBalance', 'ClosingBalance', 'LedgerPhone', 'Email', 'Address']","      : isGroupList\n      ? ['Name', 'Parent']\n      : ['Name', 'GUID', 'Parent', 'OpeningBalance', 'ClosingBalance', 'LedgerPhone', 'Email', 'Address']")
open(p,'w').write(s)

# supabase_client: commit even for empty windows; tolerate already-committed retry; strict state IO
p='supabase_client.mjs'
s=open(p).read()
s=s.replace("""  // If no valid rows, skip commit
  if (preview.summary && preview.summary.valid === 0) {""","""  // If no valid rows, skip commit — unless a sync window is attached: an empty window still
  // has to be committed so vouchers deleted in Tally are tombstoned.
  if (preview.summary && preview.summary.valid === 0 && !previewPayload.window) {""")
s=s.replace("""  // Step 2: Commit
  const commit = await callEdgeFunction(
    config,
    accessToken,
    { action: 'commit', jobId: preview.jobId },
    fetchFn
  )

  return { preview, commit }""","""  // Step 2: Commit
  let commit
  try {
    commit = await callEdgeFunction(config, accessToken, { action: 'commit', jobId: preview.jobId }, fetchFn)
  } catch (err) {
    // A network timeout after the server finished makes the retry see a committed job.
    if (err instanceof EdgeFunctionError && /not ready to commit/i.test(err.message)) {
      commit = { status: 'committed', inserted: 0, updated: 0, skipped: 0, jobId: preview.jobId, alreadyCommitted: true }
    } else {
      throw err
    }
  }

  return { preview, commit }""")
s=s.replace("""  const body = await res.json()
      if (!res.ok) {
        throw new EdgeFunctionError(""","""  const body = await res.json().catch(() => ({ error: `non-JSON response (HTTP ${res.status})` }))
      if (!res.ok) {
        throw new EdgeFunctionError(""") if "const body = await res.json()\n      if (!res.ok) {\n        throw new EdgeFunctionError(" in s else s
s=s.replace("""export async function getLastSyncDate(config, accessToken, fetchFn = globalThis.fetch) {""","""export async function getLastSyncDate(config, accessToken, fetchFn = globalThis.fetch) {""")
s=s.replace("""  if (!res.ok) return null

  const rows = await res.json()""","""  // A failed read must not look like "never synced": callers fall back to a wider window and warn.
  if (!res.ok) throw new Error(`Could not read sync cursor (HTTP ${res.status})`)

  const rows = await res.json()""")
s=s.replace("""  await fetchFn(url, {
    method: 'PATCH',""","""  const res = await fetchFn(url, {
    method: 'PATCH',
    // return=representation lets us detect an RLS-blocked update (0 rows) instead of silently losing the cursor
    // (header below is replaced accordingly)""")
s=s.replace("'Prefer': 'return=minimal',","'Prefer': 'return=representation',")
s=s.replace("""    body: JSON.stringify(body),
  })
}

/** Edge function returned an HTTP error. */""","""    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Could not save sync cursor (HTTP ${res.status})`)
  const updated = await res.json().catch(() => [])
  if (!Array.isArray(updated) || updated.length === 0) {
    throw new Error('Sync cursor was not saved (no row updated — is the account an admin?)')
  }
}

/** Edge function returned an HTTP error. */""")
# setLastSyncDate takes a timestamp
s=s.replace("""export async function setLastSyncDate(config, accessToken, jobId, fetchFn = globalThis.fetch) {
  const url = `${config.url}/rest/v1/accounting_refresh_state?id=eq.1`
  const body = {
    last_successful_import_at: new Date().toISOString(),""","""export async function setLastSyncDate(config, accessToken, jobId, fetchFn = globalThis.fetch, at = new Date()) {
  const url = `${config.url}/rest/v1/accounting_refresh_state?id=eq.1`
  const body = {
    last_successful_import_at: at.toISOString(),""")
open(p,'w').write(s)
EOF
node --check supabase_client.mjs && node --check normalize.mjs && node --check tally_client.mjs && echo OK; grep -n "res.json" supabase_client.mjs; grep -n "sync-state\|sync.lock" ../.gitignore
```

**Output**

```text
OK
46:  const body = await res.json()
87:      const body = await res.json().catch(() => ({ error: `non-JSON response (HTTP ${res.status})` }))
175:  const rows = await res.json()
210:  const updated = await res.json().catch(() => [])
```

**Command**

```bash
cd /home/claude/MeemX-ERP/connector && python3 - <<'EOF'
p='sync.mjs'
s=open(p).read()
a=s.index("/**\n * pull — Full sync for a date range.")
b=s.index("// ─── Loop Mode")
new = r'''// Large vouchers collections are split by date until each upload is small enough for the
// edge function (base64 length). A busy month used to exceed the limit and silently never sync.
const MAX_PAYLOAD_B64 = 4_000_000

const num = (value) => Number(value) || 0
const stamp = (result) => ({
  ins: num(result.commit?.inserted), upd: num(result.commit?.updated),
  skip: num(result.commit?.skipped), del: num(result.commit?.deleted),
})

/**
 * Push one Tally export (masters / stock / stock summary) unless it is identical to the
 * last successfully pushed copy. Returns 'ok' | 'unchanged' | 'empty' | throws.
 */
async function pushExport({ config, accessToken, state, key, xml, filename, extra = {}, force = false, label, countFn }) {
  const hash = sha256(xml)
  if (!force && state.hashes[key] === hash) {
    console.log(`   ⏭️  ${label}: unchanged since last sync`)
    return 'unchanged'
  }
  const payload = buildPreviewPayload(xml, config.tally.company, filename, extra)
  const result = await previewAndCommit(config.supabase, accessToken, payload)
  const { ins, upd, skip } = stamp(result)
  console.log(`   ✅ ${label}: ${countFn(xml)} → ${ins} inserted, ${upd} updated, ${skip} unchanged`)
  state.hashes[key] = hash
  return 'ok'
}

/**
 * Sync vouchers for [fromYmd, toYmd]. Splits the range when the payload is too large.
 * Every upload carries its window so deletions/cancellations in Tally propagate.
 */
async function syncVoucherRange({ config, accessToken, state, fromDate, toDate, label, force, totals }) {
  const response = await sendToTally(
    buildExportRequest('Day Book', config.tally.company, { fromDate, toDate }),
    config.tally,
  )
  if (!/<ENVELOPE/i.test(response)) throw new Error('Tally returned a response without an <ENVELOPE>; refusing to reconcile.')

  const key = `vouchers:${fromDate}-${toDate}`
  const hash = sha256(response)
  const window = { from: ymdToIso(fromDate), to: ymdToIso(toDate) }
  const payload = buildPreviewPayload(response, config.tally.company, `tally-vouchers-${fromDate}-${toDate}.xml`, { window })

  if (payload.contentBase64.length > MAX_PAYLOAD_B64) {
    const halves = splitRange(fromDate, toDate)
    if (!halves) throw new Error(`A single day (${fromDate}) exceeds the upload limit; cannot split further.`)
    console.log(`   ↔️  ${label}: ${(payload.contentBase64.length / 1e6).toFixed(1)} MB — splitting`)
    for (const half of halves) {
      await new Promise((r) => setTimeout(r, 300))
      await syncVoucherRange({ config, accessToken, state, fromDate: half.fromDate, toDate: half.toDate, label: `${half.fromDate}–${half.toDate}`, force, totals })
    }
    return
  }

  if (!force && state.hashes[key] === hash) {
    console.log(`   ${label}: unchanged since last sync`)
    return
  }
  const result = await previewAndCommit(config.supabase, accessToken, payload)
  const { ins, upd, skip, del } = stamp(result)
  totals.inserted += ins; totals.updated += upd; totals.deleted += del
  const note = result.commit?.reconcileNote ? ` (deletion check ${result.commit.reconcileNote})` : ''
  console.log(`   ${label}: ${countElements(response).voucherCount} vouchers → ${ins} inserted, ${upd} updated, ${skip} unchanged, ${del} removed${note}`)
  state.hashes[key] = hash
}

/**
 * Core run: masters, stock, then vouchers for [fromDate, toDate] (YYYY-MM-DD).
 * @returns {Promise<{ failures: number }>}
 */
async function runSync(config, accessToken, { fromDate, toDate, force = false, state }) {
  let failures = 0
  const company = config.tally.company

  // 1. Account groups → lets sub-groups of Sundry Debtors/Creditors etc. classify correctly.
  let groups = {}
  console.log('\n📋 Pulling account groups...')
  try {
    const groupsXml = await sendToTally(buildExportRequest('List of Groups', company), config.tally)
    groups = extractGroupParents(groupsXml)
    console.log(`   ✅ ${Object.keys(groups).length} groups`)
  } catch (err) {
    console.warn(`   ⚠️  Groups unavailable (${err.message}); falling back to name-based classification.`)
  }

  // 2. Ledgers
  console.log('\n📋 Pulling ledgers...')
  try {
    const xml = await sendToTally(buildExportRequest('List of Accounts', company), config.tally)
    if (hasData(xml)) {
      await pushExport({ config, accessToken, state, key: 'masters', xml, filename: `tally-masters-${toDate}.xml`, extra: { groups }, force, label: 'Ledgers', countFn: (x) => `${countElements(x).ledgerCount} ledgers` })
    } else {
      console.warn('   ⚠️  Tally returned no ledgers — check TALLY_COMPANY and that the company is open.')
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Ledgers failed: ${err.message}`)
  }

  // 3. Stock items
  console.log('\n📋 Pulling stock items...')
  try {
    const xml = await sendToTally(buildExportRequest('List of Stock Items', company), config.tally)
    if (hasData(xml)) {
      await pushExport({ config, accessToken, state, key: 'stock', xml, filename: `tally-stock-${toDate}.xml`, force, label: 'Stock items', countFn: (x) => `${countElements(x).stockCount} items` })
    } else {
      console.log('   ℹ️  No stock items returned by Tally.')
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Stock items failed: ${err.message}`)
  }

  // 4. Item-wise stock summary = live quantity, average rate, value
  console.log('\n📋 Pulling item-wise stock values...')
  try {
    const xml = await sendToTally(buildExportRequest('Stock Summary', company, { toDate: toDate.replace(/-/g, '') }), config.tally)
    if (countElements(xml).stockSummaryCount > 0) {
      await pushExport({ config, accessToken, state, key: 'stock-summary', xml, filename: `tally-stock-summary-${toDate}.xml`, force, label: 'Stock values', countFn: (x) => `${countElements(x).stockSummaryCount} items` })
    } else {
      console.log('   ℹ️  Tally returned no item-wise stock values.')
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Stock values failed: ${err.message}`)
  }

  // 5. Vouchers (monthly chunks, adaptively split)
  const chunks = monthlyChunks(fromDate, toDate)
  console.log(`\n📋 Pulling vouchers ${fromDate} → ${toDate} in ${chunks.length} chunk(s)${force ? ' (full reconcile)' : ''}...`)
  const totals = { inserted: 0, updated: 0, deleted: 0 }
  for (const chunk of chunks) {
    // Tally's HTTP listener is single-threaded; give it a moment between requests.
    await new Promise((r) => setTimeout(r, 500))
    try {
      await syncVoucherRange({ config, accessToken, state, fromDate: chunk.fromDate, toDate: chunk.toDate, label: chunk.label, force, totals })
    } catch (err) {
      failures++
      console.error(`   ❌ ${chunk.label} failed: ${err.message}`)
    }
  }
  console.log(`\n📊 Vouchers: ${totals.inserted} inserted, ${totals.updated} updated, ${totals.deleted} removed, ${failures} failure(s)`)
  return { failures }
}

/**
 * pull — Full sync for a date range (always uploads; ignores the unchanged-payload cache).
 */
async function cmdPull(config, values) {
  const today = localDateString(new Date())
  const fromDate = values.from
  const toDate = values.to || today
  if (!fromDate) {
    console.error('❌ --from YYYY-MM-DD is required for the pull command.')
    process.exitCode = 1
    return
  }

  const release = acquireLock()
  if (!release) {
    console.warn('⏳ Another sync is already running; skipping this one.')
    return
  }
  try {
    console.log(`\n📥 Pull: syncing ${fromDate} → ${toDate}`)
    console.log(`   Tally: ${config.tally.host}:${config.tally.port}, Company: ${config.tally.company}`)
    console.log(`   Supabase: ${redactUrl(config.supabase.url)}\n`)

    let accessToken
    try {
      accessToken = await authenticate(config.supabase)
      console.log('🔐 Authenticated with Supabase.')
    } catch (err) {
      console.error(`❌ Auth failed: ${err.message}`)
      process.exitCode = 1
      return
    }

    const runStartedAt = new Date()
    const state = loadState()
    const { failures } = await runSync(config, accessToken, { fromDate, toDate, force: true, state })
    saveState(state)
    if (failures === 0 && values.cursor !== false) {
      try { await setLastSyncDate(config.supabase, accessToken, null, undefined, runStartedAt) } catch (err) {
        console.error(`   ⚠️  ${err.message}`)
        process.exitCode = 1
      }
    }
    if (failures > 0) process.exitCode = 1
    console.log('✅ Pull complete.\n')
  } finally {
    release()
  }
}

/**
 * incremental — Sync (cursor − 7 days) → today. Once per calendar day it additionally
 * re-reads the whole current financial year and reconciles it, which self-heals edits
 * to old vouchers, deletions, and anything an earlier failed run missed.
 */
async function cmdIncremental(config, values) {
  const release = acquireLock()
  if (!release) {
    console.warn('⏳ Another sync is already running; skipping this one.')
    return
  }
  try {
    console.log('\n🔄 Incremental sync...')
    let accessToken
    try {
      accessToken = await authenticate(config.supabase)
    } catch (err) {
      console.error(`❌ Auth failed: ${err.message}`)
      process.exitCode = 1
      return
    }

    let lastSync = null
    try {
      lastSync = await getLastSyncDate(config.supabase, accessToken)
    } catch (err) {
      console.warn(`   ⚠️  ${err.message}; using the 90-day catch-up window.`)
    }

    const runStartedAt = new Date()
    const today = localDateString(runStartedAt)
    const state = loadState()
    const needsDailyReconcile = state.lastFullSyncDate !== today

    let fromDate
    if (lastSync) {
      const d = new Date(lastSync)
      d.setDate(d.getDate() - 7)              // overlap: vouchers can be edited retroactively
      fromDate = localDateString(d)
      console.log(`   Last successful run: ${lastSync}`)
    } else {
      const d = new Date(runStartedAt)
      d.setDate(d.getDate() - 90)
      fromDate = localDateString(d)
      console.log('   No successful run recorded — pulling the last 90 days.')
    }
    if (needsDailyReconcile) {
      const fyStart = financialYearStart(runStartedAt, Number(process.env.FY_START_MONTH) || 4)
      if (fyStart < fromDate) fromDate = fyStart
      console.log(`   Daily reconcile due — reading the full financial year from ${fromDate}.`)
    }
    console.log(`   Pulling ${fromDate} → ${today}`)

    const { failures } = await runSync(config, accessToken, { fromDate, toDate: today, force: needsDailyReconcile, state })
    if (failures === 0) {
      if (needsDailyReconcile) state.lastFullSyncDate = today
      saveState(state)
      try {
        // Cursor = when this run STARTED, so edits made during the run are re-read next time.
        await setLastSyncDate(config.supabase, accessToken, null, undefined, runStartedAt)
      } catch (err) {
        console.error(`   ⚠️  ${err.message}`)
        process.exitCode = 1
      }
    } else {
      saveState(state)        // keep hashes of the parts that did succeed
      process.exitCode = 1    // cursor deliberately NOT advanced: the failed window is retried
    }
  } finally {
    release()
  }
}

'''
s=s[:a]+new+s[b:]
s=s.replace("import { countElements, hasData, buildPreviewPayload, monthlyChunks } from './normalize.mjs'","import { countElements, hasData, buildPreviewPayload, monthlyChunks, extractGroupParents, splitRange, ymdToIso } from './normalize.mjs'\nimport { loadState, saveState, acquireLock, sha256, financialYearStart } from './state.mjs'")
s=s.replace("//   TALLY_HOST, TALLY_PORT, TALLY_COMPANY (optional; defaults to the active Tally company),","//   TALLY_HOST, TALLY_PORT, TALLY_COMPANY (required),")
s=s.replace("--tally-company NAME    Select a company (defaults to the active company in Tally)","--tally-company NAME    Company name exactly as in Tally (required)")
s=s.replace("incremental  Sync from (last successful sync - 7 days) to today.","incremental  Sync from (last successful run - 7 days) to today; once a day also\n               re-reads and reconciles the whole financial year.")
open(p,'w').write(s)
EOF
node --check sync.mjs && echo SYNTAX_OK; grep -n "TALLY_COMPANY\|company ||" sync.mjs | head; printf '\nconnector/.sync-state.json\nconnector/.sync.lock\n' >> ../.gitignore; tail -5 ../.gitignore
```

**Output**

```text
SYNTAX_OK
13: *   TALLY_HOST, TALLY_PORT, TALLY_COMPANY (optional; defaults to the active Tally company),
61:  if (values['tally-company']) cliFlags.TALLY_COMPANY = values['tally-company']
109:  console.log(`   Tally: ${config.tally.host}:${config.tally.port}, Company: ${config.tally.company || 'active company'}\n`)
270:      console.warn('   ⚠️  Tally returned no ledgers — check TALLY_COMPANY and that the company is open.')
514:              company: get('TALLY_COMPANY'),
connector/samples/
supabase/.temp/

connector/.sync-state.json
connector/.sync.lock
```

**Command**

```bash
cd /home/claude/MeemX-ERP/connector && python3 - <<'EOF'
p='sync.mjs'
s=open(p).read()
s=s.replace("if (failures === 0 && values.cursor !== false) {","// Only a pull that reaches today may move the cursor; a historical back-fill must not make\n    // the incremental run skip the days after it.\n    if (failures === 0 && toDate >= today) {")
s=s.replace(" *   TALLY_HOST, TALLY_PORT, TALLY_COMPANY (optional; defaults to the active Tally company),"," *   TALLY_HOST, TALLY_PORT, TALLY_COMPANY (required: exact company name in Tally),")
s=s.replace("Company: ${config.tally.company || 'active company'}\\n`)","Company: ${config.tally.company || '(not set)'}\\n`)")
open(p,'w').write(s)
EOF
node --check sync.mjs && echo ok
cd .. && sed -i "s#assert.ok(xml.includes('<SVFROMDATE>20261001</SVFROMDATE>'))#assert.ok(xml.includes('<SVFROMDATE TYPE=\"Date\">20261001</SVFROMDATE>'))#" tests/test_connector.mjs && sed -n 262,285p tests/test_connector.mjs; tail -3 /tmp/pg_install.log
```

**Output**

```text
ok
    assert.ok(response.includes('<VOUCHER'), 'Should contain VOUCHER elements')
    assert.ok(response.includes('Widget A'), 'Should contain stock item')
  })

  it('builds export request with date range', () => {
    const xml = buildExportRequest('All Masters', 'MyCo', {
      fromDate: '20261001',
      toDate: '20261031',
    })
    assert.ok(xml.includes('<SVFROMDATE TYPE="Date">20261001</SVFROMDATE>'))
    assert.ok(xml.includes('<SVTODATE>20261031</SVTODATE>'))
    assert.ok(xml.includes('<TALLYREQUEST>Export</TALLYREQUEST>'))
  })

  it('decodes UTF-16LE response', () => {
    const text = 'Hello Tally ✓'
    // Build a simple UTF-16LE buffer with BOM
    const utf16Bytes = new Uint8Array(2 + text.length * 2)
    utf16Bytes[0] = 0xFF  // BOM
    utf16Bytes[1] = 0xFE
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      utf16Bytes[2 + i * 2] = code & 0xFF
      utf16Bytes[2 + i * 2 + 1] = (code >> 8) & 0xFF
```

**Command**

```bash
cd /home/claude/MeemX-ERP && python3 - <<'EOF'
p='tests/test_connector.mjs'
s=open(p).read()
a=s.index("  it('builds export request with date range', () => {")
b=s.index("  it('decodes UTF-16LE response'")
new="""  it('builds export request with date range (compact dates for vouchers, d-Mon-yyyy for reports)', () => {
    const vouchers = buildExportRequest('Day Book', 'MyCo', { fromDate: '20261001', toDate: '20261031' })
    assert.ok(vouchers.includes('<SVFROMDATE TYPE="Date">20261001</SVFROMDATE>'))
    assert.ok(vouchers.includes('<SVTODATE TYPE="Date">20261031</SVTODATE>'))
    assert.ok(vouchers.includes('<TALLYREQUEST>Export</TALLYREQUEST>'))

    const report = buildExportRequest('All Masters', 'MyCo', { fromDate: '20261001', toDate: '20261031' })
    assert.ok(report.includes('<SVFROMDATE TYPE="Date">1-Oct-2026</SVFROMDATE>'))
    assert.ok(report.includes('<SVTODATE TYPE="Date">31-Oct-2026</SVTODATE>'))
  })

"""
s=s[:a]+new+s[b:]
open(p,'w').write(s)
EOF
node --test tests/test_connector.mjs 2>&1 | grep -E "^# (pass|fail)|not ok" 
```

**Output**

```text
# pass 34
# fail 0
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/lib && cat > tallyLedgerCategory.js <<'EOF'
const normalized = (value) => String(value || '').replace(/[\u0000-\u001f]/g, '').trim().toLowerCase()

// Keep in sync with supabase/functions/tally-import/parser.js (tests/category_parity.test.mjs enforces it).
const EXACT_CATEGORY = new Map([
  ['direct expenses', 'expense'], ['indirect expenses', 'expense'], ['purchase accounts', 'expense'],
  ['direct incomes', 'income'], ['indirect incomes', 'income'], ['sales accounts', 'income'],
  ['capital account', 'liability'], ['reserves & surplus', 'liability'], ['current liabilities', 'liability'],
  ['duties & taxes', 'liability'], ['provisions', 'liability'], ['sundry creditors', 'liability'],
  ['loans (liability)', 'liability'], ['secured loans', 'liability'], ['unsecured loans', 'liability'],
  ['bank od a/c', 'liability'], ['retained earnings', 'liability'],
  ['bank accounts', 'asset'], ['cash-in-hand', 'asset'], ['current assets', 'asset'], ['deposits (asset)', 'asset'],
  ['fixed assets', 'asset'], ['investments', 'asset'], ['loans & advances (asset)', 'asset'],
  ['stock-in-hand', 'asset'], ['sundry debtors', 'asset'], ['misc. expenses (asset)', 'asset'],
  ['branch / divisions', 'asset'], ['suspense a/c', 'asset'],
])

/**
 * Map a Tally account group to its normal balance category.
 * Exact reserved groups win; keywords only handle custom group names. Notably
 * "Loans & Advances (Asset)" is an asset and "Duties & Taxes" a liability — plain
 * `includes('loan')` / default-to-asset got both wrong.
 */
export function tallyLedgerCategory(group) {
  const name = normalized(group)
  if (EXACT_CATEGORY.has(name)) return EXACT_CATEGORY.get(name)
  if (name.includes('expense') || name.includes('purchase account')) return 'expense'
  if (name.includes('income') || name.includes('sales account')) return 'income'
  if (/\(asset\)|advance|deposit|debtor|customer|bank account|cash|stock|fixed asset|investment|current asset/.test(name)) return 'asset'
  if (/liabilit|creditor|supplier|capital|loan|provision|duties|tax|reserve|surplus|bank od|overdraft/.test(name)) return 'liability'
  return 'asset'
}

export function tallyPartyType(group) {
  const name = normalized(group)
  if (name === 'sundry debtors' || name.includes('debtor') || name.includes('customer')) return 'debtor'
  if (name === 'sundry creditors' || name.includes('creditor') || name.includes('supplier')) return 'creditor'
  return ''
}

/** True for the purchase-account group (cost of goods, not operating expense). */
export function isPurchaseGroup(ledger) {
  return normalized(ledger?.primary_group || ledger?.group) === 'purchase accounts' ||
    normalized(ledger?.group).includes('purchase account')
}
EOF
sed -i "s#from './tallyLedgerCategory'#from './tallyLedgerCategory.js'#" syncSnapshot.js dashboardMetrics.js && grep -n "tallyLedgerCategory" syncSnapshot.js dashboardMetrics.js | head -3; tail -3 /tmp/pg_install.log
```

**Output**

```text
syncSnapshot.js:8:import { tallyLedgerCategory } from './tallyLedgerCategory.js'
syncSnapshot.js:59:  const categoryFromGroup = tallyLedgerCategory(group)
dashboardMetrics.js:1:import { tallyLedgerCategory } from './tallyLedgerCategory.js'

dashboardMetrics.js
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/lib && rm dashboardMetrics.js && echo removed
```

**Output**

```text
removed
dashboardMetrics.js
```

**Command**

```bash
cd /home/claude/MeemX-ERP && npm test 2>&1 | grep -E "^# (tests|pass|fail)|not ok" ; tail -2 /tmp/pg_install.log
```

**Output**

```text
# tests 52
# pass 52
# fail 0
```

**Command**

```bash
cd /home/claude/MeemX-ERP/tests && cat > tally_parser.test.mjs <<'EOF'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import {
  parseTallyXml, classifyVoucherType, signedAmount, resolveRootGroup, categoryForGroup,
} from '../supabase/functions/tally-import/parser.js'
import { tallyLedgerCategory } from '../src/lib/tallyLedgerCategory.js'

const deps = { XMLParser, XMLValidator }
const wrap = (inner) => `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`
const entry = (tag, name, amount, deemed) =>
  `<${tag}><LEDGERNAME>${name}</LEDGERNAME><ISDEEMEDPOSITIVE>${deemed}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></${tag}>`
const voucher = ({ type = 'Sales', no = '1', guid = 'g1', party = 'Acme', extra = '', body }) =>
  `<VOUCHER VCHTYPE="${type}"><DATE>20261030</DATE><GUID>${guid}</GUID><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME><VOUCHERNUMBER>${no}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>${extra}${body}</VOUCHER>`

const parse = async (xml, options) => (await parseTallyXml(wrap(xml), 'Co', deps, options))

describe('amount signs', () => {
  it('uses Tally convention: Dr negative, Cr positive, and understands Dr/Cr suffixes', () => {
    assert.equal(signedAmount('-1,500.50'), -1500.5)
    assert.equal(signedAmount('1,500.50 Dr'), -1500.5)
    assert.equal(signedAmount('1,500.50 Cr'), 1500.5)
    assert.equal(signedAmount('(200.00)'), -200)
  })
})

describe('voucher type classification', () => {
  it('does not treat orders / receipt notes / stock journals as accounting vouchers', () => {
    for (const name of ['Sales Order', 'Purchase Order', 'Receipt Note', 'Delivery Note', 'Stock Journal', 'Rejections In']) {
      assert.deepEqual(classifyVoucherType(name), { type: '', ignore: true }, name)
    }
  })
  it('keeps returns as their own types instead of dropping or adding them to sales', () => {
    assert.equal(classifyVoucherType('Credit Note').type, 'credit_note')
    assert.equal(classifyVoucherType('Sales Return').type, 'credit_note')
    assert.equal(classifyVoucherType('Debit Note').type, 'debit_note')
    assert.equal(classifyVoucherType('Sales - GST').type, 'sales')
    assert.equal(classifyVoucherType('Journal').type, 'journal')
  })
})

describe('sales voucher math', () => {
  const body = entry('ALLLEDGERENTRIES.LIST', 'Acme', '-11800.00', 'Yes') +
    entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '10000.00', 'No') +
    entry('ALLLEDGERENTRIES.LIST', 'CGST', '900.00', 'No') +
    entry('ALLLEDGERENTRIES.LIST', 'SGST', '900.00', 'No')

  it('amount is the party-side gross and due is the party debit', async () => {
    const { rows } = await parse(voucher({ body }))
    const p = rows[0].payload
    assert.equal(p.amount, 11800)
    assert.equal(p.due_amount, 11800)
    assert.equal(p.paid_amount, 0)
    assert.equal(p.ledger_entries.find((e) => e.ledger_name === 'Acme').is_debit, true)
  })

  it('a discount ledger no longer shows up as money the customer "paid"', async () => {
    // items 10000 gross, discount 500 (Dr), customer owes 9500
    const b = entry('ALLLEDGERENTRIES.LIST', 'Acme', '-9500.00', 'Yes') +
      entry('ALLLEDGERENTRIES.LIST', 'Discount Allowed', '-500.00', 'Yes') +
      entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '10000.00', 'No') +
      '<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Pen</STOCKITEMNAME><BILLEDQTY>100 Nos</BILLEDQTY><RATE>100/Nos</RATE><AMOUNT>10000.00</AMOUNT></ALLINVENTORYENTRIES.LIST>'
    const p = (await parse(voucher({ body: b }))).rows[0].payload
    assert.equal(p.amount, 10000)
    assert.equal(p.due_amount, 9500)
    assert.equal(p.paid_amount, 500)           // discount is the 500 gap; due is what is really owed
    assert.equal(p.items[0].qty, 100)
  })

  it('a party whose name merely contains "cash" still owes money; real cash sales do not', async () => {
    const credit = (await parse(voucher({ party: 'Cashew Traders', body: entry('ALLLEDGERENTRIES.LIST', 'Cashew Traders', '-500', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '500', 'No') }))).rows[0].payload
    assert.equal(credit.due_amount, 500)
    const cash = (await parse(voucher({ party: 'Cash', body: entry('ALLLEDGERENTRIES.LIST', 'Cash', '-500', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '500', 'No') }))).rows[0].payload
    assert.equal(cash.due_amount, 0)
    assert.equal(cash.paid_amount, 500)
    const bank = (await parse(voucher({ party: 'HDFC Current', body: entry('ALLLEDGERENTRIES.LIST', 'HDFC Current', '-500', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '500', 'No') }), { cashLedgerNames: new Set(['hdfc current']) })).rows[0].payload
    assert.equal(bank.due_amount, 0)
  })

  it('does not double count when Tally exposes the same postings under both ALL* and plain tags', async () => {
    const both = body + body.replaceAll('ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST')
    const p = (await parse(voucher({ body: both }))).rows[0].payload
    assert.equal(p.ledger_entries.length, 4)
    assert.equal(p.amount, 11800)
  })

  it('a receipt from a party is not a new debt', async () => {
    const p = (await parse(voucher({ type: 'Receipt', body: entry('ALLLEDGERENTRIES.LIST', 'Acme', '5000', 'No') + entry('ALLLEDGERENTRIES.LIST', 'HDFC Current', '-5000', 'Yes') }))).rows[0].payload
    assert.equal(p.voucher_type, 'receipt')
    assert.equal(p.due_amount, 0)
    assert.equal(p.paid_amount, 5000)
  })

  it('purchase: due is the credit owed to the supplier', async () => {
    const p = (await parse(voucher({ type: 'Purchase', party: 'Mill', body: entry('ALLLEDGERENTRIES.LIST', 'Mill', '2360', 'No') + entry('ALLLEDGERENTRIES.LIST', 'Purchase Account', '-2000', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Input GST', '-360', 'Yes') }))).rows[0].payload
    assert.equal(p.amount, 2360)
    assert.equal(p.due_amount, 2360)
  })
})

describe('voucher filtering', () => {
  it('skips cancelled, optional and non-accounting vouchers and reports them', async () => {
    const e = entry('ALLLEDGERENTRIES.LIST', 'Acme', '-100', 'Yes') + entry('ALLLEDGERENTRIES.LIST', 'Sales Account', '100', 'No')
    const result = await parse(
      voucher({ guid: 'a', body: e }) +
      voucher({ guid: 'b', extra: '<ISCANCELLED>Yes</ISCANCELLED>', body: e }) +
      voucher({ guid: 'c', extra: '<ISOPTIONAL>Yes</ISOPTIONAL>', body: e }) +
      voucher({ guid: 'd', type: 'Sales Order', body: e }),
    )
    assert.equal(result.rows.length, 1)
    assert.deepEqual(result.ignored, { nonAccounting: 1, cancelled: 1, optional: 1 })
  })
})

describe('ledger balances keep their side', () => {
  const groups = { 'Retail Customers': 'Sundry Debtors', 'Sundry Debtors': '', 'Bank Accounts': '' }
  it('resolves sub-groups to their primary group', () => {
    assert.equal(resolveRootGroup('Retail Customers', groups), 'Sundry Debtors')
  })

  it('customer who owes us is positive, one who prepaid is negative; overdrawn bank is negative', async () => {
    const ledger = (name, parent, closing) => `<LEDGER NAME="${name}"><PARENT>${parent}</PARENT><OPENINGBALANCE>0</OPENINGBALANCE><CLOSINGBALANCE>${closing}</CLOSINGBALANCE></LEDGER>`
    const { rows } = await parse(
      ledger('Debtor Owes', 'Retail Customers', '-5000.00') +   // Dr 5000
      ledger('Debtor Prepaid', 'Retail Customers', '700.00') +  // Cr 700 (advance)
      ledger('HDFC OD', 'Bank Accounts', '1200.00'),            // Cr 1200 = overdrawn
      { groupParents: groups })
    const by = Object.fromEntries(rows.map((r) => [r.payload.name, r]))
    assert.equal(by['Debtor Owes'].rowType, 'party')
    assert.equal(by['Debtor Owes'].payload.type, 'debtor')
    assert.equal(by['Debtor Owes'].payload.current_balance, 5000)
    assert.equal(by['Debtor Prepaid'].payload.current_balance, -700)
    assert.equal(by['HDFC OD'].rowType, 'ledger')
    assert.equal(by['HDFC OD'].payload.current_balance, -1200)
  })
})

describe('stock', () => {
  it('keeps negative (oversold) stock negative', async () => {
    const { rows } = await parse('<STOCKITEM NAME="Widget"><CLOSINGBALANCE>-3 Nos</CLOSINGBALANCE><CLOSINGVALUE>-300.00</CLOSINGVALUE><CLOSINGRATE>100.00</CLOSINGRATE></STOCKITEM>')
    assert.equal(rows[0].payload.current_qty, -3)
    assert.equal(rows[0].payload.purchase_rate, 100)
  })
})

describe('group → category', () => {
  it('fixes the groups the old keyword rules misclassified', () => {
    assert.equal(categoryForGroup('Loans & Advances (Asset)'), 'asset')
    assert.equal(categoryForGroup('Duties & Taxes'), 'liability')
    assert.equal(categoryForGroup('Reserves & Surplus'), 'liability')
    assert.equal(categoryForGroup('Bank OD A/c'), 'liability')
    assert.equal(categoryForGroup('Purchase Accounts'), 'expense')
  })
  it('client and edge function agree for every reserved group', () => {
    const groups = ['Direct Expenses', 'Indirect Expenses', 'Purchase Accounts', 'Direct Incomes', 'Indirect Incomes', 'Sales Accounts',
      'Capital Account', 'Reserves & Surplus', 'Current Liabilities', 'Duties & Taxes', 'Provisions', 'Sundry Creditors', 'Loans (Liability)',
      'Secured Loans', 'Unsecured Loans', 'Bank OD A/c', 'Bank Accounts', 'Cash-in-Hand', 'Current Assets', 'Deposits (Asset)', 'Fixed Assets',
      'Investments', 'Loans & Advances (Asset)', 'Stock-in-Hand', 'Sundry Debtors', 'Misc. Expenses (ASSET)', 'Suspense A/c', 'Staff Loan Recoverable', 'Freight Charges']
    for (const g of groups) assert.equal(tallyLedgerCategory(g), categoryForGroup(g), g)
  })
})
EOF
cd .. && node --test tests/tally_parser.test.mjs 2>&1 | grep -E "^# (pass|fail)|not ok|Error|expected|actual|message" | head -30
```

**Output**

```text
# pass 15
# fail 0
```

**Command**

```bash
cd /home/claude/MeemX-ERP/tests && cat > profit_expenses_aging.test.mjs <<'EOF'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { calculateDashboardMetrics, calculateExpenseBreakdown, computeDebtorAging } from '../src/lib/dashboardMetrics.js'

const now = new Date(2026, 9, 30, 12)
const ledgers = [
  { name: 'Sales Account', group: 'Sales Accounts', primary_group: 'Sales Accounts', category: 'income' },
  { name: 'Purchase Account', group: 'Purchase Accounts', primary_group: 'Purchase Accounts', category: 'expense' },
  { name: 'Rent', group: 'Indirect Expenses', primary_group: 'Indirect Expenses', category: 'expense' },
  { name: 'Transport', group: 'Indirect Expenses', primary_group: 'Indirect Expenses', category: 'expense' },
  { name: 'CGST', group: 'Duties & Taxes', primary_group: 'Duties & Taxes', category: 'liability' },
  { name: 'HDFC', group: 'Bank Accounts', category: 'asset' },
]
const tally = (o) => ({ source_system: 'tally', items: [], deleted_at: null, ...o })
const e = (ledger_name, amount, is_debit) => ({ ledger_name, amount, is_debit })

describe('profit', () => {
  it('buying stock is not an expense: profit = net sales − cost of goods sold − opex', () => {
    const vouchers = [
      tally({ voucher_type: 'sales', date: '2026-10-30', amount: 11800, party_name: 'Acme', items: [{ name: 'Pen', qty: 100 }],
        ledger_entries: [e('Acme', 11800, true), e('Sales Account', 10000, false), e('CGST', 1800, false)] }),
      // big stock purchase the same day: must NOT wipe out the day's profit
      tally({ voucher_type: 'purchase', date: '2026-10-30', amount: 50000, party_name: 'Mill',
        ledger_entries: [e('Mill', 50000, false), e('Purchase Account', 50000, true)] }),
      tally({ voucher_type: 'payment', date: '2026-10-30', amount: 1000, party_name: 'Rent',
        ledger_entries: [e('HDFC', 1000, false), e('Rent', 1000, true)] }),
    ]
    const materials = [{ name: 'Pen', current_qty: 400, current_value: 20000, purchase_rate: 1 }] // avg cost 50
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials })
    // 10,000 net sales (GST excluded) − 100×50 COGS − 1,000 rent = 4,000
    assert.equal(r.operatingResultToday, 4000)
    assert.equal(r.expensesToday, 1000)           // purchases are not "expenses"
    assert.equal(r.salesToday, 11800)
  })

  it('credit notes reduce both sales and profit', () => {
    const vouchers = [
      tally({ voucher_type: 'sales', date: '2026-10-30', amount: 1000, party_name: 'A', items: [{ name: 'Pen', qty: 10 }],
        ledger_entries: [e('A', 1000, true), e('Sales Account', 1000, false)] }),
      tally({ voucher_type: 'credit_note', date: '2026-10-30', amount: 400, party_name: 'A', items: [{ name: 'Pen', qty: 4 }],
        ledger_entries: [e('A', 400, false), e('Sales Account', 400, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now, { materials: [{ name: 'Pen', current_qty: 10, current_value: 500 }] })
    assert.equal(r.salesToday, 600)
    assert.equal(r.operatingResultToday, 600 - (10 * 50 - 4 * 50))   // 600 − 300
  })

  it('without item data it falls back to a purchases basis instead of showing nothing', () => {
    const vouchers = [
      tally({ voucher_type: 'sales', date: '2026-10-30', amount: 1000, party_name: 'A', ledger_entries: [e('A', 1000, true), e('Sales Account', 1000, false)] }),
      tally({ voucher_type: 'purchase', date: '2026-10-30', amount: 300, party_name: 'M', ledger_entries: [e('M', 300, false), e('Purchase Account', 300, true)] }),
    ]
    const r = calculateDashboardMetrics(vouchers, ledgers, now)
    assert.equal(r.operatingResultToday, 700)
    assert.match(r.operatingResultBasis.today, /purchases/)
  })

  it('stays unavailable when an item has no cost, instead of guessing zero', () => {
    const vouchers = [tally({ voucher_type: 'sales', date: '2026-10-30', amount: 100, party_name: 'A', items: [{ name: 'Mystery', qty: 1 }],
      ledger_entries: [e('A', 100, true), e('Sales Account', 100, false)] })]
    assert.equal(calculateDashboardMetrics(vouchers, ledgers, now).operatingResultToday, null)
  })

  it('ignores soft-deleted vouchers', () => {
    const v = tally({ voucher_type: 'sales', date: '2026-10-30', amount: 500, party_name: 'A', deleted_at: '2026-10-30T00:00:00Z', ledger_entries: [] })
    assert.equal(calculateDashboardMetrics([v], ledgers, now).salesToday, 0)
  })
})

describe('expense breakdown', () => {
  const pay = (date, ledger, amount) => tally({ voucher_type: 'payment', date, amount, party_name: ledger,
    ledger_entries: [e('HDFC', amount, false), e(ledger, amount, true)] })

  it('uses this month\'s postings, excludes purchases, and compares equal day-spans', () => {
    const vouchers = [
      pay('2026-10-05', 'Rent', 10000), pay('2026-10-20', 'Transport', 2000),
      pay('2026-09-05', 'Rent', 10000),          // inside Sep 1–30 comparison span
      pay('2026-09-12', 'Transport', 5000),
      tally({ voucher_type: 'purchase', date: '2026-10-10', amount: 99999, party_name: 'M', ledger_entries: [e('M', 99999, false), e('Purchase Account', 99999, true)] }),
    ]
    const r = calculateExpenseBreakdown(vouchers, ledgers.map((l) => ({ ...l, current_balance: 999999 })), now)
    assert.equal(r.total, 12000)
    assert.deepEqual(r.categories.map((c) => c.name), ['Rent', 'Transport'])
    assert.equal(r.previousTotal, 15000)
    assert.equal(r.changePct, -20)
  })

  it('reports no comparison instead of a made-up percentage when last month is empty', () => {
    const r = calculateExpenseBreakdown([pay('2026-10-05', 'Rent', 100)], ledgers, now)
    assert.equal(r.changePct, null)
  })
})

describe('debtor ageing', () => {
  const inv = (no, date, due) => ({ id: no, voucher_no: no, voucher_type: 'sales', date, party_name: 'Acme', due_amount: due })

  it('ages the balance by real invoice dates (newest invoices are the unpaid ones)', () => {
    const parties = [{ id: 1, name: 'Acme', type: 'debtor', current_balance: 1500 }]
    const vouchers = [inv('S1', '2026-07-01', 1000), inv('S2', '2026-09-20', 800), inv('S3', '2026-10-25', 700)]
    const { byParty, totals, outstandingByVoucher } = computeDebtorAging(parties, vouchers, now)
    // 1500 = S3 700 (5d) + S2 800 (40d); S1 was settled
    assert.equal(totals['0–30d'], 700)
    assert.equal(totals['31–60d'], 800)
    assert.equal(totals['60d+'], 0)
    assert.equal(byParty.get(1).bucket, '31–60d')
    assert.equal(outstandingByVoucher.get('S1'), undefined)
    assert.equal(outstandingByVoucher.get('S3'), 700)
  })

  it('balance not explained by any invoice is an old opening balance → 60d+', () => {
    const parties = [{ id: 1, name: 'Acme', type: 'debtor', current_balance: 5000 }]
    const { totals } = computeDebtorAging(parties, [inv('S3', '2026-10-25', 700)], now)
    assert.equal(totals['0–30d'], 700)
    assert.equal(totals['60d+'], 4300)
  })

  it('customers with an advance (negative balance) are not counted as owing', () => {
    const parties = [{ id: 1, name: 'Acme', type: 'debtor', current_balance: -300 }]
    const { totals } = computeDebtorAging(parties, [inv('S3', '2026-10-25', 700)], now)
    assert.deepEqual(totals, { '0–30d': 0, '31–60d': 0, '60d+': 0 })
  })
})
EOF
cd .. && node --test tests/profit_expenses_aging.test.mjs 2>&1 | grep -E "^# (pass|fail)|not ok|expected|actual|    [-+] " | head -30
```

**Output**

```text
# pass 10
# fail 0
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && sed -n 40,135p DashboardPage.jsx
```

**Output**

```text
      if (Math.abs(num) >= 10000000) return `₹${(num / 10000000).toFixed(1)}Cr`
      if (Math.abs(num) >= 100000) return `₹${(num / 100000).toFixed(1)}L`
      if (Math.abs(num) >= 1000) return `₹${(num / 1000).toFixed(1)}K`
      return `₹${num}`
    }
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(num)
  }

  // Load live DB data
  useEffect(() => {
    let active = true

    async function loadData() {
      try {
        const [parties, materials, ledgers, vouchers] = await Promise.all([
          accDb.parties.toArray(),
          accDb.materials.toArray(),
          accDb.ledgers.toArray(),
          accDb.vouchers.toArray(),
        ])
        if (!active) return

        const debtors = parties.filter((p) => p.type === 'debtor')
        const creditors = parties.filter((p) => p.type === 'creditor')

        const debtorsSum = debtors.reduce((s, d) => s + (Number(d.current_balance) || 0), 0)
        const creditorsSum = creditors.reduce((s, c) => s + (Number(c.current_balance) || 0), 0)
        const stockSum = materials.reduce((sum, material) => {
          if (material.current_value != null && Number.isFinite(Number(material.current_value))) {
            return sum + Number(material.current_value)
          }
          return sum + (Number(material.current_qty) || 0) * (Number(material.purchase_rate) || 0)
        }, 0)

        const loansOwed = ledgers
          .filter((l) => (l.group || '').toLowerCase().includes('loans (liability)'))
          .reduce((s, l) => s + (Number(l.current_balance) || 0), 0)
        const advGiven = ledgers
          .filter((l) => (l.group || '').toLowerCase().includes('loans & advances (asset)'))
          .reduce((s, l) => s + (Number(l.current_balance) || 0), 0)

        // Keep dashboard date totals in one pass through voucher history.
        const calculated = calculateDashboardMetrics(vouchers, ledgers)
        const {
          salesToday, salesWeek, salesMonth,
          expensesToday, expensesWeek, expensesMonth,
          operatingResultToday, operatingResultWeek, operatingResultMonth,
          sales7Days, sales7DaysTotal,
          operatingResultBasis,
        } = calculated

        const last7 = sales7Days.map((item) => ({ ...item, display: formatMoney(item.amount) }))

        setLiveMetrics({
          debtorsSum,
          debtorsCount: debtors.length,
          creditorsSum,
          creditorsCount: creditors.length,
          stockSum,
          netLoans: Math.max(0, loansOwed - advGiven),
          salesToday,
          salesWeek,
          salesMonth,
          expensesToday,
          expensesWeek,
          expensesMonth,
          operatingResultToday,
          operatingResultWeek,
          operatingResultMonth,
          operatingResultBasis,
          sales7Days: last7,
          sales7DaysTotal,
        })

        const topDebtors = debtors
          .filter((d) => (Number(d.current_balance) || 0) > 0)
          .sort((a, b) => (Number(b.current_balance) || 0) - (Number(a.current_balance) || 0))
          .slice(0, 5)
          .map((d) => {
            const days = Number(d.due_days) || 10
            return {
              name: d.name,
              age: d.age_bucket || (days > 60 ? '60d+' : days > 30 ? '31–60d' : '0–30d'),
              ageTone:
                days > 60
                  ? 'bg-[#fcebe6] text-[#ba3e29]'
                  : days > 30
                  ? 'bg-[#e2f3ec] text-[#0d786d]'
                  : 'bg-[#e3f2ec] text-[#136b60]',
              amount: `₹${(Number(d.current_balance) || 0).toLocaleString('en-IN')}`,
              phone: d.phone || '',
            }
          })

        setLiveDebtors(topDebtors)
      } catch {
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && python3 - <<'EOF'
p='DashboardPage.jsx'
s=open(p).read()
s=s.replace("import { calculateDashboardMetrics } from '../lib/dashboardMetrics'","import { calculateDashboardMetrics, computeDebtorAging } from '../lib/dashboardMetrics'")
s=s.replace("""        const debtorsSum = debtors.reduce((s, d) => s + (Number(d.current_balance) || 0), 0)
        const creditorsSum = creditors.reduce((s, c) => s + (Number(c.current_balance) || 0), 0)""","""        // Only positive balances are money owed. A negative balance is an advance on the other
        // side and must not silently cancel out other parties' dues.
        const owing = (list) => list.filter((p) => (Number(p.current_balance) || 0) > 0)
        const debtorsSum = owing(debtors).reduce((s, d) => s + Number(d.current_balance), 0)
        const creditorsSum = owing(creditors).reduce((s, c) => s + Number(c.current_balance), 0)""")
s=s.replace("""        const loansOwed = ledgers
          .filter((l) => (l.group || '').toLowerCase().includes('loans (liability)'))
          .reduce((s, l) => s + (Number(l.current_balance) || 0), 0)""","""        const loansOwed = ledgers
          .filter((l) => !l.deleted_at && l.category === 'liability' && /loan|overdraft|bank od/i.test(`${l.primary_group || ''} ${l.group || ''}`))
          .reduce((s, l) => s + Math.max(0, Number(l.current_balance) || 0), 0)""")
s=s.replace("const calculated = calculateDashboardMetrics(vouchers, ledgers)","const calculated = calculateDashboardMetrics(vouchers, ledgers, new Date(), { materials, parties })\n        const aging = computeDebtorAging(parties, vouchers)")
s=s.replace("          debtorsCount: debtors.length,","          debtorsCount: owing(debtors).length,")
s=s.replace("          creditorsCount: creditors.length,","          creditorsCount: owing(creditors).length,")
a=s.index("            const days = Number(d.due_days) || 10")
b=s.index("              phone: d.phone || '',")
s=s[:a]+"""            const bucket = aging.byParty.get(d.id ?? d.name)?.bucket || '0–30d'
            return {
              name: d.name,
              age: bucket,
              ageTone:
                bucket === '60d+'
                  ? 'bg-[#fcebe6] text-[#ba3e29]'
                  : bucket === '31–60d'
                  ? 'bg-[#fdf1dc] text-[#9a6412]'
                  : 'bg-[#e3f2ec] text-[#136b60]',
              amount: `₹${(Number(d.current_balance) || 0).toLocaleString('en-IN')}`,
"""+s[b:]
open(p,'w').write(s)
EOF
grep -n "accounting-data-updated\|addEventListener" DashboardPage.jsx | head -5; cd .. && npx oxlint src/pages/DashboardPage.jsx 2>&1 | tail -3
```

**Output**

```text
146:    window.addEventListener('accounting-data-updated', onUpdate)
149:      window.removeEventListener('accounting-data-updated', onUpdate)
No files found to lint. Please check your paths and ignore patterns.
Finished in 299ms on 0 files with 104 rules using 1 threads.
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && python3 - <<'EOF'
p='ExpensesPage.jsx'
s=open(p).read()
s=s.replace("import { accDb } from '../lib/accountingDb'\n","import { accDb } from '../lib/accountingDb'\nimport { calculateExpenseBreakdown } from '../lib/dashboardMetrics'\n")
a=s.index("  // Load expenses from Dexie ledgers/vouchers")
b=s.index("  const formatAmount")
new="""  const [summary, setSummary] = useState({ total: 0, previousTotal: 0, changePct: null })

  // This month's operating expenses, built from dated postings. The old version summed the
  // ledgers' cumulative closing balances (year-to-date, including purchases) and labelled it "This month".
  const loadExpenses = useCallback(async () => {
    try {
      const [ledgers, vouchers] = await Promise.all([accDb.ledgers.toArray(), accDb.vouchers.toArray()])
      const result = calculateExpenseBreakdown(vouchers, ledgers)
      setCategories(result.categories.map((c) => ({ id: c.name, name: c.name, rawAmount: c.amount })))
      setSummary({ total: result.total, previousTotal: result.previousTotal, changePct: result.changePct })
    } catch {
      setCategories([])
      setSummary({ total: 0, previousTotal: 0, changePct: null })
    }
  }, [])

  useEffect(() => {
    loadExpenses()
    const onUpdate = () => loadExpenses()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadExpenses])

  const totalExpenses = summary.total

  // Bars are scaled to the largest category this month (no hardcoded 1.2L ceiling).
  const maxExpense = useMemo(() => Math.max(1, ...categories.map((c) => Number(c.rawAmount) || 0)), [categories])

"""
s=s[:a]+new+s[b:]
s=s.replace("""          <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-[#147366]">
            <TrendingDown size={14} /> 4% vs last month
          </span>""","""          {summary.changePct === null ? (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-bold text-[#6a847c]">
              No expenses in the same days last month to compare
            </span>
          ) : (
            <span className={`mt-1 inline-flex items-center gap-1 text-xs font-bold ${summary.changePct <= 0 ? 'text-[#147366]' : 'text-[#b83e29]'}`}>
              <TrendingDown size={14} className={summary.changePct > 0 ? 'rotate-180' : ''} />
              {Math.abs(summary.changePct)}% {summary.changePct <= 0 ? 'lower' : 'higher'} than the same days last month
            </span>
          )}""")
s=s.replace("const percentage = Math.min(100, Math.max(8, Math.round((amt / maxExpense) * 100)))\n                const barColor = amt >= 80000 ? 'bg-[#b8521a]' : 'bg-[#cfa472]'","const percentage = Math.min(100, Math.max(4, Math.round((amt / maxExpense) * 100)))\n                const barColor = amt >= maxExpense * 0.6 ? 'bg-[#b8521a]' : 'bg-[#cfa472]'")
s=s.replace("""            By category
          </h2>""","""            By category
          </h2>
          <p className="-mt-2 mb-4 text-[11px] font-semibold text-[#6e8a81]">Operating expenses only — stock purchases are cost of goods, not expenses.</p>""")
# editing a category adjusted a cumulative ledger balance: keep Edit but pointing to ledger by name
s=s.replace("onClick={() => setEditingExpense({ id: cat.id, name: cat.name, current_balance: amt, category: 'expense' })}","onClick={async () => { const ledger = await accDb.ledgers.where('name').equalsIgnoreCase(cat.name).first(); if (ledger) setEditingExpense(ledger) }}")
s=s.replace("""const formatAmount = (amt) => {
    if (amt >= 100000)""","""const formatAmount = (amt) => {
    if (amt < 0) return `-${formatAmount(-amt)}`
    if (amt >= 100000)""")
open(p,'w').write(s)
EOF
grep -n "formatAmount = \|return \`₹\${amt}\`" ExpensesPage.jsx; cd .. && npx oxlint src/pages/ExpensesPage.jsx src/pages/DashboardPage.jsx src/lib 2>&1 | tail -4
```

**Output**

```text
47:  const formatAmount = (amt) => {
51:    return `₹${amt}`
No files found to lint. Please check your paths and ignore patterns.
Finished in 2ms on 0 files with 104 rules using 1 threads.
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && sed -n 140,260p DebtorsPage.jsx | grep -n "age_bucket\|due_days\|agingStats\|filteredCustomers\|last_invoice\|map(\|current_balance\|ageTone\|Settled" 
```

**Output**

```text
11:              style={{ width: agingStats.p1 }}
12:              title={`0–30d: ₹${(agingStats.cat0to30 / 100000).toFixed(1)}L`}
16:              style={{ width: agingStats.p2 }}
17:              title={`31–60d: ₹${(agingStats.cat31to60 / 100000).toFixed(1)}L`}
21:              style={{ width: agingStats.p3 }}
22:              title={`60d+: ₹${(agingStats.cat60plus / 100000).toFixed(1)}L`}
30:              0–30d ₹{(agingStats.cat0to30 / 100000).toFixed(1)}L
34:              31–60d ₹{(agingStats.cat31to60 / 100000).toFixed(1)}L
38:              60d+ ₹{(agingStats.cat60plus / 100000).toFixed(1)}L
57:          {filteredCustomers.length > 0 ? (
58:            filteredCustomers.map((cust) => {
59:              const bal = Number(cust.current_balance) || 0
60:              const days = Number(cust.due_days) || 10
81:                        Last invoice {cust.last_invoice || 'Recent'}
98:                        {cust.age_bucket || (days > 60 ? '60d+' : days > 30 ? '31–60d' : '0–30d')}
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && sed -n 196,215p DebtorsPage.jsx
```

**Output**

```text
          {filteredCustomers.length > 0 ? (
            filteredCustomers.map((cust) => {
              const bal = Number(cust.current_balance) || 0
              const days = Number(cust.due_days) || 10
              const isCritical = days > 60

              return (
                <article
                  key={cust.id}
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
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && python3 - <<'EOF'
p='DebtorsPage.jsx'
s=open(p).read()
s=s.replace("import { accDb } from '../lib/accountingDb'\n","import { accDb } from '../lib/accountingDb'\nimport { computeDebtorAging } from '../lib/dashboardMetrics'\n")
a=s.index("  // Load debtors from Dexie DB")
b=s.index("  const filteredCustomers")
new="""  const [vouchers, setVouchers] = useState([])
  const [showSettled, setShowSettled] = useState(false)

  // Load debtors + their invoices (needed to age the balances by real invoice dates)
  const loadDebtors = useCallback(async () => {
    try {
      const [dbDebtors, dbVouchers] = await Promise.all([
        accDb.parties.where('type').equals('debtor').toArray(),
        accDb.vouchers.where('voucher_type').equals('sales').toArray(),
      ])
      setCustomers(dbDebtors)
      setVouchers(dbVouchers)
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

  const aging = useMemo(() => computeDebtorAging(customers, vouchers), [customers, vouchers])

  // Dues only: a zero balance is settled and a negative one is an advance, neither is "owed to you".
  const owing = useMemo(() => customers.filter((c) => (Number(c.current_balance) || 0) > 0), [customers])
  const totalOwed = useMemo(() => owing.reduce((acc, c) => acc + Number(c.current_balance), 0), [owing])

  const agingStats = useMemo(() => {
    const cat0to30 = aging.totals['0–30d']
    const cat31to60 = aging.totals['31–60d']
    const cat60plus = aging.totals['60d+']
    const total = cat0to30 + cat31to60 + cat60plus || 1
    const p1 = Math.round((cat0to30 / total) * 100)
    const p2 = Math.round((cat31to60 / total) * 100)
    const p3 = Math.max(0, 100 - p1 - p2)
    return { cat0to30, cat31to60, cat60plus, p1: `${p1}%`, p2: `${p2}%`, p3: `${p3}%` }
  }, [aging])

  // Biggest dues first, so the people to chase are at the top.
  const visibleCustomers = useMemo(() => {
    const list = showSettled ? customers : owing
    return [...list].sort((a, b) => (Number(b.current_balance) || 0) - (Number(a.current_balance) || 0) || String(a.name).localeCompare(String(b.name)))
  }, [customers, owing, showSettled])

"""
s=s[:a]+new+s[b:]
s=s.replace("""    if (!searchTerm.trim()) return customers
    const term = searchTerm.toLowerCase()
    return customers.filter(""","""    if (!searchTerm.trim()) return visibleCustomers
    const term = searchTerm.toLowerCase()
    return visibleCustomers.filter(""")
s=s.replace("  }, [customers, searchTerm])","  }, [visibleCustomers, searchTerm])")
s=s.replace("""              const days = Number(cust.due_days) || 10
              const isCritical = days > 60
""","""              const ageInfo = aging.byParty.get(cust.id ?? cust.name)
              const ageLabel = bal > 0 ? (ageInfo?.bucket || '0–30d') : (bal < 0 ? 'Advance' : 'Settled')
              const isCritical = ageInfo?.bucket === '60d+'
""")
s=s.replace("{cust.age_bucket || (days > 60 ? '60d+' : days > 30 ? '31–60d' : '0–30d')}","{ageLabel}")
s=s.replace("(aging ${cust.age_bucket || 'due'})","(overdue bucket ${aging.byParty.get(cust.id ?? cust.name)?.bucket || 'due'})")
# toggle button under search: insert before the list section
s=s.replace("          {filteredCustomers.length > 0 ? (","""          <label className="mb-3 flex items-center gap-2 text-xs font-bold text-[#55736a]">
            <input type="checkbox" checked={showSettled} onChange={(e) => setShowSettled(e.target.checked)} />
            Show settled and advance accounts
          </label>
          {filteredCustomers.length > 0 ? (""",1)
open(p,'w').write(s)
EOF
grep -n "totalOwed\|Last invoice" DebtorsPage.jsx | head
```

**Output**

```text
56:  const totalOwed = useMemo(() => owing.reduce((acc, c) => acc + Number(c.current_balance), 0), [owing])
137:            ₹{(totalOwed / 100000).toFixed(1)}L
219:                        Last invoice {cust.last_invoice || 'Recent'}
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && python3 - <<'EOF'
p='DebtorsPage.jsx'
s=open(p).read()
s=s.replace("  const aging = useMemo(() => computeDebtorAging(customers, vouchers), [customers, vouchers])\n","""  const aging = useMemo(() => computeDebtorAging(customers, vouchers), [customers, vouchers])
  const lastInvoiceByParty = useMemo(() => {
    const latest = new Map()
    for (const v of vouchers) {
      const key = String(v.party_name || '').trim().toLowerCase()
      if (v.date && (!latest.get(key) || v.date > latest.get(key))) latest.set(key, String(v.date).slice(0, 10))
    }
    return latest
  }, [vouchers])
""")
s=s.replace("Last invoice {cust.last_invoice || 'Recent'}","""Last invoice {lastInvoiceByParty.get(String(cust.name).trim().toLowerCase())
                          ? new Date(lastInvoiceByParty.get(String(cust.name).trim().toLowerCase()) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                          : '—'}""")
open(p,'w').write(s)

p='SalesPage.jsx'
s=open(p).read()
s=s.replace("import { calculateSalesMetrics } from '../lib/dashboardMetrics'","import { calculateSalesMetrics, computeDebtorAging } from '../lib/dashboardMetrics'")
a=s.index("      const dbVouchers = await accDb.vouchers")
b=s.index("      } else {\n        setInvoices([])")
new="""      const [dbVouchers, parties] = await Promise.all([
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
"""
s=s[:a]+new+s[b:]
open(p,'w').write(s)
EOF
sed -n 25,80p SalesPage.jsx | head -70; grep -n "calculateSalesMetrics(invoices" SalesPage.jsx
```

**Output**

```text
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
38:  const { sales7Days, sales7DaysTotal } = useMemo(() => calculateSalesMetrics(invoices), [invoices])
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/lib && python3 - <<'EOF'
p='accountingDb.js'
s=open(p).read()

# 1. double count on first credit sale
s=s.replace("""    opening_balance: 0,
    current_balance: Number(dueAmount) || 0,
    age_bucket: '0–30d',
    created_at: new Date().toISOString(),
  })

  const createdParty""","""    opening_balance: 0,
    // 0, not dueAmount: applyVoucherEffects adds the invoice's due amount to the party right
    // after this. Seeding it here as well doubled the first credit sale to every new customer.
    current_balance: 0,
    age_bucket: '0–30d',
    created_at: new Date().toISOString(),
  })

  const createdParty""")

# 2. bank/cash ledger selection helper
s=s.replace("""/**
 * Apply Voucher Balance and Inventory Effects
 */""","""const BANK_MODE = /bank|hdfc|sbi|icici|axis|kotak|neft|rtgs|imps|upi|cheque|card|online|gpay|phonepe|paytm/i

/**
 * Pick the cash/bank ledger a payment mode refers to. A ledger named exactly like the mode wins
 * ("SBI" → the SBI ledger); otherwise the first ledger of the right kind. Every function used to
 * pick the first bank ledger regardless of the mode, and each had a different idea of what "bank" meant.
 */
export async function findCashBankLedger(database, paymentMode) {
  const mode = String(paymentMode || 'Cash').trim()
  const isBank = BANK_MODE.test(mode)
  for (const group of ['Bank Accounts', 'Cash-in-hand']) {
    const candidate = await database.ledgers.where('name').equalsIgnoreCase(mode).first()
    if (candidate && (candidate.group === group)) return candidate
  }
  return (await database.ledgers.where('group').equals(isBank ? 'Bank Accounts' : 'Cash-in-hand').first()) || null
}

/**
 * Apply Voucher Balance and Inventory Effects
 */""")

# 3. stock clamp
s=s.replace("""        const newQty = Math.max(0, (Number(material.current_qty) || 0) + qtyChange)""","""        // No clamp at 0: Tally allows negative stock, and clamping makes a later reversal
        // (delete/edit) add back more than was ever removed, inflating stock.
        const newQty = (Number(material.current_qty) || 0) + qtyChange""")
# 4. party clamp
s=s.replace("""      const newBalance = Math.max(0, (Number(party.current_balance) || 0) + balanceChange)
      await database.parties.update(party.id, { current_balance: newBalance })""","""      const newBalance = (Number(party.current_balance) || 0) + balanceChange
      await database.parties.update(party.id, { current_balance: newBalance })""")
# 5. cash ledger in applyVoucherEffects
a=s.index("  // 3. Cash & Bank Ledgers")
b=s.index("    let cashChange = 0")
s=s[:a]+"""  // 3. Cash & Bank Ledgers
  const targetLedger = await findCashBankLedger(database, voucher.payment_mode)
  if (targetLedger) {
"""+s[b:]
# supplier payment
s=s.replace("const newBal = Math.max(0, (Number(supplier.current_balance) || 0) - payAmt)","const newBal = (Number(supplier.current_balance) || 0) - payAmt")
s=s.replace("""    const isBank = paymentMode.toLowerCase().includes('bank') || paymentMode.toLowerCase().includes('hdfc') || paymentMode.toLowerCase().includes('upi')
    const groupName = isBank ? 'Bank Accounts' : 'Cash-in-hand'
    const ledger = await accDb.ledgers.where('group').equals(groupName).first()
    if (ledger) {
      const newLedgerBal = Math.max(0, (Number(ledger.current_balance) || 0) - payAmt)""","""    const ledger = await findCashBankLedger(accDb, paymentMode)
    if (ledger) {
      const newLedgerBal = (Number(ledger.current_balance) || 0) - payAmt""")
s=s.replace("const newBal = Math.max(0, (Number(debtor.current_balance) || 0) - recAmt)","const newBal = (Number(debtor.current_balance) || 0) - recAmt")
s=s.replace("""    const isBank = paymentMode.toLowerCase().includes('bank') || paymentMode.toLowerCase().includes('hdfc') || paymentMode.toLowerCase().includes('upi')
    const groupName = isBank ? 'Bank Accounts' : 'Cash-in-hand'
    const ledger = await accDb.ledgers.where('group').equals(groupName).first()
    if (ledger) {
      const newLedgerBal = (Number(ledger.current_balance) || 0) + recAmt""","""    const ledger = await findCashBankLedger(accDb, paymentMode)
    if (ledger) {
      const newLedgerBal = (Number(ledger.current_balance) || 0) + recAmt""")
s=s.replace("""    const isBank = paymentMode.toLowerCase().includes('bank') || paymentMode.toLowerCase().includes('hdfc') || paymentMode.toLowerCase().includes('upi')
    const groupName = isBank ? 'Bank Accounts' : 'Cash-in-hand'
    const ledger = await accDb.ledgers.where('group').equals(groupName).first()
    if (ledger) {
      const newLedgerBal = Math.max(0, (Number(ledger.current_balance) || 0) - expAmt)""","""    const ledger = await findCashBankLedger(accDb, paymentMode)
    if (ledger) {
      const newLedgerBal = (Number(ledger.current_balance) || 0) - expAmt""")
open(p,'w').write(s)
EOF
grep -n "Math.max(0" accountingDb.js; sed -n '/3. Cash & Bank/,/^}/p' accountingDb.js | head -30
```

**Output**

```text
315:          ? Math.max(0, (Number(nextData.amount) || 0) - (Number(nextData.paid_amount) || 0))
568:  const qty = Math.max(0, Number(newQty) || 0)
696:    cleanUpdates.current_qty = Math.max(0, Number(cleanUpdates.current_qty) || 0)
734:    cleanUpdates.due_amount = Math.max(0, cleanUpdates.amount - cleanUpdates.paid_amount)
  // 3. Cash & Bank Ledgers
  const targetLedger = await findCashBankLedger(database, voucher.payment_mode)
  if (targetLedger) {
    let cashChange = 0
    if (voucher.voucher_type === 'sales') {
      cashChange = paidAmount * multiplier
    } else if (voucher.voucher_type === 'purchase') {
      cashChange = -paidAmount * multiplier
    } else if (voucher.voucher_type === 'receipt') {
      cashChange = amount * multiplier
    } else if (voucher.voucher_type === 'payment') {
      cashChange = -amount * multiplier
    } else if (voucher.voucher_type === 'contra') {
      cashChange = 0
    }

    const newLedgerBalance = (Number(targetLedger.current_balance) || 0) + cashChange
    await database.ledgers.update(targetLedger.id, { current_balance: newLedgerBalance })
  }
}
```

**Command**

```bash
cd /home/claude/MeemX-ERP && python3 - <<'EOF'
p='src/lib/accountingDb.js'
s=open(p).read()
a=s.index("  for (const group of ['Bank Accounts', 'Cash-in-hand']) {")
b=s.index("  return (await database.ledgers.where('group').equals(isBank")
s=s[:a]+"""  const named = await database.ledgers.where('name').equalsIgnoreCase(mode).first()
  if (named && ['Bank Accounts', 'Cash-in-hand'].includes(named.group)) return named
"""+s[b:]
open(p,'w').write(s)
EOF
sed -n 60,118p tests/accounting_voucher.test.mjs
```

**Output**

```text
      return await work()
    } catch (error) {
      for (const [name, rows] of Object.entries(tableSnapshots)) this[name].rows = rows
      this.settings.rows = settingsSnapshot
      throw error
    }
  }
}

const makeDatabase = () => new MemoryDatabase({
  vouchers: [{
    id: 1,
    voucher_no: 'S-1',
    voucher_type: 'sales',
    date: '2026-10-28',
    party_name: 'Apex',
    party_uid: 'UID-1',
    amount: 100,
    paid_amount: 40,
    due_amount: 60,
    payment_mode: 'Cash',
    items: [{ material_id: 9, sku: 'W-1', qty: 2 }],
  }],
  materials: [{ id: 9, sku: 'W-1', name: 'Widget', current_qty: 8 }],
  parties: [{ id: 3, name: 'Apex', type: 'debtor', uid: 'UID-1', current_balance: 60 }],
  ledgers: [{ id: 5, name: 'Cash', group: 'Cash-in-hand', current_balance: 1040 }],
})

describe('voucher accounting mutations', () => {
  it('reverses and reapplies stock, party balance, and cash for a partial edit', async () => {
    const database = makeDatabase()
    const service = cr9yMnTm4NSzvG9rrwjM2ec8xZgh1cafXH8({ database, now: () => new Date('2026-10-28T12:00:00.000Z') })

    const updated = await service.updateVoucher(1, {
      amount: 120,
      paid_amount: 50,
      items: [{ material_id: 9, sku: 'W-1', qty: 3 }],
    })

    assert.equal(updated.amount, 120)
    assert.equal(updated.paid_amount, 50)
    assert.equal(updated.due_amount, 70)
    assert.equal((await database.materials.get(9)).current_qty, 7)
    assert.equal((await database.parties.get(3)).current_balance, 70)
    assert.equal((await database.ledgers.get(5)).current_balance, 1050)
  })

  it('rolls dependent balance changes back when the voucher write fails', async () => {
    const database = makeDatabase()
    database.vouchers.failPut = true
    const service = cr9yMnTm4NSzvG9rrwjM2ec8xZgh1cafXH8({ database })

    await assert.rejects(service.updateVoucher(1, { amount: 120 }), /simulated write failure/)
    assert.equal((await database.materials.get(9)).current_qty, 8)
    assert.equal((await database.parties.get(3)).current_balance, 60)
    assert.equal((await database.ledgers.get(5)).current_balance, 1040)
    assert.equal((await database.vouchers.get(1)).amount, 100)
  })
})
```

**Command**

```bash
cd /home/claude/MeemX-ERP && cat >> tests/accounting_voucher.test.mjs <<'EOF'

describe('voucher accounting regressions', () => {
  const empty = () => new MemoryDatabase({
    vouchers: [], materials: [{ id: 9, sku: 'W-1', name: 'Widget', current_qty: 5 }], parties: [],
    ledgers: [
      { id: 1, name: 'HDFC Current', group: 'Bank Accounts', current_balance: 1000 },
      { id: 2, name: 'SBI', group: 'Bank Accounts', current_balance: 500 },
      { id: 3, name: 'Cash', group: 'Cash-in-hand', current_balance: 100 },
    ],
  })
  const sale = (extra) => ({ voucher_type: 'sales', voucher_no: 'S-9', date: '2026-10-30', party_name: 'New Customer',
    amount: 1000, paid_amount: 0, due_amount: 1000, payment_mode: 'Cash', items: [], ...extra })

  it('first credit sale to a new customer creates a due of exactly the invoice, not double', async () => {
    const database = empty()
    const service = cr9yMnTm4NSzvG9rrwjM2ec8xZgh1cafXH8({ database })
    await service.createVoucher(sale())
    const [party] = await database.parties.toArray()
    assert.equal(party.current_balance, 1000)
  })

  it('posts to the bank the payment mode names, not whichever bank ledger comes first', async () => {
    const database = empty()
    const service = cr9yMnTm4NSzvG9rrwjM2ec8xZgh1cafXH8({ database })
    await service.createVoucher(sale({ party_name: 'Cash', paid_amount: 1000, due_amount: 0, payment_mode: 'SBI' }))
    assert.equal((await database.ledgers.get(2)).current_balance, 1500)
    assert.equal((await database.ledgers.get(1)).current_balance, 1000)
    await service.createVoucher(sale({ voucher_no: 'S-10', party_name: 'Cash', paid_amount: 200, due_amount: 0, payment_mode: 'UPI' }))
    assert.equal((await database.ledgers.get(1)).current_balance, 1200)   // UPI is a bank mode
  })

  it('an oversold item goes negative and deleting the sale restores the exact stock', async () => {
    const database = empty()
    const service = cr9yMnTm4NSzvG9rrwjM2ec8xZgh1cafXH8({ database })
    const v = await service.createVoucher(sale({ party_name: 'Cash', paid_amount: 1000, due_amount: 0,
      items: [{ material_id: 9, sku: 'W-1', qty: 8 }] }))
    assert.equal((await database.materials.get(9)).current_qty, -3)
    await service.deleteVoucher(v.id)
    assert.equal((await database.materials.get(9)).current_qty, 5)       // was 8 with the old clamp
  })
})
EOF
npm test 2>&1 | grep -E "^# (tests|pass|fail)|not ok"
```

**Output**

```text
# tests 80
# pass 80
# fail 0
```

**Command**

```bash
cd /home/claude/MeemX-ERP && sed -n 1,90p tests/sync_service.test.mjs
```

**Output**

```text
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSyncService } from '../src/lib/syncServiceCore.js'
import { buildEntitySnapshot, normalizeCloudLedger, normalizeCloudMaterial, normalizeCloudVoucher } from '../src/lib/syncSnapshot.js'

class MemoryTable {
  constructor(rows = []) {
    this.rows = rows.map((row) => ({ ...row }))
  }

  async toArray() { return this.rows.map((row) => ({ ...row })) }
  async get(id) { const row = this.rows.find((entry) => entry.id === id); return row && { ...row } }
  filter(predicate) { return { toArray: async () => this.rows.filter(predicate).map((row) => ({ ...row })) } }
  async update(id, changes) {
    const row = this.rows.find((entry) => entry.id === id)
    if (!row) return 0
    Object.assign(row, changes)
    return 1
  }
  async bulkPut(rows) {
    for (const row of rows) {
      if (row.id === undefined) row.id = Math.max(0, ...this.rows.map((entry) => entry.id || 0)) + 1
      const index = this.rows.findIndex((entry) => entry.id === row.id)
      if (index < 0) this.rows.push({ ...row })
      else this.rows[index] = { ...row }
    }
  }
  async bulkDelete(ids) { this.rows = this.rows.filter((row) => !ids.includes(row.id)) }
}

class MemorySettings {
  constructor(rows = []) { this.rows = new Map(rows.map((row) => [row.key, { ...row }])) }
  async get(key) { const row = this.rows.get(key); return row && { ...row } }
  async put(row) { this.rows.set(row.key, { ...row }) }
}

class MemoryDatabase {
  constructor(tables, settings = []) {
    this.tables = Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, new MemoryTable(rows)]))
    this.settings = new MemorySettings(settings)
  }
  table(name) { return this.tables[name] }
  async transaction(_mode, _tables, work) { return work() }
}

class MockQuery {
  constructor(client, table) { this.client = client; this.table = table; this.mode = 'select'; this.payload = null; this.fromRow = 0; this.toRow = 499; this.filters = []; this.singleResult = false }
  select() { return this }
  order() { return this }
  eq(field, value) { this.filters.push([field, value]); return this }
  limit() { return this }
  range(from, to) { this.fromRow = from; this.toRow = to; return this }
  upsert(payload) { this.mode = 'upsert'; this.payload = payload; return this }
  update(payload) { this.mode = 'update'; this.payload = payload; return this }
  delete() { this.mode = 'delete'; return this }
  maybeSingle() { this.singleResult = true; return this.execute() }
  single() { this.singleResult = true; return this.execute() }
  then(resolve, reject) { return this.execute().then(resolve, reject) }
  async execute() {
    if (this.table === 'profiles') return { data: { role: this.client.role }, error: null }
    if (this.mode === 'upsert') {
      const id = this.payload.id || `cloud-${this.table}-${this.client.upserts.length + 1}`
      const row = { ...this.payload, id }
      this.client.upserts.push({ table: this.table, payload: this.payload, row })
      await this.client.onUpsert({ table: this.table, payload: this.payload, row })
      return { data: row, error: null }
    }
    if (this.mode === 'update') {
      this.client.updates.push({ table: this.table, payload: this.payload })
      return { data: [], error: null }
    }
    if (this.mode === 'delete') {
      this.client.deletes.push(this.table)
      return { data: [], error: null }
    }
    const result = this.client.snapshot[this.table] || { data: [], error: null }
    if (!result.error && Array.isArray(result.data)) {
      const filtered = result.data.filter((row) => this.filters.every(([field, value]) => row[field] === value))
      if (this.singleResult) return { ...result, data: filtered[0] || null }
      return { ...result, data: filtered.slice(this.fromRow, this.toRow + 1) }
    }
    return result
  }
}

function mockCloud({ snapshot = {}, role = 'owner', onUpsert = () => {} } = {}) {
  const client = {
    role,
    snapshot,
    onUpsert,
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/lib && python3 - <<'EOF'
p='syncServiceCore.js'
s=open(p).read()

# natural keys per entity
s=s.replace("""    conflict: 'name',
    normalize: normalizeCloudLedger,""","""    conflict: 'name',
    naturalKey: (row) => String(row.name || '').trim().toLowerCase(),
    normalize: normalizeCloudLedger,""")
s=s.replace("""    conflict: 'sku',
    normalize: normalizeCloudMaterial,""","""    conflict: 'sku',
    naturalKey: (row) => String(row.sku || '').trim().toLowerCase(),
    normalize: normalizeCloudMaterial,""")
s=s.replace("""    conflict: 'voucher_no',
    normalize: normalizeCloudVoucher,""","""    conflict: 'voucher_no',
    naturalKey: (row) => String(row.voucher_no || '').trim().toLowerCase(),
    normalize: normalizeCloudVoucher,""")
s=s.replace("""    fields: ['name', 'type', 'uid', 'phone', 'email', 'address', 'opening_balance', 'current_balance'],
    normalize: normalizeCloudParty,""","""    fields: ['name', 'type', 'uid', 'phone', 'email', 'address', 'opening_balance', 'current_balance'],
    naturalKey: (row) => `${row.type}|${String(row.name || '').trim().toLowerCase()}`,
    normalize: normalizeCloudParty,""")
s=s.replace("fields: ['name', 'group', 'opening_balance', 'current_balance', 'is_system', 'category'],","fields: ['name', 'group', 'primary_group', 'opening_balance', 'current_balance', 'is_system', 'category'],")

# shared settings constants
s=s.replace("const CLOUD_PAGE_SIZE = 500\n","""const CLOUD_PAGE_SIZE = 500

// View settings every device must agree on. They used to live only in each browser's IndexedDB,
// so an admin hiding a card from the owner (or changing the layout) never reached the owner's device.
const SHARED_SETTINGS = [
  { key: 'owner_permissions', json: true },
  { key: 'card_order', json: true },
  { key: 'shop_name', json: false },
]
""")

# readCloudVersion + shared settings, inserted before readCloudSnapshot
s=s.replace("  async function readCloudSnapshot() {","""  /** Cheap change marker the connector bumps on every commit; null if unavailable (old schema). */
  async function readCloudVersion() {
    try {
      const { data, error } = await cloud.from('accounting_refresh_state').select('last_data_change_at').eq('id', 1).maybeSingle()
      const row = Array.isArray(data) ? data[0] : data
      return !error && row?.last_data_change_at ? String(row.last_data_change_at) : null
    } catch {
      return null
    }
  }

  async function countDirtyRows() {
    let total = 0
    for (const entity of CLOUD_ENTITIES) {
      total += (await database.table(entity.localTable).filter((row) => row.local_dirty).toArray()).length
    }
    return total
  }

  async function pullSharedSettings(role) {
    try {
      const { data, error } = await cloud.from('app_settings').select('key,value')
      if (error || !Array.isArray(data)) return false
      const byKey = new Map(data.map((row) => [row.key, row.value]))
      let changed = false
      for (const { key, json } of SHARED_SETTINGS) {
        const local = await database.settings.get(key)
        if (!byKey.has(key)) {
          // First run after the migration: the admin's local choice seeds the cloud.
          if (role === 'admin' && local?.value != null) await pushSharedSetting(key, local.value)
          continue
        }
        // The admin device is the author; only non-admin devices follow the cloud.
        if (role === 'admin') continue
        const value = json ? JSON.stringify(byKey.get(key)) : String(byKey.get(key) ?? '')
        if (local?.value !== value) { await database.settings.put({ key, value }); changed = true }
      }
      return changed
    } catch (error) {
      logError('Shared settings sync skipped:', error)
      return false
    }
  }

  async function pushSharedSetting(key, rawValue) {
    const spec = SHARED_SETTINGS.find((item) => item.key === key)
    if (!spec || !isConfigured) return false
    try {
      const { data: { user } = {} } = await cloud.auth.getUser()
      let value = rawValue
      if (spec.json) value = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue
      const { error } = await cloud.from('app_settings')
        .upsert({ key, value, updated_at: now().toISOString(), updated_by: user?.id ?? null }, { onConflict: 'key' })
      if (error) throw new Error(error.message)
      return true
    } catch (error) {
      logError(`Could not publish shared setting ${key}:`, error)
      return false
    }
  }

  async function readCloudSnapshot() {""")

# pushLocalChanges returns role
s=s.replace("if (profile.role !== 'admin') return { pushed: [], deleted: [], pendingDeletes }","if (profile.role !== 'admin') return { pushed: [], deleted: [], pendingDeletes, role: profile.role }")
s=s.replace("    return { pushed, deleted: pendingDeletes, pendingDeletes }\n  }","    return { pushed, deleted: pendingDeletes, pendingDeletes, role: profile.role }\n  }")

# performCloudSync with onlyIfChanged
s=s.replace("  async function performCloudSync() {\n    if (!isConfigured)","  async function performCloudSync({ onlyIfChanged = false } = {}) {\n    if (!isConfigured)")
s=s.replace("""      // Read and validate every cloud table before changing local state or pushing edits.
      const [parties, ledgers, materials, vouchers] = await readCloudSnapshot()
      const { pushed, deleted, pendingDeletes } = await pushLocalChanges(user.id)
""","""      // Read the change marker BEFORE the snapshot: anything committed while we read bumps it
      // again, so the next poll sees a newer value and re-syncs instead of missing the change.
      const cloudVersion = await readCloudVersion()
      if (onlyIfChanged && cloudVersion) {
        const known = (await database.settings.get('cloud_data_version'))?.value
        if (known === cloudVersion && (await countDirtyRows()) === 0) {
          return { success: true, skipped: true, lastSync: (await database.settings.get('last_cloud_sync'))?.value }
        }
      }

      // Read and validate every cloud table before changing local state or pushing edits.
      const [parties, ledgers, materials, vouchers] = await readCloudSnapshot()
      const { pushed, deleted, pendingDeletes, role } = await pushLocalChanges(user.id)
""")
s=s.replace("""      const nowIso = now().toISOString()
      await database.settings.put({ key: 'last_cloud_sync', value: nowIso })""","""      const settingsChanged = await pullSharedSettings(role)
      if (cloudVersion) await database.settings.put({ key: 'cloud_data_version', value: cloudVersion })
      const nowIso = now().toISOString()
      await database.settings.put({ key: 'last_cloud_sync', value: nowIso })""")
s=s.replace("""      dispatchUpdates()

      return {
        success: true,""","""      dispatchUpdates(settingsChanged)

      return {
        success: true,""")
s=s.replace("""              entity.normalize,
              suppressedIds.get(entity.cloudTable),
              remoteDeletedIds.get(entity.cloudTable),
            )""","""              entity.normalize,
              suppressedIds.get(entity.cloudTable),
              remoteDeletedIds.get(entity.cloudTable),
              entity.naturalKey,
            )""")
s=s.replace("""  async function syncFromSupabase() {
    if (activeSync) {
      syncRequestedWhileActive = true
      return activeSync
    }

    let result
    do {
      syncRequestedWhileActive = false
      const currentSync = performCloudSync()""","""  async function syncFromSupabase(options = {}) {
    if (activeSync) {
      syncRequestedWhileActive = !options.onlyIfChanged || syncRequestedWhileActive
      return activeSync
    }

    let result
    let first = true
    do {
      syncRequestedWhileActive = false
      // A follow-up pass requested during a run is always a full sync.
      const currentSync = performCloudSync(first ? options : {})
      first = false""")
s=s.replace("  return { ensureSupabaseAuth, syncFromSupabase }","  return { ensureSupabaseAuth, syncFromSupabase, pushSharedSetting, readCloudVersion }")
# dispatchUpdates default: settings event only when needed
s=s.replace("""  dispatchUpdates = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('accounting-data-updated'))
      window.dispatchEvent(new Event('accounting-settings-updated'))
    }
  },""","""  dispatchUpdates = (settingsChanged = true) => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('accounting-data-updated'))
      if (settingsChanged) window.dispatchEvent(new Event('accounting-settings-updated'))
    }
  },""")
open(p,'w').write(s)

# syncSnapshot natural-key adoption + age bucket fix
p='syncSnapshot.js'
s=open(p).read()
s=s.replace("""  suppressedCloudIds = new Set(),
  remoteDeletedIds = new Set(),
) {
  const localByCloudId = new Map()
  for (const row of localRows) {
    if (row.cloud_id) localByCloudId.set(row.cloud_id, row)
  }
""","""  suppressedCloudIds = new Set(),
  remoteDeletedIds = new Set(),
  naturalKey = null,
) {
  const localByCloudId = new Map()
  for (const row of localRows) {
    if (row.cloud_id) localByCloudId.set(row.cloud_id, row)
  }
  // A clean local row that was created before it was ever synced (e.g. from an earlier Excel
  // import) is the same record as the cloud row with the same natural key. Adopt it instead of
  // inserting a duplicate next to it.
  const adoptableByKey = new Map()
  if (naturalKey) {
    for (const row of localRows) {
      if (!row.cloud_id && !row.local_dirty) adoptableByKey.set(naturalKey(row), row)
    }
  }
""")
s=s.replace("    const localRow = localByCloudId.get(cloudRow.id)\n    if (localRow?.local_dirty) continue","""    let localRow = localByCloudId.get(cloudRow.id)
    if (!localRow && naturalKey) {
      const key = naturalKey(cloudRow)
      localRow = adoptableByKey.get(key)
      if (localRow) adoptableByKey.delete(key)
    }
    if (localRow?.local_dirty) continue""")
# party age bucket must not be hardcoded
s=s.replace("  age_bucket: party.age_bucket || '0–30d',\n  next_payment: party.next_payment || '',\n  due_days: Number(party.due_days || 15),\n})","  // age_bucket / due_days are NOT cloud columns. Ageing is computed from invoice dates\n  // (computeDebtorAging); hardcoding '0–30d' here made every synced debtor look current.\n})")
s=s.replace("  address: party.address || '',\n  opening_balance: Number(party.opening_balance || 0),\n  current_balance: Number(party.current_balance || 0),\n  // age_bucket","  address: party.address || '',\n  opening_balance: Number(party.opening_balance || 0),\n  current_balance: Number(party.current_balance || 0),\n  // age_bucket")
s=s.replace("""    opening_balance: Number(ledger.opening_balance || 0),
    current_balance: Number(ledger.current_balance || 0),
    category,
  }""","""    primary_group: ledger.primary_group || '',
    opening_balance: Number(ledger.opening_balance || 0),
    current_balance: Number(ledger.current_balance || 0),
    category,
  }""")
s=s.replace("""const category = ledger.category && !(ledger.category === 'asset' && categoryFromGroup !== 'asset')""","""const category = ledger.category && !(ledger.category === 'asset' && categoryFromGroup !== 'asset')""")
s=s.replace("const categoryFromGroup = tallyLedgerCategory(group)","const categoryFromGroup = tallyLedgerCategory(ledger.primary_group || group)")
open(p,'w').write(s)

p='syncService.js'
s=open(p).read()
s+="export const pushSharedSetting = syncService.pushSharedSetting\nexport const readCloudVersion = syncService.readCloudVersion\n"
open(p,'w').write(s)
EOF
cd ../.. && node --test tests/sync_service.test.mjs 2>&1 | grep -E "^# (pass|fail)|not ok"; sed -n '/normalizeCloudParty = /,/^})/p' src/lib/syncSnapshot.js
```

**Output**

```text
# pass 11
# fail 0
export const normalizeCloudParty = (party) => ({
  name: party.name || 'Unnamed',
  type: party.type || 'debtor',
  uid: party.uid || '',
  phone: party.phone || '',
  email: party.email || '',
  address: party.address || '',
  opening_balance: Number(party.opening_balance || 0),
  current_balance: Number(party.current_balance || 0),
  // age_bucket / due_days are NOT cloud columns. Ageing is computed from invoice dates
  // (computeDebtorAging); hardcoding '0–30d' here made every synced debtor look current.
})
```

**Command**

```bash
cd /home/claude/MeemX-ERP && sed -n 90,150p tests/sync_service.test.mjs
```

**Output**

```text
    onUpsert,
    upserts: [],
    updates: [],
    deletes: [],
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }) },
    from(table) { return new MockQuery(this, table) },
  }
  return client
}

const emptyTables = () => ({ parties: [], ledgers: [], materials: [], vouchers: [] })

describe('buildEntitySnapshot', () => {
  it('keeps local-only and dirty rows, maps stable IDs, and removes explicit remote deletions', () => {
    const result = buildEntitySnapshot([
      { id: 1, cloud_id: 'party-1', name: 'Old', local_dirty: false },
      { id: 2, name: 'Device only', local_dirty: true },
      { id: 3, cloud_id: 'party-deleted', name: 'Deleted', local_dirty: false },
      { id: 4, cloud_id: 'party-2', name: 'Unsynced edit', local_dirty: true },
    ], [
      { id: 'party-1', name: 'Cloud edit' },
      { id: 'party-2', name: 'Older cloud value' },
      { id: 'party-3', name: 'New cloud row' },
    ], (row) => ({ name: row.name }), new Set(), new Set(['party-deleted']))

    assert.deepEqual(result.upserts, [
      { id: 1, name: 'Cloud edit', cloud_id: 'party-1', local_dirty: false },
      { name: 'New cloud row', cloud_id: 'party-3', local_dirty: false },
    ])
    assert.deepEqual(result.deleteIds, [3])
  })

  it('does not re-import a cloud row while its local deletion waits for an admin', () => {
    const result = buildEntitySnapshot([], [{ id: 'voucher-1', voucher_no: '1' }], (row) => row, new Set(['voucher-1']))
    assert.deepEqual(result, { upserts: [], deleteIds: [] })
  })

  it('derives expense category from a cloud ledger group and strips device-local voucher item IDs', () => {
    assert.equal(normalizeCloudLedger({ name: 'Rent', group: 'Indirect Expenses' }).category, 'expense')
    assert.equal(normalizeCloudMaterial({ name: 'Widget' }).sku, 'SKU-1')
    const voucher = normalizeCloudVoucher({ items: [{ material_id: 24, sku: 'W-1', qty: 2, cost_rate: 10 }] })
    assert.deepEqual(voucher.items, [{ sku: 'W-1', qty: 2, cost_rate: 10 }])
  })
})

describe('sync service', () => {
  it('leaves Dexie accounting rows unchanged when any cloud table read fails', async () => {
    const database = new MemoryDatabase({
      ...emptyTables(),
      parties: [{ id: 1, cloud_id: 'party-1', name: 'Keep me', local_dirty: false }],
    }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ snapshot: {
      parties: { data: [{ id: 'party-1', name: 'Changed in cloud' }], error: null },
      ledgers: { data: null, error: { message: 'temporary outage' } },
      materials: { data: [], error: null },
      vouchers: { data: [], error: null },
    } })
    const service = createSyncService({
      cloud,
      database,
      isConfigured: true,
```

**Command**

```bash
cd /home/claude/MeemX-ERP && cat >> tests/sync_service.test.mjs <<'EOF'

describe('live sync', () => {
  const baseSnapshot = (version) => ({
    accounting_refresh_state: { data: { last_data_change_at: version }, error: null },
    parties: { data: [], error: null }, ledgers: { data: [], error: null },
    materials: { data: [], error: null },
    vouchers: { data: [{ id: 'v-1', voucher_no: 'Sales-1', voucher_type: 'sales', date: '2026-10-30', amount: 10 }], error: null },
  })
  const build = (database, cloud) => createSyncService({ cloud, database, isConfigured: true, dispatchUpdates: () => {}, logError: () => {} })

  it('a poll is a no-op when nothing changed, and re-reads as soon as the Tally connector commits', async () => {
    const database = new MemoryDatabase(emptyTables(), [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ snapshot: baseSnapshot('t1'), role: 'owner' })
    const service = build(database, cloud)

    assert.equal((await service.syncFromSupabase({ onlyIfChanged: true })).skipped, undefined)   // first time: full read
    assert.equal(database.table('vouchers').rows.length, 1)

    assert.equal((await service.syncFromSupabase({ onlyIfChanged: true })).skipped, true)        // nothing new

    cloud.snapshot = {
      ...baseSnapshot('t2'),
      vouchers: { data: [
        { id: 'v-1', voucher_no: 'Sales-1', voucher_type: 'sales', date: '2026-10-30', amount: 10 },
        { id: 'v-2', voucher_no: 'Sales-2', voucher_type: 'sales', date: '2026-10-31', amount: 99 },
      ], error: null },
    }
    const result = await service.syncFromSupabase({ onlyIfChanged: true })
    assert.equal(result.skipped, undefined)
    assert.equal(database.table('vouchers').rows.length, 2)
  })

  it('vouchers tombstoned in the cloud (deleted in Tally) disappear from the device', async () => {
    const database = new MemoryDatabase({
      ...emptyTables(),
      vouchers: [{ id: 1, cloud_id: 'v-1', voucher_no: 'Sales-1', local_dirty: false }],
    }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ snapshot: { ...baseSnapshot('t3'), vouchers: { data: [{ id: 'v-1', voucher_no: 'Sales-1', deleted_at: '2026-10-31T00:00:00Z' }], error: null } } })
    await build(database, cloud).syncFromSupabase()
    assert.equal(database.table('vouchers').rows.length, 0)
  })

  it('adopts an identical never-synced local row instead of creating a duplicate', () => {
    const result = buildEntitySnapshot(
      [{ id: 7, voucher_no: 'Sales-1', local_dirty: false }],
      [{ id: 'v-1', voucher_no: 'Sales-1' }],
      (row) => ({ voucher_no: row.voucher_no }), new Set(), new Set(),
      (row) => String(row.voucher_no).toLowerCase(),
    )
    assert.deepEqual(result.upserts, [{ voucher_no: 'Sales-1', id: 7, cloud_id: 'v-1', local_dirty: false }])
  })

  it('non-admin devices follow the admin\'s owner-permission and layout settings', async () => {
    const database = new MemoryDatabase(emptyTables(), [{ key: 'owner_permissions', value: '{"sales":true}' }])
    const cloud = mockCloud({ role: 'owner', snapshot: {
      ...baseSnapshot('t4'),
      app_settings: { data: [{ key: 'owner_permissions', value: { sales: false, profit: false } }, { key: 'card_order', value: ['debtors', 'sales'] }], error: null },
    } })
    await build(database, cloud).syncFromSupabase()
    assert.equal((await database.settings.get('owner_permissions')).value, '{"sales":false,"profit":false}')
    assert.equal((await database.settings.get('card_order')).value, '["debtors","sales"]')
  })
})
EOF
node --test tests/sync_service.test.mjs 2>&1 | grep -E "^# (pass|fail)|not ok|message|expected|actual" | head
```

**Output**

```text
# pass 15
# fail 0
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src && grep -rn "create-user\|functions.invoke" . | head; sed -n 90,130p components/AddUserModal.jsx
```

**Output**

```text
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
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && grep -n "activeTab\|tab ===\|teamUsers\|AddUserModal\|useAuth" SettingsControlPage.jsx | head -40; sed -n 370,430p SettingsControlPage.jsx
```

**Output**

```text
11:import { useAuth } from '../context/AuthContext'
14:import AddUserModal from '../components/AddUserModal'
26:    teamUsers,
27:  } = useAuth()
30:  const activeTabParam = searchParams.get('tab')
178:                  {activeTabParam === 'users'
180:                    : activeTabParam === 'activity'
367:                activeTabParam === 'users'
377:                  {teamUsers.length} {teamUsers.length === 1 ? 'PIN' : 'PINs'}
385:                {teamUsers.map((u) => {
638:        <AddUserModal
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
Starting with the AuthContext changes for role updates
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/context && python3 - <<'EOF'
p='AuthContext.jsx'
s=open(p).read()

s=s.replace("import { accDb, initDefaultAccountingData } from '../lib/accountingDb'","import { accDb, initDefaultAccountingData, setApplyingRemoteSnapshot } from '../lib/accountingDb'")
s=s.replace("import { syncFromSupabase } from '../lib/syncService'","import { syncFromSupabase, pushSharedSetting } from '../lib/syncService'")

# module-level helper
s=s.replace("const AuthContext = createContext(null)\n","""const AuthContext = createContext(null)

const ROLES = ['admin', 'owner', 'employee']
const LOCAL_TABLES = ['vouchers', 'materials', 'parties', 'ledgers']

/**
 * IndexedDB belongs to the browser, not the account. Without this, signing in as a different
 * user on the same browser showed the previous user's books (including data the new role
 * should not see) and let an admin push someone else's half-synced edits.
 * Unsynced edits are never silently destroyed: they are kept for an incoming admin, and
 * otherwise saved to a backup setting before the tables are cleared.
 */
async function isolateLocalDataForUser(userId, role) {
  const previous = localStorage.getItem('tallyflow_last_user_id')
  localStorage.setItem('tallyflow_last_user_id', userId)
  if (!previous || previous === userId) return

  const backup = {}
  setApplyingRemoteSnapshot(true)
  try {
    await accDb.transaction('rw', [...LOCAL_TABLES.map((name) => accDb.table(name)), accDb.settings], async () => {
      for (const name of LOCAL_TABLES) {
        const table = accDb.table(name)
        const dirty = (await table.toArray()).filter((row) => row.local_dirty)
        if (dirty.length) backup[name] = dirty
        await table.clear()
        if (role === 'admin' && dirty.length) await table.bulkAdd(dirty)
      }
      await accDb.settings.bulkDelete(role === 'admin'
        ? ['cloud_data_version', 'last_cloud_sync']
        : ['cloud_data_version', 'last_cloud_sync', 'pending_cloud_deletes'])
      if (role !== 'admin' && Object.keys(backup).length) {
        await accDb.settings.put({ key: `unsynced_backup_${Date.now()}`, value: JSON.stringify(backup) })
      }
    })
  } finally {
    setApplyingRemoteSnapshot(false)
  }
}
""")

# apply role isolation in applyAccountSession
s=s.replace("    setSessionUser(session.user)\n    setCurrentRole(resolvedProfile.role)","    await isolateLocalDataForUser(session.user.id, resolvedProfile.role)\n    setSessionUser(session.user)\n    setCurrentRole(resolvedProfile.role)")

# syncCloudNow with options
s=s.replace("""  const syncCloudNow = useCallback(async () => {
    setCloudSyncStatus('syncing')
    setCloudSyncError('')
    try {
      const result = await syncFromSupabase()
      if (!result.success) {""","""  const syncCloudNow = useCallback(async (options = {}) => {
    // Background polls must not flash "Syncing…" when there is nothing new.
    if (!options.onlyIfChanged) setCloudSyncStatus('syncing')
    try {
      const result = await syncFromSupabase(options)
      if (result.skipped) return result
      setCloudSyncError('')
      if (!result.success) {""")

# refreshRole + live effect
s=s.replace("""  const sessionUserId = sessionUser?.id
""","""  const sessionUserId = sessionUser?.id

  // Re-read the account's role from the database so a promotion/demotion applies to an open
  // session. Before, the role was read once at sign-in, so the view stayed wrong until re-login.
  const refreshRole = useCallback(async () => {
    if (!sessionUserId || !supabaseConfigured) return
    const { data: profile, error } = await supabase
      .from('profiles').select('role, full_name').eq('id', sessionUserId).maybeSingle()
    if (error) return                                    // offline/transient: keep what we have
    if (!profile || !ROLES.includes(profile.role)) {     // account removed or role revoked
      localStorage.removeItem('tallyflow_verified_profile')
      await supabase.auth.signOut()
      clearAccountSession()
      return
    }
    setCurrentRole((previous) => (previous === profile.role ? previous : profile.role))
    if (profile.full_name) setActiveUserName(profile.full_name)
    localStorage.setItem('tallyflow_verified_profile', JSON.stringify({ id: sessionUserId, role: profile.role, full_name: profile.full_name || '' }))
  }, [sessionUserId])
""")
a=s.index("  useEffect(() => {\n    if (!sessionUserId || !isPinUnlocked) return undefined")
b=s.index("  const signIn = async")
new="""  useEffect(() => {
    if (!sessionUserId || !isPinUnlocked) return undefined

    let active = true
    let debounceTimer = null
    const initialSyncTimer = setTimeout(() => {
      if (active) syncCloudNow()
    }, 0)

    const onLocalDataChanged = () => {
      if (currentRole !== 'admin') return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        if (active) syncCloudNow()
      }, 600)
    }

    // Live data: the Tally connector writes to Supabase every few minutes, but the browser used to
    // read the cloud once at login. Poll a tiny change marker, refresh when the tab regains focus
    // or the network returns, and listen for the connector's commit in realtime.
    const refreshIfVisible = () => {
      if (!active || document.visibilityState === 'hidden' || navigator.onLine === false) return
      refreshRole()
      syncCloudNow({ onlyIfChanged: true })
    }
    const pollTimer = setInterval(refreshIfVisible, 45_000)
    document.addEventListener('visibilitychange', refreshIfVisible)
    window.addEventListener('online', refreshIfVisible)
    window.addEventListener('accounting-local-data-changed', onLocalDataChanged)

    let channel = null
    if (supabaseConfigured) {
      try {
        channel = supabase.channel('accounting-refresh')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'accounting_refresh_state' }, () => {
            if (active) syncCloudNow({ onlyIfChanged: true })
          })
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles', filter: `id=eq.${sessionUserId}` }, () => {
            if (active) refreshRole()
          })
          .subscribe()
      } catch (error) {
        console.warn('Realtime refresh unavailable; falling back to polling.', error)
      }
    }

    return () => {
      active = false
      clearTimeout(initialSyncTimer)
      clearInterval(pollTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      document.removeEventListener('visibilitychange', refreshIfVisible)
      window.removeEventListener('online', refreshIfVisible)
      window.removeEventListener('accounting-local-data-changed', onLocalDataChanged)
      if (channel) supabase.removeChannel(channel)
    }
  }, [sessionUserId, isPinUnlocked, currentRole, syncCloudNow, refreshRole])

"""
s=s[:a]+new+s[b:]

# publish shared view settings
s=s.replace("""    await accDb.settings.put({ key: 'owner_permissions', value: JSON.stringify(updated) })
    window.dispatchEvent(new Event('accounting-settings-updated'))""","""    const serialized = JSON.stringify(updated)
    await accDb.settings.put({ key: 'owner_permissions', value: serialized })
    if (currentRole === 'admin') await pushSharedSetting('owner_permissions', serialized)
    window.dispatchEvent(new Event('accounting-settings-updated'))""")
s=s.replace("""    await accDb.settings.put({ key: 'card_order', value: JSON.stringify(newOrder) })
    window.dispatchEvent(new Event('accounting-settings-updated'))""","""    const serialized = JSON.stringify(newOrder)
    await accDb.settings.put({ key: 'card_order', value: serialized })
    if (currentRole === 'admin') await pushSharedSetting('card_order', serialized)
    window.dispatchEvent(new Event('accounting-settings-updated'))""")
s=s.replace("""    await accDb.settings.put({ key: 'shop_name', value: name })
    window.dispatchEvent(new Event('accounting-settings-updated'))""","""    await accDb.settings.put({ key: 'shop_name', value: name })
    if (currentRole === 'admin') await pushSharedSetting('shop_name', name)
    window.dispatchEvent(new Event('accounting-settings-updated'))""")

# account management API
s=s.replace("  const isAuthenticated = Boolean(sessionUser && isPinUnlocked)","""  // ── Real account roles (profiles table). Local device PINs never carry a role. ──
  const listAccounts = async () => {
    if (currentRole !== 'admin') return []
    const { data, error } = await supabase.from('profiles').select('id, full_name, role, created_at').order('created_at', { ascending: true })
    if (error) throw new Error(error.message)
    return data || []
  }

  const changeAccountRole = async (userId, role) => {
    if (currentRole !== 'admin') throw new Error('Only an administrator can change roles.')
    if (!ROLES.includes(role)) throw new Error('Unknown role.')
    if (userId === sessionUser?.id && role !== 'admin') {
      const admins = (await listAccounts()).filter((account) => account.role === 'admin')
      if (admins.length <= 1) throw new Error('You are the only administrator. Promote someone else first.')
    }
    const { data, error } = await supabase.from('profiles').update({ role }).eq('id', userId).select('id, role')
    if (error) throw new Error(error.message)
    if (!data?.length) throw new Error('The role was not changed (permission denied).')
    if (userId === sessionUser?.id) await refreshRole()
    return data[0]
  }

  const createAccount = async ({ email, password, fullName, role }) => {
    if (currentRole !== 'admin') throw new Error('Only an administrator can add accounts.')
    const { data, error } = await supabase.functions.invoke('create-user', { body: { email, password, fullName, role } })
    if (error) {
      let detail = error.message
      try { detail = (await error.context?.json?.())?.error || detail } catch { /* keep generic message */ }
      throw new Error(detail)
    }
    if (data?.error) throw new Error(data.error)
    return data?.user
  }

  const isAuthenticated = Boolean(sessionUser && isPinUnlocked)""")
s=s.replace("    saveTeamUser,\n    removeTeamUser,\n  }","    saveTeamUser,\n    removeTeamUser,\n    listAccounts,\n    changeAccountRole,\n    createAccount,\n  }")
open(p,'w').write(s)
EOF
grep -n "const clearAccountSession" AuthContext.jsx | head -2
```

**Output**

```text
120:  const clearAccountSession = () => {
```

**Command**

```bash
cd /home/claude/MeemX-ERP && python3 - <<'EOF'
p='supabase/functions/create-user/index.ts'
s=open(p).read()
s=s.replace("""    // Verify caller role is owner from profiles table""","""    // Only administrators manage accounts. (This used to demand role = 'owner', but owners are
    // read-only and cannot reach the user screen, so nobody could ever create a user.)""")
s=s.replace("""    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles')
      .select('role')
      .eq('id', callerUser.id)
      .single()

    if (profileError || callerProfile?.role !== 'owner') {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: Only an owner can create new users' }),""","""    const { data: callerProfile, error: profileError } = await callerClient
      .from('profiles')
      .select('role')
      .eq('id', callerUser.id)
      .maybeSingle()

    if (profileError || callerProfile?.role !== 'admin') {
      return new Response(
        JSON.stringify({ error: 'Unauthorized: Only an administrator can create new users' }),""")
s=s.replace("const assignedRole = role === 'owner' ? 'owner' : 'employee'","""// Honour the requested role (admin | owner | employee). It used to collapse everything that
    // was not 'owner' into 'employee', so an Admin could never be created. Unknown values are
    // rejected rather than guessed, and the safe default is read-only.
    if (role !== undefined && !['admin', 'owner', 'employee'].includes(role)) {
      return new Response(
        JSON.stringify({ error: 'Role must be admin, owner or employee' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
    const assignedRole = role ?? 'owner'""")
s=s.replace("""    if (upsertError) {
      return new Response(""","""    if (upsertError) {
      // Do not leave a login without a profile behind: it could never sign in and blocks the email.
      await adminClient.auth.admin.deleteUser(createdUserId)
      return new Response(""")
s=s.replace("JSON.stringify({ error: `User created, but profile update failed: ${upsertError.message}` }),","JSON.stringify({ error: `Could not create the profile, so the account was rolled back: ${upsertError.message}` }),")
open(p,'w').write(s)
EOF
cat > src/components/AccountRolesCard.jsx <<'EOF'
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
EOF
python3 - <<'EOF'
p='src/pages/SettingsControlPage.jsx'
s=open(p).read()
s=s.replace("import AddUserModal from '../components/AddUserModal'","import AddUserModal from '../components/AddUserModal'\nimport AccountRolesCard from '../components/AccountRolesCard'")
i=s.index("                  Local device PINs")
j=s.rfind("<div", 0, i)   # card wrapper start precedes; find the enclosing card opening
# insert the accounts card just before the PIN card's opening <section>/<div>
k=s.rfind("            <", 0, s.rfind("className", 0, s.rfind("Local device PINs", 0, len(s))))
print(s[k-200:k+120])
EOF
```

**Output**

```text
        ? 'border-[#0e655d] ring-2 ring-[#0e655d]/15'
                  : 'border-[#e1e9e3]'
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-base font-extrabold text-[#11382f]">
                  Local device PINs
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/pages && sed -n 355,372p SettingsControlPage.jsx
```

**Output**

```text
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
```

**Command**

```bash
cd /home/claude/MeemX-ERP && python3 - <<'EOF'
p='src/pages/SettingsControlPage.jsx'
s=open(p).read()
s=s.replace("import AddUserModal from '../components/AddUserModal'","import AddUserModal from '../components/AddUserModal'\nimport AccountRolesCard from '../components/AccountRolesCard'",1)
s=s.replace("            {/* Users and Access (PDF Page 14) */}","            <AccountRolesCard />\n\n            {/* Users and Access (PDF Page 14) */}",1)
open(p,'w').write(s)

# AddUserModal: the role picker on a local PIN was cosmetic; say so honestly
p='src/components/AddUserModal.jsx'
s=open(p).read()
print([l for l in s.splitlines() if 'role' in l.lower() and ('Admin' in l or 'Owner' in l)][:8])
EOF
npx vite build 2>&1 | tail -6
```

**Output**

```text
[]
PWA v1.3.0
mode      generateSW
precache  36 entries (1170.61 KiB)
files generated
  dist/sw.js
  dist/workbox-9c191d2f.js
```

**Command**

```bash
cd /home/claude/MeemX-ERP/src/components && grep -n "setRole\|'admin'\|'owner'\|view only\|Role" AddUserModal.jsx | head -20
```

**Output**

```text
25:  const [role, setRole] = useState('owner') // 'owner' | 'admin'
36:      setRole(editingUser.role === 'admin' ? 'admin' : 'owner')
41:      setRole('owner')
```

**Command**

```bash
tail -3 /tmp/pg_install.log; ls /usr/lib/postgresql/*/bin/postgres 2>/dev/null
```

**Output**

```text
exit code 2
```

**Command**

```bash
cat /tmp/pg_install.log | head; (apt-get install -y -qq postgresql 2>&1 | tail -5); ls /usr/lib/postgresql/*/bin/postgres 2>/dev/null
```

**Output**

```text
E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/g/glibc/locales_2.39-0ubuntu8.7_all.deb  404  Not Found [IP: 185.125.190.81 80]
E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/p/postgresql-16/libpq5_16.13-0ubuntu0.24.04.1_amd64.deb  404  Not Found [IP: 185.125.190.81 80]
E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/p/postgresql-16/postgresql-client-16_16.13-0ubuntu0.24.04.1_amd64.deb  404  Not Found [IP: 185.125.190.81 80]
E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/p/postgresql-16/postgresql-16_16.13-0ubuntu0.24.04.1_amd64.deb  404  Not Found [IP: 185.125.190.81 80]
E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?
```

**Command**

```bash
(apt-get update -qq 2>&1 | tail -2; apt-get install -y -qq postgresql 2>&1 | tail -3); ls /usr/lib/postgresql/*/bin/postgres 2>/dev/null
```

**Output**

```text
W: Failed to fetch https://deb.nodesource.com/node_22.x/dists/nodistro/InRelease  Could not resolve 'deb.nodesource.com'
W: Some index files failed to download. They have been ignored, or old ones used instead.
invoke-rc.d: policy-rc.d denied execution of start.
Setting up postgresql (16+257build1.1) ...
Processing triggers for libc-bin (2.39-0ubuntu8.9) ...
/usr/lib/postgresql/16/bin/postgres
```

**Command**

```bash
set -e
PGBIN=/usr/lib/postgresql/16/bin
rm -rf /tmp/pgdata && mkdir /tmp/pgdata && chown postgres /tmp/pgdata
su postgres -c "$PGBIN/initdb -D /tmp/pgdata -A trust >/dev/null && $PGBIN/pg_ctl -D /tmp/pgdata -o '-p 5544 -k /tmp' -l /tmp/pg.log start >/dev/null"
sleep 2
cat > /tmp/shim.sql <<'EOF'
create role anon; create role authenticated;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function public.rls_auto_enable() returns void language sql as $$ select 1 $$;
create extension if not exists pgcrypto;
create publication supabase_realtime;
EOF
P="psql -h /tmp -p 5544 -U postgres -v ON_ERROR_STOP=1 -q"
su postgres -c "$P -c 'create database t'" 
su postgres -c "$P -d t -f /tmp/shim.sql"
cd /home/claude/MeemX-ERP/supabase
for f in schema.sql migrations/20261019_exact_owner_dashboard_and_tally_import.sql migrations/20261028101522_sync_ledger_category_and_restrict_rls_auto_enable.sql migrations/20261028102022_add_sync_soft_delete_timestamps.sql migrations/20261028103230_optimize_rls_policies_and_fk_indexes.sql migrations/20261029120000_tally_snapshot_refresh.sql migrations/20261031120000_live_sync_signed_balances_reconcile.sql; do
  echo "== $f"; su postgres -c "$P -d t -f /home/claude/MeemX-ERP/supabase/$f" 2>&1 | grep -v "NOTICE" | head -5
done; echo ALL_APPLIED
```

**Output**

```text
== schema.sql
== migrations/20261019_exact_owner_dashboard_and_tally_import.sql
== migrations/20261028101522_sync_ledger_category_and_restrict_rls_auto_enable.sql
== migrations/20261028102022_add_sync_soft_delete_timestamps.sql
== migrations/20261028103230_optimize_rls_policies_and_fk_indexes.sql
psql:/home/claude/MeemX-ERP/supabase/migrations/20261028103230_optimize_rls_policies_and_fk_indexes.sql:8: ERROR:  policy "Profiles: Admin inserts profiles" for table "profiles" already exists
== migrations/20261029120000_tally_snapshot_refresh.sql
== migrations/20261031120000_live_sync_signed_balances_reconcile.sql
ALL_APPLIED

```
