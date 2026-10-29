import {
  buildEntitySnapshot,
  normalizeCloudLedger,
  normalizeCloudMaterial,
  normalizeCloudParty,
  normalizeCloudVoucher,
} from './syncSnapshot.js'

const ENTITY_TABLES = new Set(['parties', 'ledgers', 'materials', 'vouchers'])
const CLOUD_PAGE_SIZE = 500

const CLOUD_ENTITIES = [
  {
    localTable: 'parties',
    cloudTable: 'parties',
    fields: ['name', 'type', 'uid', 'phone', 'email', 'address', 'opening_balance', 'current_balance'],
    normalize: normalizeCloudParty,
  },
  {
    localTable: 'ledgers',
    cloudTable: 'ledgers',
    fields: ['name', 'group', 'opening_balance', 'current_balance', 'is_system', 'category'],
    conflict: 'name',
    normalize: normalizeCloudLedger,
  },
  {
    localTable: 'materials',
    cloudTable: 'materials',
    fields: ['sku', 'name', 'category', 'unit', 'purchase_rate', 'sales_rate', 'current_qty', 'current_value', 'reorder_threshold'],
    conflict: 'sku',
    normalize: normalizeCloudMaterial,
  },
  {
    localTable: 'vouchers',
    cloudTable: 'vouchers',
    fields: ['voucher_no', 'voucher_type', 'date', 'party_name', 'party_uid', 'amount', 'paid_amount', 'due_amount', 'payment_mode', 'items', 'ledger_entries', 'narration', 'reference_no', 'source_system', 'source_company', 'source_voucher_guid', 'source_hash'],
    conflict: 'voucher_no',
    normalize: normalizeCloudVoucher,
  },
]

function parsePendingDeletes(value) {
  if (!value) return []
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Pending cloud deletions are invalid. They were kept for recovery.')
  }
  if (!Array.isArray(parsed)) throw new Error('Pending cloud deletions are invalid. They were kept for recovery.')

  return parsed.map((item) => {
    if (!ENTITY_TABLES.has(item?.table) || typeof item.cloud_id !== 'string' || !item.cloud_id.trim()) {
      throw new Error('A pending cloud deletion has an invalid target. It was kept for recovery.')
    }
    return { table: item.table, cloud_id: item.cloud_id }
  })
}

function applyPushResultsToSnapshot(cloudRows, pushResults, deleteIds, cloudTable) {
  const resultById = new Map(cloudRows.map((row) => [row.id, row]))
  for (const pushed of pushResults) {
    if (pushed.cloudTable === cloudTable) resultById.set(pushed.cloudRow.id, pushed.cloudRow)
  }
  for (const deletedId of deleteIds) resultById.delete(deletedId)
  return [...resultById.values()]
}

/**
 * Injectable sync boundary so failure and merge behavior can be tested without
 * a live Supabase session or browser IndexedDB.
 */
