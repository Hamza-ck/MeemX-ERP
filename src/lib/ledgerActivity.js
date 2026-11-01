import { tallyLedgerCategory } from './tallyLedgerCategory.js'

const lc = (value) => String(value || '').trim().toLowerCase()

/**
 * Every posting a voucher made to one ledger — the "transactions" behind a ledger balance.
 * Amounts are positive; `isDebit` says which side. Tally vouchers carry their postings in
 * ledger_entries; a plain payment voucher (no postings) is matched by its party name.
 */
export function ledgerTransactions(vouchers, ledgerName, { limit = 50 } = {}) {
  const key = lc(ledgerName)
  const rows = []
  for (const v of vouchers) {
    if (v.deleted_at) continue
    let matched = false
    if (Array.isArray(v.ledger_entries) && v.ledger_entries.length) {
      for (const entry of v.ledger_entries) {
        if (lc(entry.ledger_name) !== key) continue
        matched = true
        rows.push({
          date: String(v.date || '').slice(0, 10),
          voucher_no: v.voucher_no,
          voucher_type: v.voucher_type,
          party_name: v.party_name,
          narration: v.narration || '',
          amount: Math.abs(Number(entry.amount) || 0),
          isDebit: Boolean(entry.is_debit),
        })
      }
    }
    if (!matched && lc(v.party_name) === key && (v.voucher_type === 'payment' || v.voucher_type === 'receipt')) {
      rows.push({
        date: String(v.date || '').slice(0, 10),
        voucher_no: v.voucher_no,
        voucher_type: v.voucher_type,
        party_name: v.party_name,
        narration: v.narration || '',
        amount: Number(v.amount) || 0,
        isDebit: v.voucher_type === 'payment',
      })
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || String(b.voucher_no).localeCompare(String(a.voucher_no), undefined, { numeric: true }))
  return { total: rows.length, rows: rows.slice(0, limit) }
}

/** Count and latest date of postings per ledger, in one pass (for list badges). */
export function ledgerActivitySummary(vouchers) {
  const summary = new Map()
  for (const v of vouchers) {
    if (v.deleted_at || !Array.isArray(v.ledger_entries)) continue
    const date = String(v.date || '').slice(0, 10)
    for (const entry of v.ledger_entries) {
      const key = lc(entry.ledger_name)
      if (!key) continue
      const current = summary.get(key) || { count: 0, lastDate: '' }
      current.count += 1
      if (date > current.lastDate) current.lastDate = date
      summary.set(key, current)
    }
  }
  return summary
}

const OWED_ROOT = /^(loans \(liability\)|secured loans|unsecured loans|bank od a\/c)$/
const loanish = (text) => /loan|overdraft|bank od/.test(text)

/**
 * Split ledgers into "loans you owe" and "advances you gave".
 * Uses the primary group, so a sub-group like "Staff Advances" under Loans & Advances (Asset)
 * is found (matching only the direct parent missed those and disagreed with the dashboard),
 * and drops zero-balance ledgers, which only added unexplained ₹0 rows.
 */
export function classifyLoanLedgers(ledgers) {
  const owed = []
  const given = []
  for (const l of ledgers) {
    if (l.deleted_at || !l.name) continue
    if (Math.abs(Number(l.current_balance) || 0) < 0.5) continue
    const group = lc(l.group)
    const root = lc(l.primary_group) || group
    const category = l.category && !(l.category === 'asset' && tallyLedgerCategory(root) !== 'asset') ? l.category : tallyLedgerCategory(root)
    if (root === 'loans & advances (asset)' || group === 'loans & advances (asset)') {
      given.push(l)
    } else if (category === 'liability' && (OWED_ROOT.test(root) || loanish(root) || loanish(group))) {
      owed.push(l)
    }
  }
  const byBalance = (a, b) => Math.abs(Number(b.current_balance) || 0) - Math.abs(Number(a.current_balance) || 0)
  return { owed: owed.sort(byBalance), given: given.sort(byBalance) }
}
