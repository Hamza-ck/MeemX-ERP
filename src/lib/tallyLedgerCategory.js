const normalized = (value) => String(value || '').replace(/[\u0000-\u001f]/g, '').trim().toLowerCase()

// Keep in sync with supabase/functions/tally-import/parser.js (tests/tally_parser.test.mjs enforces parity).
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
