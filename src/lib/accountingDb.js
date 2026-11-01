import Dexie from 'dexie'

/**
 * Tally SaaS Accounting Database (Dexie IndexedDB Engine)
 * Handles:
 * - Pure Material-wise Inventory
 * - Full Voucher Management (Sales, Purchase, Payment, Receipt, Contra, Journal)
 * - Tally Modification Engine (Editable vouchers with balance recomputation)
 * - Permanent UID generator and circulation for Debtors with closing dues
 * - Chart of Accounts (Cash, Bank, Loans, Debtors, Creditors, Expenses, Incomes)
 * - App Settings & Owner Visibility Controls
 */

export const accDb = new Dexie('TallySaasAccounting')

accDb.version(2).stores({
  vouchers: '++id, voucher_no, voucher_type, date, party_id, party_name, party_uid, amount, due_amount, createdAt',
  materials: '++id, sku, name, category, unit, current_qty, purchase_rate, sales_rate, reorder_threshold',
  parties: '++id, name, type, uid, phone, current_balance, age_bucket, next_payment, due_days',
  ledgers: '++id, name, group, current_balance, category',
  settings: 'key, value',
  imports: '++id, filename, date, added_count, skipped_count, status, problems_count',
})

accDb.version(3).stores({
  vouchers: '++id, voucher_no, voucher_type, date, party_id, party_name, party_uid, amount, due_amount, createdAt',
  materials: '++id, sku, name, category, unit, current_qty, purchase_rate, sales_rate, reorder_threshold',
  parties: '++id, name, type, uid, phone, current_balance, age_bucket, next_payment, due_days',
  ledgers: '++id, name, group, current_balance, category',
  settings: 'key, value',
  imports: '++id, filename, date, added_count, skipped_count, status, problems_count',
})

let applyingRemoteSnapshot = false
export function setApplyingRemoteSnapshot(value) {
  applyingRemoteSnapshot = value
}

function notifyLocalDataChanged() {
  if (!applyingRemoteSnapshot && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('accounting-local-data-changed'))
  }
}

for (const tableName of ['vouchers', 'materials', 'parties', 'ledgers']) {
  const table = accDb.table(tableName)
  table.hook('creating', (_key, record) => {
    if (!applyingRemoteSnapshot) {
      record.local_dirty = true
      record.local_revision = (Number(record.local_revision) || 0) + 1
      notifyLocalDataChanged()
    }
  })
  table.hook('updating', (changes, _key, original) => {
    if (applyingRemoteSnapshot) return changes
    notifyLocalDataChanged()
    return {
      ...changes,
      local_dirty: true,
      local_revision: (Number(original?.local_revision) || 0) + 1,
      updatedAt: new Date().toISOString(),
    }
  })
  table.hook('deleting', () => notifyLocalDataChanged())
}

// Generate Next Debtor Permanent UID: UID-CUST-1001, UID-CUST-1002, etc.
export async function generateNextDebtorUid(database = accDb) {
  const existingParties = await database.parties.toArray()
  const uidNums = existingParties
    .map((p) => {
      if (!p.uid) return 0
      const match = p.uid.match(/UID-CUST-(\d+)/)
      return match ? parseInt(match[1], 10) : 0
    })
    .filter((n) => !isNaN(n))

  const maxNum = uidNums.length > 0 ? Math.max(...uidNums) : 1000
  const nextNum = Math.max(maxNum + 1, 1001)
  return `UID-CUST-${nextNum}`
}

/**
 * Resolve or Assign Customer Permanent UID:
 * Every invoice with a closing due balance gets UID permanently circulated.
 */
