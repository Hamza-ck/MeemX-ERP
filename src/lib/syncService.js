import { supabase, supabaseConfigured } from './supabaseClient'
import { accDb, setApplyingRemoteSnapshot } from './accountingDb'
import { createSyncService } from './syncServiceCore.js'

const syncService = createSyncService({
  cloud: supabase,
  database: accDb,
  isConfigured: supabaseConfigured,
  setRemoteSnapshot: setApplyingRemoteSnapshot,
})

export const ensureSupabaseAuth = syncService.ensureSupabaseAuth
export const syncFromSupabase = syncService.syncFromSupabase
