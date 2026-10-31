/**
 * Plan a safe local/cloud merge for one Dexie table.
 *
 * Cloud IDs are stable across devices; Dexie IDs are local. Dirty and local-only
 * rows are deliberately left untouched, while clean rows deleted from cloud are
 * removed locally so remote deletions converge on the next successful sync.
 */
import { tallyLedgerCategory } from './tallyLedgerCategory.js'

export function buildEntitySnapshot(
  localRows,
  cloudRows,
  normalize,
  suppressedCloudIds = new Set(),
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

  const activeCloudRows = cloudRows.filter((row) => row?.id && !row.deleted_at)
  const upserts = []
  for (const [index, cloudRow] of activeCloudRows.entries()) {
    if (!cloudRow?.id || suppressedCloudIds.has(cloudRow.id)) continue
    let localRow = localByCloudId.get(cloudRow.id)
    if (!localRow && naturalKey) {
      const key = naturalKey(cloudRow)
      localRow = adoptableByKey.get(key)
      if (localRow) adoptableByKey.delete(key)
    }
    if (localRow?.local_dirty) continue
    upserts.push({
      ...normalize(cloudRow, index),
      ...(localRow ? { id: localRow.id } : {}),
      cloud_id: cloudRow.id,
      local_dirty: false,
    })
  }

  const deleteIds = localRows
    .filter((row) => row.cloud_id && !row.local_dirty && remoteDeletedIds.has(row.cloud_id))
    .map((row) => row.id)

  return { upserts, deleteIds }
}

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

export const normalizeCloudLedger = (ledger) => {
  const group = ledger.group || 'General'
  const categoryFromGroup = tallyLedgerCategory(ledger.primary_group || group)
  const category = ledger.category && !(ledger.category === 'asset' && categoryFromGroup !== 'asset')
    ? ledger.category
    : categoryFromGroup

  return {
    name: ledger.name || '',
    group,
    primary_group: ledger.primary_group || '',
    opening_balance: Number(ledger.opening_balance || 0),
    current_balance: Number(ledger.current_balance || 0),
    category,
  }
}

export const normalizeCloudMaterial = (material, index = 0) => ({
  sku: material.sku || `SKU-${index + 1}`,
  name: material.name || '',
  category: material.category || 'General',
  unit: material.unit || 'pcs',
  current_qty: Number(material.current_qty || 0),
  current_value: material.current_value == null ? null : Number(material.current_value),
  purchase_rate: Number(material.purchase_rate || 0),
  sales_rate: Number(material.sales_rate || 0),
  reorder_threshold: Number(material.reorder_threshold || 10),
})

export const normalizeCloudVoucher = (voucher, index = 0) => ({
  voucher_no: voucher.voucher_no || `VCH-${index + 1}`,
  voucher_type: (voucher.voucher_type || 'sales').toLowerCase(),
  date: (voucher.date || '').slice(0, 10),
  party_name: voucher.party_name || 'Cash',
  party_uid: voucher.party_uid || '',
  amount: Number(voucher.amount || 0),
  paid_amount: Number(voucher.paid_amount || 0),
  due_amount: Number(voucher.due_amount || 0),
  payment_mode: voucher.payment_mode || 'Tally Import',
  narration: voucher.narration || '',
  reference_no: voucher.reference_no || '',
  // Dexie auto-increment IDs are device-local. Match inventory by SKU/name instead.
  items: Array.isArray(voucher.items)
    ? voucher.items.map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'material_id')))
    : [],
  ledger_entries: Array.isArray(voucher.ledger_entries) ? voucher.ledger_entries : [],
  source_system: voucher.source_system || '',
  source_company: voucher.source_company || '',
  source_voucher_guid: voucher.source_voucher_guid || '',
  source_hash: voucher.source_hash || '',
  createdAt: voucher.created_at || new Date().toISOString(),
})