export async function resolvePartyUidOnSale(partyName, dueAmount, phone = '', database = accDb) {
  if (!partyName || !partyName.trim()) {
    return { party: null, uid: null }
  }

  const cleanName = partyName.trim()
  const isCash = cleanName.toLowerCase() === 'cash' || cleanName.toLowerCase() === 'counter cash'

  const allParties = await database.parties.toArray()
  let party = allParties.find(
    (p) => p.name.trim().toLowerCase() === cleanName.toLowerCase() && p.type === 'debtor'
  )

  const hasDue = Number(dueAmount) > 0

  if (party) {
    if (party.uid) {
      return { party, uid: party.uid }
    }
    if (hasDue) {
      const newUid = await generateNextDebtorUid(database)
      await database.parties.update(party.id, { uid: newUid })
      party.uid = newUid
      return { party, uid: newUid }
    }
    return { party, uid: null }
  }

  if (isCash && !hasDue) {
    return { party: null, uid: null }
  }

  let assignedUid = null
  if (hasDue) {
    assignedUid = await generateNextDebtorUid(database)
  }

  const newPartyId = await database.parties.add({
    name: cleanName,
    type: 'debtor',
    uid: assignedUid,
    phone: phone || '',
    email: '',
    address: '',
    opening_balance: 0,
    // 0, not dueAmount: applyVoucherEffects adds the invoice's due amount to the party right
    // after this. Seeding it here as well doubled the first credit sale to every new customer.
    current_balance: 0,
    age_bucket: '0–30d',
    created_at: new Date().toISOString(),
  })

  const createdParty = await database.parties.get(newPartyId)
  return { party: createdParty, uid: assignedUid }
}

const BANK_MODE = /bank|hdfc|sbi|icici|axis|kotak|neft|rtgs|imps|upi|cheque|card|online|gpay|phonepe|paytm/i

/**
 * Pick the cash/bank ledger a payment mode refers to. A ledger named exactly like the mode wins
 * ("SBI" → the SBI ledger); otherwise the first ledger of the right kind. Every function used to
 * pick the first bank ledger regardless of the mode, and each had a different idea of what "bank" meant.
 */
export async function findCashBankLedger(database, paymentMode) {
  const mode = String(paymentMode || 'Cash').trim()
  const isBank = BANK_MODE.test(mode)
  const named = await database.ledgers.where('name').equalsIgnoreCase(mode).first()
  if (named && ['Bank Accounts', 'Cash-in-hand'].includes(named.group)) return named
  return (await database.ledgers.where('group').equals(isBank ? 'Bank Accounts' : 'Cash-in-hand').first()) || null
}

/**
 * Apply Voucher Balance and Inventory Effects
 */
