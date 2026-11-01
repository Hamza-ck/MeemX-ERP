import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVoucherMutationService } from '../src/lib/accountingDb.js'

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
    const service = createVoucherMutationService({ database, now: () => new Date('2026-10-28T12:00:00.000Z') })

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
    const service = createVoucherMutationService({ database })

    await assert.rejects(service.updateVoucher(1, { amount: 120 }), /simulated write failure/)
    assert.equal((await database.materials.get(9)).current_qty, 8)
    assert.equal((await database.parties.get(3)).current_balance, 60)
    assert.equal((await database.ledgers.get(5)).current_balance, 1040)
    assert.equal((await database.vouchers.get(1)).amount, 100)
  })
})

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
    const service = createVoucherMutationService({ database })
    await service.createVoucher(sale())
    const [party] = await database.parties.toArray()
    assert.equal(party.current_balance, 1000)
  })

  it('posts to the bank the payment mode names, not whichever bank ledger comes first', async () => {
    const database = empty()
    const service = createVoucherMutationService({ database })
    await service.createVoucher(sale({ party_name: 'Cash', paid_amount: 1000, due_amount: 0, payment_mode: 'SBI' }))
    assert.equal((await database.ledgers.get(2)).current_balance, 1500)
    assert.equal((await database.ledgers.get(1)).current_balance, 1000)
    await service.createVoucher(sale({ voucher_no: 'S-10', party_name: 'Cash', paid_amount: 200, due_amount: 0, payment_mode: 'UPI' }))
    assert.equal((await database.ledgers.get(1)).current_balance, 1200)   // UPI is a bank mode
  })

  it('an oversold item goes negative and deleting the sale restores the exact stock', async () => {
    const database = empty()
    const service = createVoucherMutationService({ database })
    const v = await service.createVoucher(sale({ party_name: 'Cash', paid_amount: 1000, due_amount: 0,
      items: [{ material_id: 9, sku: 'W-1', qty: 8 }] }))
    assert.equal((await database.materials.get(9)).current_qty, -3)
    await service.deleteVoucher(v.id)
    assert.equal((await database.materials.get(9)).current_qty, 5)       // was 8 with the old clamp
  })
})
