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
  gte() { return this }   // real Supabase supports range filters; the fake returns the snapshot as is
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
      const verdict = await this.client.onUpsert({ table: this.table, payload: this.payload, row })
      if (verdict?.error) return { data: null, error: verdict.error }
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
      dispatchUpdates() {},
      logError() {},
      now: () => new Date('2026-10-28T12:00:00.000Z'),
    })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, false)
    assert.match(result.error, /temporary outage/)
    assert.deepEqual(await database.table('parties').toArray(), [
      { id: 1, cloud_id: 'party-1', name: 'Keep me', local_dirty: false },
    ])
    assert.equal(cloud.upserts.length, 0)
    assert.equal(cloud.deletes.length, 0)
  })

  it('applies a complete snapshot, preserves offline edits, and converges remote deletions', async () => {
    const database = new MemoryDatabase({
      parties: [
        { id: 1, cloud_id: 'party-1', name: 'Old name', local_dirty: false },
        { id: 2, name: 'Device-only party', local_dirty: true },
        { id: 3, cloud_id: 'party-deleted', name: 'Deleted remotely', local_dirty: false },
        { id: 4, cloud_id: 'party-2', name: 'Local unsynced edit', local_dirty: true },
      ],
      ledgers: [],
      materials: [],
      vouchers: [],
    }, [{ key: 'pending_cloud_deletes', value: JSON.stringify([{ table: 'vouchers', cloud_id: 'voucher-pending' }]) }])
    const cloud = mockCloud({ snapshot: {
      parties: { data: [
        { id: 'party-1', name: 'Cloud name', type: 'debtor' },
        { id: 'party-2', name: 'Stale cloud name', type: 'debtor' },
        { id: 'party-3', name: 'New party', type: 'creditor' },
        { id: 'party-deleted', name: 'Deleted remotely', deleted_at: '2026-10-28T11:00:00.000Z' },
      ], error: null },
      ledgers: { data: [{ id: 'ledger-1', name: 'Rent', group: 'Indirect Expenses', current_balance: 25 }], error: null },
      materials: { data: [{ id: 'material-1', name: 'Widget' }], error: null },
      vouchers: { data: [{ id: 'voucher-pending', voucher_no: 'V1' }], error: null },
    } })
    const service = createSyncService({
      cloud,
      database,
      isConfigured: true,
      dispatchUpdates() {},
      now: () => new Date('2026-10-28T12:00:00.000Z'),
    })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, true)
    assert.equal(result.counts.parties, 3)
    assert.equal(result.counts.vouchers, 1)
    const parties = await database.table('parties').toArray()
    assert.equal(parties.find((row) => row.id === 1).name, 'Cloud name')
    assert.equal(parties.find((row) => row.id === 1).local_dirty, false)
    assert.equal(parties.find((row) => row.id === 2).name, 'Device-only party')
    assert.equal(parties.find((row) => row.id === 3), undefined)
    assert.equal(parties.find((row) => row.id === 4).name, 'Local unsynced edit')
    assert.equal((await database.table('parties').toArray()).some((row) => row.cloud_id === 'party-3'), true)
    assert.equal((await database.table('ledgers').toArray())[0].category, 'expense')
    assert.equal((await database.table('materials').toArray())[0].sku, 'SKU-1')
    assert.equal((await database.table('vouchers').toArray()).some((row) => row.cloud_id === 'voucher-pending'), false)
    assert.equal((await database.settings.get('pending_cloud_deletes')).value.includes('voucher-pending'), true)
  })

  it('uploads dirty admin rows only after a valid read and commits their cloud IDs locally', async () => {
    const database = new MemoryDatabase({
      parties: [], ledgers: [],
      materials: [{ id: 5, sku: 'W-1', name: 'Widget', current_qty: 2, local_dirty: true }],
      vouchers: [{ id: 7, voucher_no: 'S-1', voucher_type: 'sales', date: '2026-10-28', amount: 30, items: [{ material_id: 5, sku: 'W-1', qty: 1 }], local_dirty: true }],
    }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ role: 'admin', snapshot: Object.fromEntries(
      ['parties', 'ledgers', 'materials', 'vouchers'].map((table) => [table, { data: [], error: null }])
    ) })
    const service = createSyncService({ cloud, database, isConfigured: true, dispatchUpdates() {} })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, true)
    const material = (await database.table('materials').toArray())[0]
    const voucher = (await database.table('vouchers').toArray())[0]
    assert.equal(material.cloud_id, 'cloud-materials-1')
    assert.equal(material.local_dirty, false)
    assert.equal(voucher.cloud_id, 'cloud-vouchers-2')
    assert.equal(voucher.local_dirty, false)
    assert.deepEqual(cloud.upserts.find((item) => item.table === 'vouchers').payload.items, [{ sku: 'W-1', qty: 1 }])
  })

  it('matches a previously uploaded voucher by voucher number before retrying', async () => {
    const database = new MemoryDatabase({
      parties: [], ledgers: [], materials: [],
      vouchers: [{ id: 7, voucher_no: 'S-1', voucher_type: 'sales', date: '2026-10-28', amount: 30, local_dirty: true }],
    }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ role: 'admin', snapshot: {
      parties: { data: [], error: null },
      ledgers: { data: [], error: null },
      materials: { data: [], error: null },
      vouchers: { data: [{ id: 'existing-voucher-id', voucher_no: 'S-1' }], error: null },
    } })
    const service = createSyncService({ cloud, database, isConfigured: true, dispatchUpdates() {}, logError() {} })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, true)
    assert.equal(cloud.upserts.find((item) => item.table === 'vouchers').payload.id, 'existing-voucher-id')
  })

  it('soft-deletes queued cloud records and clears the queue after an administrator sync', async () => {
    const database = new MemoryDatabase(emptyTables(), [
      { key: 'pending_cloud_deletes', value: JSON.stringify([{ table: 'vouchers', cloud_id: 'voucher-delete' }]) },
    ])
    const cloud = mockCloud({ role: 'admin', snapshot: {
      parties: { data: [], error: null },
      ledgers: { data: [], error: null },
      materials: { data: [], error: null },
      vouchers: { data: [{ id: 'voucher-delete', voucher_no: 'V-1' }], error: null },
    } })
    const service = createSyncService({
      cloud,
      database,
      isConfigured: true,
      dispatchUpdates() {},
      logError() {},
      now: () => new Date('2026-10-28T12:00:00.000Z'),
    })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, true)
    assert.deepEqual(cloud.updates, [{ table: 'vouchers', payload: { deleted_at: '2026-10-28T12:00:00.000Z' } }])
    assert.equal(result.counts.vouchers, 0)
    assert.equal((await database.settings.get('pending_cloud_deletes')).value, '[]')
  })

  it('keeps dirty local edits pending when a read-only account syncs', async () => {
    const database = new MemoryDatabase({
      parties: [{ id: 1, cloud_id: 'party-1', name: 'Offline change', local_dirty: true }],
      ledgers: [], materials: [], vouchers: [],
    }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ role: 'owner', snapshot: Object.fromEntries(
      ['parties', 'ledgers', 'materials', 'vouchers'].map((table) => [table, { data: [], error: null }])
    ) })
    const service = createSyncService({ cloud, database, isConfigured: true, dispatchUpdates() {}, logError() {} })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, true)
    assert.equal(cloud.upserts.length, 0)
    assert.equal((await database.table('parties').get(1)).name, 'Offline change')
    assert.equal((await database.table('parties').get(1)).local_dirty, true)
  })

  it('keeps an edit made during an upload dirty for a follow-up sync', async () => {
    const database = new MemoryDatabase({
      parties: [], ledgers: [],
      materials: [{ id: 5, sku: 'W-1', name: 'Widget', current_qty: 2, local_dirty: true, local_revision: 1 }],
      vouchers: [],
    }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    let service
    let editedDuringFirstUpload = false
    const cloud = mockCloud({
      role: 'admin',
      onUpsert: async ({ table }) => {
        if (table === 'materials' && !editedDuringFirstUpload) {
          editedDuringFirstUpload = true
          await database.table('materials').update(5, { current_qty: 5, local_revision: 2 })
          void service.syncFromSupabase()
        }
      },
      snapshot: Object.fromEntries(
        ['parties', 'ledgers', 'materials', 'vouchers'].map((table) => [table, { data: [], error: null }])
      ),
    })
    service = createSyncService({ cloud, database, isConfigured: true, dispatchUpdates() {}, logError() {} })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, true)
    const material = await database.table('materials').get(5)
    assert.equal(material.current_qty, 5)
    assert.equal(material.cloud_id, 'cloud-materials-1')
    assert.equal(material.local_dirty, false)
    assert.deepEqual(cloud.upserts.filter((item) => item.table === 'materials').map((item) => item.payload.current_qty), [2, 5])
  })

  it('reads every page so a large cloud table is not mistaken for a complete partial snapshot', async () => {
    const database = new MemoryDatabase(emptyTables())
    const cloudParties = Array.from({ length: 501 }, (_, index) => ({
      id: `party-${index + 1}`,
      name: `Party ${index + 1}`,
      type: 'debtor',
    }))
    const cloud = mockCloud({ snapshot: {
      parties: { data: cloudParties, error: null },
      ledgers: { data: [], error: null },
      materials: { data: [], error: null },
      vouchers: { data: [], error: null },
    } })
    const service = createSyncService({ cloud, database, isConfigured: true, dispatchUpdates() {} })

    const result = await service.syncFromSupabase()
    assert.equal(result.success, true)
    assert.equal(result.counts.parties, 501)
    assert.equal((await database.table('parties').toArray()).length, 501)
  })
})

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
      shared_view_settings: { data: [{ key: 'owner_permissions', value: { sales: false, profit: false } }, { key: 'card_order', value: ['debtors', 'sales'] }], error: null },
    } })
    await build(database, cloud).syncFromSupabase()
    assert.equal((await database.settings.get('owner_permissions')).value, '{"sales":false,"profit":false}')
    assert.equal((await database.settings.get('card_order')).value, '["debtors","sales"]')
  })
})