async function applyVoucherEffects(voucher, isReversal = false, database = accDb) {
  if (voucher.source_system === 'tally') return

  const multiplier = isReversal ? -1 : 1
  const amount = Number(voucher.amount) || 0
  const paidAmount = Number(voucher.paid_amount) || 0
  const dueAmount = Number(voucher.due_amount) || 0

  // 1. Inventory Movements
  if (voucher.source_system !== 'tally' && Array.isArray(voucher.items) && voucher.items.length > 0) {
    for (const item of voucher.items) {
      const itemQty = Number(item.qty) || 0
      if (!itemQty) continue

      let material = null
      if (item.material_id) {
        material = await database.materials.get(item.material_id)
      }
      if (!material && item.sku) {
        material = await database.materials.where('sku').equalsIgnoreCase(item.sku).first()
      }
      if (!material && item.name) {
        material = await database.materials.where('name').equalsIgnoreCase(item.name).first()
      }

      if (material) {
        let qtyChange = 0
        if (voucher.voucher_type === 'sales') {
          qtyChange = -itemQty * multiplier
        } else if (voucher.voucher_type === 'purchase') {
          qtyChange = itemQty * multiplier
        }

        // No clamp at 0: Tally allows negative stock, and clamping makes a later reversal
        // (delete/edit) add back more than was ever removed, inflating stock.
        const newQty = (Number(material.current_qty) || 0) + qtyChange
        const stockChanges = { current_qty: newQty }
        if (material.current_value != null) {
          stockChanges.current_value = newQty * (Number(material.purchase_rate) || 0)
        }
        await database.materials.update(material.id, stockChanges)
      }
    }
  }

  // 2. Party Balances
  if (voucher.party_name && voucher.party_name.trim().toLowerCase() !== 'cash') {
    let party = null
    if (voucher.party_id) {
      party = await database.parties.get(voucher.party_id)
    } else {
      party = await database.parties.where('name').equalsIgnoreCase(voucher.party_name.trim()).first()
    }

    if (party) {
      let balanceChange = 0
      if (party.type === 'debtor') {
        if (voucher.voucher_type === 'sales') {
          balanceChange = dueAmount * multiplier
        } else if (voucher.voucher_type === 'receipt') {
          balanceChange = -amount * multiplier
        }
      } else if (party.type === 'creditor') {
        if (voucher.voucher_type === 'purchase') {
          balanceChange = dueAmount * multiplier
        } else if (voucher.voucher_type === 'payment') {
          balanceChange = -amount * multiplier
        }
      }

      const newBalance = (Number(party.current_balance) || 0) + balanceChange
      await database.parties.update(party.id, { current_balance: newBalance })
    }
  }

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

/**
 * Create a voucher mutation boundary that can be exercised against an isolated
 * database in tests while the app uses the production Dexie instance.
 */
export function createVoucherMutationService({
  database = accDb,
  now = () => new Date(),
  applyEffects = (voucher, isReversal) => applyVoucherEffects(voucher, isReversal, database),
  resolvePartyUid = (name, due, phone) => resolvePartyUidOnSale(name, due, phone, database),
} = {}) {
  async function createVoucher(voucherData) {
    return database.transaction('rw', [database.vouchers, database.materials, database.parties, database.ledgers], async () => {
      let assignedUid = voucherData.party_uid || null
      if (voucherData.voucher_type === 'sales') {
        const { uid } = await resolvePartyUid(voucherData.party_name, voucherData.due_amount, voucherData.phone || '')
        assignedUid = uid || assignedUid
      }

      const timestamp = now().toISOString()
      const newVoucher = {
        ...voucherData,
        party_uid: assignedUid,
        amount: Number(voucherData.amount) || 0,
        paid_amount: Number(voucherData.paid_amount) || 0,
        due_amount: Number(voucherData.due_amount) || 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }

      const voucherId = await database.vouchers.add(newVoucher)
      newVoucher.id = voucherId
      await applyEffects(newVoucher, false)
      return newVoucher
    })
  }

  async function updateVoucher(voucherId, updatedData) {
    return database.transaction('rw', [database.vouchers, database.materials, database.parties, database.ledgers], async () => {
      const existing = await database.vouchers.get(voucherId)
      if (!existing) throw new Error(`Voucher with ID ${voucherId} does not exist`)

      await applyEffects(existing, true)

      const nextData = { ...existing, ...updatedData }
      let assignedUid = nextData.party_uid || null
      if (nextData.voucher_type === 'sales') {
        const { uid } = await resolvePartyUid(nextData.party_name, nextData.due_amount, nextData.phone || '')
        assignedUid = uid || assignedUid
      }

      const merged = {
        ...nextData,
        party_uid: assignedUid,
        amount: Number(nextData.amount) || 0,
        paid_amount: Number(nextData.paid_amount) || 0,
        due_amount: updatedData.amount !== undefined || updatedData.paid_amount !== undefined
          ? Math.max(0, (Number(nextData.amount) || 0) - (Number(nextData.paid_amount) || 0))
          : Number(nextData.due_amount) || 0,
        updatedAt: now().toISOString(),
      }
      if (updatedData.amount !== undefined || updatedData.paid_amount !== undefined) {
        merged.status = merged.due_amount <= 0 ? 'Paid' : 'Due'
      }

      await database.vouchers.put(merged)
      await applyEffects(merged, false)
      return merged
    })
  }

  async function deleteVoucher(voucherId) {
    return database.transaction('rw', [database.vouchers, database.materials, database.parties, database.ledgers, database.settings], async () => {
      const existing = await database.vouchers.get(voucherId)
      if (!existing) return
      await applyEffects(existing, true)
      if (existing.cloud_id) {
        const setting = await database.settings.get('pending_cloud_deletes')
        const pending = setting?.value ? JSON.parse(setting.value) : []
        if (!pending.some((item) => item.table === 'vouchers' && item.cloud_id === existing.cloud_id)) {
          pending.push({ table: 'vouchers', cloud_id: existing.cloud_id })
        }
        await database.settings.put({ key: 'pending_cloud_deletes', value: JSON.stringify(pending) })
      }
      await database.vouchers.delete(voucherId)
    })
  }

  return { createVoucher, updateVoucher, deleteVoucher }
}

const voucherMutationService = createVoucherMutationService()

export const createVoucher = (voucherData) => voucherMutationService.createVoucher(voucherData)
export const updateVoucher = (voucherId, updatedData) => voucherMutationService.updateVoucher(voucherId, updatedData)
export const deleteVoucher = (voucherId) => voucherMutationService.deleteVoucher(voucherId)

/**
 * -------------------------------------------------------------
 * Creditors (Suppliers) Functions
 * -------------------------------------------------------------
 */
export async function createCreditor({
  name,
  phone = '',
  current_balance = 0,
  next_payment = 'Next month',
  due_days = 14,
  due_status = null,
}) {
  const balance = Number(current_balance) || 0
  const days = Number(due_days) || 14
  const status = due_status || (days <= 1 ? 'Due in 1d' : `Due in ${days}d`)
  const bucket = days <= 1 ? 'Due now' : days <= 15 ? 'Next 15d' : 'Later'

  const id = await accDb.parties.add({
    name: name.trim(),
    type: 'creditor',
    uid: null,
    phone: phone.trim(),
    next_payment,
    due_status: status,
    due_days: days,
    current_balance: balance,
    due_bucket: bucket,
    created_at: new Date().toISOString(),
  })
  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.parties.get(id)
}

export async function recordSupplierPayment({
  supplierId,
  supplierName,
  amount,
  paymentMode = 'Cash',
  date = null,
  narration = '',
}) {
  const payAmt = Number(amount) || 0
  if (payAmt <= 0) throw new Error('Payment amount must be greater than 0')

  return await accDb.transaction('rw', [accDb.parties, accDb.vouchers, accDb.ledgers], async () => {
    let supplier = null
    if (supplierId) {
      supplier = await accDb.parties.get(supplierId)
    } else if (supplierName) {
      supplier = await accDb.parties.where('name').equalsIgnoreCase(supplierName.trim()).first()
    }

    if (supplier) {
      const newBal = (Number(supplier.current_balance) || 0) - payAmt
      await accDb.parties.update(supplier.id, { current_balance: newBal })
    }

    const voucher = {
      voucher_no: `PAY-${Date.now().toString().slice(-4)}`,
      voucher_type: 'payment',
      date: date || new Date().toISOString().slice(0, 10),
      party_name: supplier?.name || supplierName || 'Supplier',
      party_id: supplier?.id || null,
      amount: payAmt,
      paid_amount: payAmt,
      due_amount: 0,
      payment_mode: paymentMode,
      status: 'Paid',
      narration: narration.trim() || `Payment to ${supplier?.name || supplierName || 'supplier'} via ${paymentMode}`,
      items: [],
      createdAt: new Date().toISOString(),
    }
    await accDb.vouchers.add(voucher)

    const ledger = await findCashBankLedger(accDb, paymentMode)
    if (ledger) {
      const newLedgerBal = (Number(ledger.current_balance) || 0) - payAmt
      await accDb.ledgers.update(ledger.id, { current_balance: newLedgerBal })
    }

    window.dispatchEvent(new Event('accounting-data-updated'))
    return voucher
  })
}

/**
 * -------------------------------------------------------------
 * Debtors (Customers) Functions
 * -------------------------------------------------------------
 */
export async function createDebtor({
  name,
  phone = '',
  current_balance = 0,
  due_days = 15,
}) {
  const balance = Number(current_balance) || 0
  const days = Number(due_days) || 15
  const uid = await generateNextDebtorUid()
  const age_bucket = days > 60 ? '60d+' : days > 30 ? '31–60d' : '0–30d'

  const id = await accDb.parties.add({
    name: name.trim(),
    type: 'debtor',
    uid,
    phone: phone.trim(),
    last_invoice: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }),
    due_days: days,
    current_balance: balance,
    age_bucket,
    created_at: new Date().toISOString(),
  })
  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.parties.get(id)
}

