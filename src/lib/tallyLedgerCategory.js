const normalized = (value) => String(value || '').trim().toLowerCase()

/** Map Tally's account groups to the normal balance category used by reports. */
export function tallyLedgerCategory(group) {
  const name = normalized(group)
  if (name.includes('expense') || name.includes('purchase account')) return 'expense'
  if (name.includes('income') || name.includes('sales account')) return 'income'
  if (
    name.includes('liabilit') || name.includes('creditor') || name.includes('capital') ||
    name.includes('loan') || name.includes('provision')
  ) return 'liability'
  return 'asset'
}

export function tallyPartyType(group) {
  const name = normalized(group)
  if (name.includes('debtor') || name.includes('customer')) return 'debtor'
  if (name.includes('creditor') || name.includes('supplier')) return 'creditor'
  return ''
}