export function createSyncService({
  cloud,
  database,
  isConfigured = false,
  setRemoteSnapshot = () => {},
  dispatchUpdates = () => {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('accounting-data-updated'))
      window.dispatchEvent(new Event('accounting-settings-updated'))
    }
  },
  now = () => new Date(),
  logError = (...args) => console.error(...args),
}) {
  let activeSync = null
  let syncRequestedWhileActive = false

  async function ensureSupabaseAuth() {
    if (!isConfigured) return false
    try {
      const { data: { user } = {}, error } = await cloud.auth.getUser()
      return !error && Boolean(user)
    } catch (error) {
      console.warn('Supabase auth check failed:', error)
      return false
    }
  }

  async function readCloudTable(tableName) {
    const rows = []
    for (let from = 0; ; from += CLOUD_PAGE_SIZE) {
      let query = cloud.from(tableName).select('*')
      query = tableName === 'vouchers'
        ? query.order('date', { ascending: false }).order('id', { ascending: true })
        : query.order('id', { ascending: true })
      const { data, error } = await query.range(from, from + CLOUD_PAGE_SIZE - 1)
      if (error) throw new Error(`Cloud sync failed: ${tableName}: ${error.message}`)
      if (!Array.isArray(data)) throw new Error(`Cloud sync failed: ${tableName} returned an invalid snapshot.`)
      rows.push(...data)
      if (data.length < CLOUD_PAGE_SIZE) return rows
    }
  }

  async function readCloudSnapshot() {
    return Promise.all(['parties', 'ledgers', 'materials', 'vouchers'].map(readCloudTable))
  }

  async function pushLocalChanges(userId) {
    const { data: profile, error: profileError } = await cloud
      .from('profiles').select('role').eq('id', userId).maybeSingle()
    if (profileError) throw new Error(`Could not verify sync role: ${profileError.message}`)
    if (!['admin', 'owner', 'employee'].includes(profile?.role)) {
      throw new Error('Could not verify sync role for this account.')
    }
    const deleteSetting = await database.settings.get('pending_cloud_deletes')
    const pendingDeletes = parsePendingDeletes(deleteSetting?.value)
    if (profile.role !== 'admin') return { pushed: [], deleted: [], pendingDeletes }

    for (const item of pendingDeletes) {
      const { error } = await cloud.from(item.table)
        .update({ deleted_at: now().toISOString() })
        .eq('id', item.cloud_id)
      if (error) throw new Error(`Could not sync deleted ${item.table} record: ${error.message}`)
    }

    const pushed = []
    for (const entity of CLOUD_ENTITIES) {
      const table = database.table(entity.localTable)
      const dirtyRows = await table.filter((row) => row.local_dirty).toArray()
      for (const row of dirtyRows) {
        const payload = Object.fromEntries(
          entity.fields
            .map((field) => [field, row[field]])
            .filter(([, value]) => value !== undefined)
        )
        payload.deleted_at = null
        if (entity.localTable === 'vouchers' && Array.isArray(payload.items)) {
          payload.items = payload.items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'material_id')))
        }
        if (row.cloud_id) payload.id = row.cloud_id

        if (entity.localTable === 'parties' && !payload.id) {
          const { data: existingParty, error } = await cloud.from('parties')
            .select('id').eq('name', row.name).eq('type', row.type).limit(1).maybeSingle()
          if (error) throw new Error(`Could not match party during sync: ${error.message}`)
          if (existingParty) payload.id = existingParty.id
        }
        if (entity.localTable === 'vouchers' && !payload.id) {
          const { data: existingVoucher, error } = await cloud.from('vouchers')
            .select('id').eq('voucher_no', row.voucher_no).limit(1).maybeSingle()
          if (error) throw new Error(`Could not match voucher during sync: ${error.message}`)
          if (existingVoucher) payload.id = existingVoucher.id
        }

        const options = entity.conflict ? { onConflict: entity.conflict } : undefined
        const { data, error } = await cloud.from(entity.cloudTable)
          .upsert(payload, options).select('*').single()
        if (error) throw new Error(`Could not sync ${entity.cloudTable} record: ${error.message}`)
        if (!data?.id) throw new Error(`Could not sync ${entity.cloudTable} record: cloud ID was missing.`)
        pushed.push({
          localTable: entity.localTable,
          cloudTable: entity.cloudTable,
          localId: row.id,
          localRevision: Number(row.local_revision) || 0,
          cloudId: data.id,
          cloudRow: data,
        })
      }
    }

    return { pushed, deleted: pendingDeletes, pendingDeletes }
  }

  async function performCloudSync() {
    if (!isConfigured) return { success: false, error: 'Supabase URL/Key is not configured.' }

    try {
      const { data: { user } = {}, error: authError } = await cloud.auth.getUser()
      if (authError || !user) {
        return { success: false, error: 'Not authenticated with Supabase. Please sign in.' }
      }

      // Read and validate every cloud table before changing local state or pushing edits.
      const [parties, ledgers, materials, vouchers] = await readCloudSnapshot()
      const { pushed, deleted, pendingDeletes } = await pushLocalChanges(user.id)

      const cloudByTable = {
        parties: applyPushResultsToSnapshot(parties, pushed, deleted.filter((item) => item.table === 'parties').map((item) => item.cloud_id), 'parties'),
        ledgers: applyPushResultsToSnapshot(ledgers, pushed, deleted.filter((item) => item.table === 'ledgers').map((item) => item.cloud_id), 'ledgers'),
        materials: applyPushResultsToSnapshot(materials, pushed, deleted.filter((item) => item.table === 'materials').map((item) => item.cloud_id), 'materials'),
        vouchers: applyPushResultsToSnapshot(vouchers, pushed, deleted.filter((item) => item.table === 'vouchers').map((item) => item.cloud_id), 'vouchers'),
      }
      const remoteDeletedIds = new Map(CLOUD_ENTITIES.map((entity) => [
        entity.cloudTable,
        new Set([
          ...cloudByTable[entity.cloudTable].filter((row) => row.deleted_at).map((row) => row.id),
          ...deleted.filter((item) => item.table === entity.cloudTable).map((item) => item.cloud_id),
        ]),
      ]))
      const suppressedIds = new Map()
      for (const entity of ENTITY_TABLES) {
        suppressedIds.set(entity, new Set(pendingDeletes.filter((item) => item.table === entity).map((item) => item.cloud_id)))
      }

      setRemoteSnapshot(true)
      try {
        await database.transaction('rw', CLOUD_ENTITIES.map((entity) => database.table(entity.localTable)), async () => {
          for (const result of pushed) {
            const table = database.table(result.localTable)
            const current = await table.get(result.localId)
            if (!current) continue
            await table.update(result.localId, (Number(current.local_revision) || 0) === result.localRevision
              ? { cloud_id: result.cloudId, local_dirty: false }
              : { cloud_id: result.cloudId })
          }
          await Promise.all(CLOUD_ENTITIES.map(async (entity) => {
            const table = database.table(entity.localTable)
            const plan = buildEntitySnapshot(
              await table.toArray(),
              cloudByTable[entity.cloudTable],
              entity.normalize,
              suppressedIds.get(entity.cloudTable),
              remoteDeletedIds.get(entity.cloudTable),
            )
            return Promise.all([
              plan.upserts.length ? table.bulkPut(plan.upserts) : Promise.resolve(),
              plan.deleteIds.length ? table.bulkDelete(plan.deleteIds) : Promise.resolve(),
            ])
          }))
        })
      } finally {
        setRemoteSnapshot(false)
      }

      if (deleted.length) {
        await database.settings.put({ key: 'pending_cloud_deletes', value: '[]' })
      }

      const nowIso = now().toISOString()
      await database.settings.put({ key: 'last_cloud_sync', value: nowIso })
      await database.settings.put({ key: 'cloud_sync_status', value: 'synced' })
      dispatchUpdates()

      return {
        success: true,
        counts: {
          parties: cloudByTable.parties.filter((row) => !row.deleted_at).length,
          ledgers: cloudByTable.ledgers.filter((row) => !row.deleted_at).length,
          materials: cloudByTable.materials.filter((row) => !row.deleted_at).length,
          vouchers: cloudByTable.vouchers.filter((row) => !row.deleted_at).length,
        },
        lastSync: nowIso,
      }
    } catch (error) {
      logError('syncFromSupabase error:', error)
      return { success: false, error: error.message || 'Cloud sync failed.' }
    }
  }

  async function syncFromSupabase() {
    if (activeSync) {
      syncRequestedWhileActive = true
      return activeSync
    }

    let result
    do {
      syncRequestedWhileActive = false
      const currentSync = performCloudSync()
      activeSync = currentSync
      try {
        result = await currentSync
      } finally {
        if (activeSync === currentSync) activeSync = null
      }
    } while (syncRequestedWhileActive)

    return result
  }

  return { ensureSupabaseAuth, syncFromSupabase }
}