export async function recordDebtorReceipt({
  debtorId,
  debtorName,
  amount,
  paymentMode = 'Cash',
  date = null,
  narration = '',
}) {
  const recAmt = Number(amount) || 0
  if (recAmt <= 0) throw new Error('Receipt collection amount must be greater than 0')

  return await accDb.transaction('rw', [accDb.parties, accDb.vouchers, accDb.ledgers], async () => {
    let debtor = null
    if (debtorId) {
      debtor = await accDb.parties.get(debtorId)
    } else if (debtorName) {
      debtor = await accDb.parties.where('name').equalsIgnoreCase(debtorName.trim()).first()
    }

    if (debtor) {
      const newBal = (Number(debtor.current_balance) || 0) - recAmt
      const newBucket = newBal <= 0 ? 'Settled' : debtor.age_bucket
      await accDb.parties.update(debtor.id, { current_balance: newBal, age_bucket: newBucket })
    }

    const voucher = {
      voucher_no: `REC-${Date.now().toString().slice(-4)}`,
      voucher_type: 'receipt',
      date: date || new Date().toISOString().slice(0, 10),
      party_name: debtor?.name || debtorName || 'Customer',
      party_uid: debtor?.uid || null,
      party_id: debtor?.id || null,
      amount: recAmt,
      paid_amount: recAmt,
      due_amount: 0,
      payment_mode: paymentMode,
      status: 'Paid',
      narration: narration.trim() || `Payment received from ${debtor?.name || debtorName} via ${paymentMode}`,
      items: [],
      createdAt: new Date().toISOString(),
    }
    await accDb.vouchers.add(voucher)

    const ledger = await findCashBankLedger(accDb, paymentMode)
    if (ledger) {
      const newLedgerBal = (Number(ledger.current_balance) || 0) + recAmt
      await accDb.ledgers.update(ledger.id, { current_balance: newLedgerBal })
    }

    window.dispatchEvent(new Event('accounting-data-updated'))
    return voucher
  })
}

