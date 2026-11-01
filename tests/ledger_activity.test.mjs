import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyLoanLedgers, ledgerTransactions, ledgerActivitySummary } from '../src/lib/ledgerActivity.js'

describe('loan ledger classification', () => {
  const ledgers = [
    { name: 'HDFC Term Loan', group: 'Secured Loans', primary_group: 'Loans (Liability)', category: 'liability', current_balance: 100000 },
    { name: 'Bank OD', group: 'Bank OD A/c', primary_group: 'Bank OD A/c', category: 'liability', current_balance: 20000 },
    { name: 'Staff Advance - Ravi', group: 'Staff Advances', primary_group: 'Loans & Advances (Asset)', category: 'asset', current_balance: 5000 },
    { name: 'Security Deposit', group: 'Loans & Advances (Asset)', category: 'asset', current_balance: 30000 },
    { name: 'Old Zero Ledger', group: 'Loans & Advances (Asset)', category: 'asset', current_balance: 0 },
    { name: 'GST Payable', group: 'Duties & Taxes', primary_group: 'Duties & Taxes', category: 'liability', current_balance: 9999 },
    { name: 'Rent', group: 'Indirect Expenses', category: 'expense', current_balance: 8000 },
  ]
  it('finds sub-group loans/advances, ignores unrelated and zero-balance ledgers', () => {
    const { owed, given } = classifyLoanLedgers(ledgers)
    assert.deepEqual(owed.map((l) => l.name), ['HDFC Term Loan', 'Bank OD'])
    assert.deepEqual(given.map((l) => l.name), ['Security Deposit', 'Staff Advance - Ravi'])
  })
})

describe('ledger transactions', () => {
  const vouchers = [
    { voucher_no: 'P-1', voucher_type: 'payment', date: '2026-10-03', party_name: 'Ravi', narration: 'advance', ledger_entries: [{ ledger_name: 'Staff Advance - Ravi', amount: 5000, is_debit: true }, { ledger_name: 'Cash', amount: 5000, is_debit: false }] },
    { voucher_no: 'R-1', voucher_type: 'receipt', date: '2026-10-20', party_name: 'Ravi', ledger_entries: [{ ledger_name: 'staff advance - ravi', amount: 1000, is_debit: false }] },
    { voucher_no: 'X', voucher_type: 'sales', date: '2026-10-21', party_name: 'Z', ledger_entries: [{ ledger_name: 'Sales', amount: 1, is_debit: false }] },
    { voucher_no: 'D', voucher_type: 'payment', date: '2026-10-22', party_name: 'Ravi', deleted_at: 'x', ledger_entries: [{ ledger_name: 'Staff Advance - Ravi', amount: 9, is_debit: true }] },
  ]
  it('lists the postings behind a balance, newest first, skipping deleted vouchers', () => {
    const { total, rows } = ledgerTransactions(vouchers, 'Staff Advance - Ravi')
    assert.equal(total, 2)
    assert.deepEqual(rows.map((r) => [r.voucher_no, r.amount, r.isDebit]), [['R-1', 1000, false], ['P-1', 5000, true]])
  })
  it('summarises count and last date per ledger', () => {
    assert.deepEqual(ledgerActivitySummary(vouchers).get('staff advance - ravi'), { count: 2, lastDate: '2026-10-20' })
  })
})