describe("Tally's Profit & Loss reaches the device", () => {
  it('stores the rows the dashboard reads, and only changes them when they change', async () => {
    const database = new MemoryDatabase(emptyTables(), [{ key: 'pending_cloud_deletes', value: '[]' }])
    const rows = [{ company: 'Co', period_start: '2026-10-01', period_end: '2026-10-31', net_profit: 74612.57 }]
    const cloud = mockCloud({ role: 'owner', snapshot: {
      accounting_refresh_state: { data: { last_data_change_at: 'p1' }, error: null },
      parties: { data: [], error: null }, ledgers: { data: [], error: null }, materials: { data: [], error: null }, vouchers: { data: [], error: null },
      tally_pnl_periods: { data: rows, error: null },
    } })
    const service = createSyncService({ cloud, database, isConfigured: true, dispatchUpdates: () => {}, logError: () => {} })
    await service.syncFromSupabase()
    assert.deepEqual(JSON.parse((await database.settings.get('tally_pnl')).value), rows)
  })
})


describe('debtors keep following Tally', () => {
  const tallyVoucher = { id: 'v-1', voucher_no: 'Sales-1', voucher_type: 'sales', date: '2026-10-30', amount: 10, source_system: 'tally' }
  const snapshot = (partyBalance) => ({
    accounting_refresh_state: { data: { last_data_change_at: `v${partyBalance}` }, error: null },
    parties: { data: [{ id: 'p-1', name: 'Acme', type: 'debtor', phone: '', current_balance: partyBalance }], error: null },
    ledgers: { data: [], error: null }, materials: { data: [], error: null }, vouchers: { data: [tallyVoucher], error: null },
  })
  const dirtyAcme = { id: 1, cloud_id: 'p-1', name: 'Acme', type: 'debtor', phone: '111', current_balance: 999, local_dirty: true, local_revision: 1 }
  const build = (database, cloud) => createSyncService({ cloud, database, isConfigured: true, dispatchUpdates: () => {}, logError: () => {} })

  it("a browser edit must not overwrite the balance Tally wrote, but its other edits still sync", async () => {
    const database = new MemoryDatabase({ ...emptyTables(), parties: [dirtyAcme] }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ role: 'admin', snapshot: snapshot(5000) })
    await build(database, cloud).syncFromSupabase()
    const sent = cloud.upserts.find((u) => u.table === 'parties')
    assert.equal(sent.payload.phone, '111')                          // the phone edit is pushed
    assert.equal('current_balance' in sent.payload, false)           // the stale balance is not
    assert.equal(database.table('parties').rows[0].current_balance, 5000)
  })

  it('a dirty debtor still receives Tally\'s latest balance', async () => {
    const database = new MemoryDatabase({ ...emptyTables(), parties: [dirtyAcme] }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    // owner devices never push, so the dirty row used to be skipped and stay frozen
    const cloud = mockCloud({ role: 'owner', snapshot: snapshot(7300) })
    await build(database, cloud).syncFromSupabase()
    assert.equal(database.table('parties').rows[0].current_balance, 7300)
    assert.equal(database.table('parties').rows[0].phone, '111')     // the local edit is kept
  })

  it('one row the cloud rejects does not stop every other debtor from updating', async () => {
    const poison = { id: 9, voucher_no: 'LOCAL-1', voucher_type: 'sales', date: '2026-10-30', amount: 1, local_dirty: true, local_revision: 1 }
    const database = new MemoryDatabase({ ...emptyTables(), vouchers: [poison] }, [{ key: 'pending_cloud_deletes', value: '[]' }])
    const cloud = mockCloud({ role: 'admin', snapshot: snapshot(6400), onUpsert: ({ table }) => (table === 'vouchers' ? { error: { message: 'violates check constraint' } } : undefined) })
    const result = await build(database, cloud).syncFromSupabase()
    assert.equal(result.success, true)
    assert.equal(database.table('parties').rows[0].current_balance, 6400)
    assert.match(result.warnings[0], /LOCAL-1.*violates check constraint/)
  })
})