/**
 * -------------------------------------------------------------
 * Inventory Products Functions
 * -------------------------------------------------------------
 */
export async function createStockItem({
  name,
  sku = '',
  category = 'Cases & Covers',
  unit = 'pcs',
  purchase_rate = 0,
  sales_rate = undefined,
  current_qty = 0,
  current_value = null,
  reorder_threshold = 10,
}) {
  const pRate = Number(purchase_rate) || 0
  const sRate = sales_rate === undefined ? Math.round(pRate * 1.3) : Number(sales_rate) || 0
  const qty = Number(current_qty) || 0
  const threshold = Number(reorder_threshold) || 10
  const autoSku = sku?.trim() || `SKU-${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`

  const id = await accDb.materials.add({
    name: name.trim(),
    sku: autoSku,
    category: category || 'Cases & Accessories',
    unit: unit || 'pcs',
    purchase_rate: pRate,
    sales_rate: sRate,
    current_qty: qty,
    ...(current_value != null ? { current_value: Number(current_value) || 0 } : {}),
    reorder_threshold: threshold,
    status: qty <= 0 ? 'Out of stock' : qty <= threshold ? 'Low' : 'Healthy',
    created_at: new Date().toISOString(),
  })
  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.materials.get(id)
}

export async function updateStockQty(id, newQty) {
  const item = await accDb.materials.get(id)
  if (!item) return
  const qty = Math.max(0, Number(newQty) || 0)
  const status = qty <= 0 ? 'Out of stock' : qty <= (item.reorder_threshold || 10) ? 'Low' : 'Healthy'
  await accDb.materials.update(id, {
    current_qty: qty,
    status,
    ...(item.current_value != null ? { current_value: qty * (Number(item.purchase_rate) || 0) } : {}),
  })
  window.dispatchEvent(new Event('accounting-data-updated'))
}

/**
 * -------------------------------------------------------------
 * Expenses Functions
 * -------------------------------------------------------------
 */
export async function recordExpenseVoucher({
  category = 'Transport',
  amount = 0,
  paymentMode = 'Cash',
  date = null,
  narration = '',
}) {
  const expAmt = Number(amount) || 0
  if (expAmt <= 0) throw new Error('Expense amount must be greater than 0')

  return await accDb.transaction('rw', [accDb.vouchers, accDb.ledgers], async () => {
    const voucher = {
      voucher_no: `EXP-${Date.now().toString().slice(-4)}`,
      voucher_type: 'payment',
      date: date || new Date().toISOString().slice(0, 10),
      party_name: category || 'General Expense',
      amount: expAmt,
      paid_amount: expAmt,
      due_amount: 0,
      payment_mode: paymentMode,
      status: 'Paid',
      narration: narration.trim() || `Expense under ${category} paid via ${paymentMode}`,
      items: [],
      createdAt: new Date().toISOString(),
    }
    await accDb.vouchers.add(voucher)

    const ledger = await findCashBankLedger(accDb, paymentMode)
    if (ledger) {
      const newLedgerBal = (Number(ledger.current_balance) || 0) - expAmt
      await accDb.ledgers.update(ledger.id, { current_balance: newLedgerBal })
    }

    let expLedger = await accDb.ledgers.where('name').equalsIgnoreCase(category).first()
    if (expLedger) {
      await accDb.ledgers.update(expLedger.id, { current_balance: (Number(expLedger.current_balance) || 0) + expAmt })
    } else {
      await accDb.ledgers.add({
        name: category,
        group: 'Indirect Expenses',
        category: 'expense',
        current_balance: expAmt,
      })
    }

    window.dispatchEvent(new Event('accounting-data-updated'))
    return voucher
  })
}

/**
 * -------------------------------------------------------------
 * Loans & Advances Functions
 * -------------------------------------------------------------
 */
export async function recordLoanEntry({
  type = 'loan', // 'loan' (we owe) | 'advance' (given)
  name = '',
  amount = 0,
  note = '',
  dueDate = '',
  emi = '',
}) {
  const amt = Number(amount) || 0
  if (amt <= 0) throw new Error('Amount must be greater than 0')
  const isLoanWeOwe = type === 'loan'
  const group = isLoanWeOwe ? 'Loans (Liability)' : 'Loans & Advances (Asset)'
  const category = isLoanWeOwe ? 'liability' : 'asset'
  const finalNote = note.trim() || (emi ? `EMI ₹${emi} due ${dueDate || 'next month'}` : dueDate ? `Repay by ${dueDate}` : '')

  const id = await accDb.ledgers.add({
    name: name.trim(),
    group,
    category,
    current_balance: amt,
    note: finalNote,
  })
  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.ledgers.get(id)
}

/**
 * -------------------------------------------------------------
 * Universal Admin Update & Delete Functions
 * -------------------------------------------------------------
 */

export async function updatePartyRecord(id, updates) {
  const party = await accDb.parties.get(Number(id))
  if (!party) throw new Error('Party not found')

  const cleanUpdates = { ...updates }
  if (cleanUpdates.current_balance !== undefined) {
    cleanUpdates.current_balance = Number(cleanUpdates.current_balance) || 0
  }
  if (cleanUpdates.credit_limit !== undefined) {
    cleanUpdates.credit_limit = Number(cleanUpdates.credit_limit) || 0
  }
  if (cleanUpdates.due_days !== undefined) {
    cleanUpdates.due_days = Number(cleanUpdates.due_days) || 0
  }

  await accDb.parties.update(party.id, cleanUpdates)
  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.parties.get(party.id)
}

export async function updateMaterialRecord(id, updates) {
  const material = await accDb.materials.get(Number(id))
  if (!material) throw new Error('Material not found')

  const cleanUpdates = { ...updates }
  if (cleanUpdates.current_qty !== undefined) {
    cleanUpdates.current_qty = Math.max(0, Number(cleanUpdates.current_qty) || 0)
  }
  if (cleanUpdates.purchase_rate !== undefined) {
    cleanUpdates.purchase_rate = Number(cleanUpdates.purchase_rate) || 0
  }
  if (cleanUpdates.sales_rate !== undefined) {
    cleanUpdates.sales_rate = Number(cleanUpdates.sales_rate) || 0
  }
  if (cleanUpdates.reorder_threshold !== undefined) {
    cleanUpdates.reorder_threshold = Number(cleanUpdates.reorder_threshold) || 10
  }

  const qty = cleanUpdates.current_qty !== undefined ? cleanUpdates.current_qty : material.current_qty
  const threshold = cleanUpdates.reorder_threshold !== undefined ? cleanUpdates.reorder_threshold : (material.reorder_threshold || 10)
  cleanUpdates.status = qty <= 0 ? 'Out of stock' : qty <= threshold ? 'Low' : 'Healthy'

  await accDb.materials.update(material.id, cleanUpdates)
  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.materials.get(material.id)
}

export async function updateVoucherRecord(id, updates) {
  const voucher = await accDb.vouchers.get(Number(id))
  if (!voucher) throw new Error('Voucher not found')

  const cleanUpdates = { ...updates }
  if (cleanUpdates.amount !== undefined) {
    cleanUpdates.amount = Number(cleanUpdates.amount) || 0
  }
  if (cleanUpdates.paid_amount !== undefined) {
    cleanUpdates.paid_amount = Number(cleanUpdates.paid_amount) || 0
  }
  if (cleanUpdates.due_amount !== undefined) {
    cleanUpdates.due_amount = Number(cleanUpdates.due_amount) || 0
  }

  // Auto calculate due amount if amount or paid_amount changed
  if (cleanUpdates.amount !== undefined && cleanUpdates.paid_amount !== undefined) {
    cleanUpdates.due_amount = Math.max(0, cleanUpdates.amount - cleanUpdates.paid_amount)
    cleanUpdates.status = cleanUpdates.due_amount <= 0 ? 'Paid' : 'Due'
  }

  await updateVoucher(voucher.id, { ...voucher, ...cleanUpdates })

  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.vouchers.get(voucher.id)
}

export async function updateLedgerRecord(id, updates) {
  const ledger = await accDb.ledgers.get(Number(id))
  if (!ledger) throw new Error('Ledger not found')

  const cleanUpdates = { ...updates }
  if (cleanUpdates.current_balance !== undefined) {
    cleanUpdates.current_balance = Number(cleanUpdates.current_balance) || 0
  }

  await accDb.ledgers.update(ledger.id, cleanUpdates)
  window.dispatchEvent(new Event('accounting-data-updated'))
  return await accDb.ledgers.get(ledger.id)
}

export async function deleteDbRecord(table, id) {
  if (!accDb[table]) throw new Error(`Table ${table} does not exist`)
  if (table === 'vouchers') {
    await deleteVoucher(Number(id))
    window.dispatchEvent(new Event('accounting-data-updated'))
    return
  }
  const record = await accDb[table].get(Number(id))
  if (record?.cloud_id && ['vouchers', 'materials', 'parties', 'ledgers'].includes(table)) {
    const setting = await accDb.settings.get('pending_cloud_deletes')
    const pending = setting?.value ? JSON.parse(setting.value) : []
    if (!pending.some((item) => item.table === table && item.cloud_id === record.cloud_id)) {
      pending.push({ table, cloud_id: record.cloud_id })
    }
    await accDb.settings.put({ key: 'pending_cloud_deletes', value: JSON.stringify(pending) })
  }
  await accDb[table].delete(Number(id))
  notifyLocalDataChanged()
  window.dispatchEvent(new Event('accounting-data-updated'))
}

/**
 * Purge all sample accounting data (vouchers, inventory, parties, ledgers, imports)
 */
export async function purgeSampleData() {
  const cloudTables = ['vouchers', 'materials', 'parties', 'ledgers']
  await accDb.transaction('rw', [accDb.vouchers, accDb.materials, accDb.parties, accDb.ledgers, accDb.imports, accDb.settings], async () => {
    const setting = await accDb.settings.get('pending_cloud_deletes')
    const pending = setting?.value ? JSON.parse(setting.value) : []
    for (const tableName of cloudTables) {
      const records = await accDb.table(tableName).toArray()
      for (const record of records) {
        if (record.cloud_id && !pending.some((item) => item.table === tableName && item.cloud_id === record.cloud_id)) {
          pending.push({ table: tableName, cloud_id: record.cloud_id })
        }
      }
      await accDb.table(tableName).clear()
    }
    await accDb.imports.clear()
    await accDb.settings.put({ key: 'pending_cloud_deletes', value: JSON.stringify(pending) })
    await accDb.settings.put({ key: 'purged_sample_data', value: 'true' })
  })
  notifyLocalDataChanged()
  window.dispatchEvent(new Event('accounting-data-updated'))
}

/**
 * Initialize System Settings without any sample records
 */
export async function initDefaultAccountingData() {
  const settingsCount = await accDb.settings.count()
  if (settingsCount === 0) {
    const defaultSettings = [
      { key: 'shop_name', value: 'My Shop' },
      { key: 'invoice_footer', value: 'Thank you for your business' },
      { key: 'daily_whatsapp_summary', value: 'true' },
      { key: 'whatsapp_summary_time', value: '8:00 PM' },
      { key: 'whatsapp_language', value: 'English / বাংলা' },
      { key: 'auto_import_reminder', value: 'true' },
      { key: 'last_backup_time', value: 'today, 6:45 PM' },
      {
        key: 'owner_permissions',
        value: JSON.stringify({
          sales: true,
          profit: true,
          expenses: true,
          debtors: true,
          creditors: true,
          inventory: true,
          loans: true,
        }),
      },
      {
        key: 'card_order',
        value: JSON.stringify(['sales', 'profit', 'expenses', 'debtors', 'creditors', 'inventory', 'loans']),
      },
      { key: 'purged_sample_data', value: 'true' },
    ]
    await accDb.settings.bulkAdd(defaultSettings)
  }

  // Purge any previously seeded sample data
  const purged = await accDb.settings.get('purged_sample_data')
  if (!purged || purged.value !== 'true') {
    await purgeSampleData()
  }
}
