// Mounts every data page against seeded IndexedDB data and fails on any render error.
// Exists because an undefined variable in a page (Debtors) passed tests and the build, then crashed in use.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import 'fake-indexeddb/auto'
import { createServer } from 'vite'
import { pnlPeriods } from '../connector/pnl.mjs'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'localStorage', 'sessionStorage', 'HTMLElement', 'Node', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle']) {
  try { Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true }) } catch { /* already defined */ }
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
dom.window.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }

let server, React, createRoot, act, MemoryRouter, accDb, AuthProvider, ErrorBoundary

before(async () => {
  server = await createServer({ server: { middlewareMode: true, watch: null, hmr: false }, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true } })
  React = (await import('react')).default
  ;({ createRoot } = await import('react-dom/client'))
  ;({ act } = await import('react'))
  ;({ MemoryRouter } = await import('react-router-dom'))
  ;({ accDb } = await server.ssrLoadModule('/src/lib/accountingDb.js'))
  ;({ AuthProvider } = await server.ssrLoadModule('/src/context/AuthContext.jsx'))

  await accDb.settings.bulkPut([{ key: 'purged_sample_data', value: 'true' }, { key: 'pending_cloud_deletes', value: '[]' }])
  const today = new Date()
  const iso = (offset) => { const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  // Tally's Profit & Loss for every window the dashboard shows (fetched "now", so none is stale)
  await accDb.settings.put({ key: 'tally_pnl', value: JSON.stringify(pnlPeriods(today).map((p) => ({
    company: 'Co', period_start: p.from, period_end: p.to, sales: 1083591, direct_income: 0, opening_stock: 1085225.46, purchases: 1207570,
    direct_expenses: 0, closing_stock: 1372799.03, cogs: 919996.43, gross_profit: 163594.57, indirect_expenses: 88982, indirect_income: 0,
    net_profit: 74612.57, fetched_at: new Date().toISOString() }))) })
  await accDb.ledgers.bulkAdd([
    { name: 'Sales Account', group: 'Sales Accounts', primary_group: 'Sales Accounts', category: 'income', current_balance: 0, opening_balance: 0 },
    { name: 'Purchase Account', group: 'Purchase Accounts', primary_group: 'Purchase Accounts', category: 'expense', current_balance: 0, opening_balance: 0 },
    { name: 'Rent', group: 'Indirect Expenses', primary_group: 'Indirect Expenses', category: 'expense', current_balance: 0, opening_balance: 0 },
    { name: 'HDFC Term Loan', group: 'Secured Loans', primary_group: 'Loans (Liability)', category: 'liability', current_balance: 150000, opening_balance: 0 },
    { name: 'Staff Advance - Ravi', group: 'Staff Advances', primary_group: 'Loans & Advances (Asset)', category: 'asset', current_balance: 5000, opening_balance: 0 },
    { name: 'Cash', group: 'Cash-in-hand', category: 'asset', current_balance: 1000, opening_balance: 0 },
  ])
  await accDb.parties.bulkAdd([
    { name: 'Acme Traders', type: 'debtor', phone: '9876543210', current_balance: 12000, opening_balance: 0 },
    { name: 'Old Debt Co', type: 'debtor', phone: '', current_balance: 33000, opening_balance: 0 },
    { name: 'Prepaid Ltd', type: 'debtor', phone: '', current_balance: -700, opening_balance: 0 },
    { name: 'Mill', type: 'creditor', phone: '', current_balance: 40000, opening_balance: 0 },
  ])
  await accDb.materials.bulkAdd([{ sku: 'T-1', name: 'Pen', category: 'General', unit: 'pcs', current_qty: 100, current_value: 5000, purchase_rate: 50, sales_rate: 100, reorder_threshold: 10 }])
  const mk = (n, o) => ({ voucher_no: n, source_system: 'tally', items: [], ledger_entries: [], paid_amount: 0, due_amount: 0, payment_mode: 'Tally import', ...o })
  await accDb.vouchers.bulkAdd([
    mk('Sales-1', { voucher_type: 'sales', date: iso(2), party_name: 'Acme Traders', amount: 11800, due_amount: 11800, items: [{ name: 'Pen', qty: 100, rate: 100, amount: 10000 }],
      ledger_entries: [{ ledger_name: 'Acme Traders', amount: 11800, is_debit: true }, { ledger_name: 'Sales Account', amount: 10000, is_debit: false }] }),
    mk('Sales-2', { voucher_type: 'sales', date: iso(45), party_name: 'Old Debt Co', amount: 33000, due_amount: 33000, items: [{ name: 'Gadget', qty: 1, rate: 33000, amount: 33000 }] }),
    mk('Pay-1', { voucher_type: 'payment', date: iso(3), party_name: 'Rent', amount: 15000, paid_amount: 15000,
      narration: 'Shop rent', ledger_entries: [{ ledger_name: 'HDFC', amount: 15000, is_debit: false }, { ledger_name: 'Rent', amount: 15000, is_debit: true }] }),
    mk('Pay-2', { voucher_type: 'payment', date: iso(5), party_name: 'Staff Advance - Ravi', amount: 5000, paid_amount: 5000,
      ledger_entries: [{ ledger_name: 'Cash', amount: 5000, is_debit: false }, { ledger_name: 'Staff Advance - Ravi', amount: 5000, is_debit: true }] }),
  ])

  ErrorBoundary = class extends React.Component {
    constructor(p) { super(p); this.state = { error: null } }
    static getDerivedStateFromError(error) { return { error } }
    render() { return this.state.error ? React.createElement('pre', { 'data-error': String(this.state.error.stack || this.state.error) }) : this.props.children }
  }
})

after(async () => {
  await server?.close()
  accDb?.close?.()
  dom.window.close()          // stops jsdom's animation-frame timer, which otherwise keeps node alive
})

async function mount(modulePath) {
  const errors = []
  const original = console.error
  console.error = (...args) => { errors.push(args.map(String).join(' ')); }
  const Page = (await server.ssrLoadModule(modulePath)).default
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(AuthProvider, null, React.createElement(ErrorBoundary, null, React.createElement(Page)))))
  })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })   // let Dexie queries resolve
  const crashed = container.querySelector('[data-error]')?.getAttribute('data-error')
  const text = container.textContent
  await act(async () => { root.unmount() })
  console.error = original
  return { crashed, text, errors }
}

describe('pages render with real-shaped data', () => {
  for (const [name, path, expected] of [
    ['Debtors', '/src/pages/DebtorsPage.jsx', ['Acme Traders', 'Old Debt Co']],
    // opens on the (empty) current month and points at the previous month's expenses
    ['Expenses', '/src/pages/ExpensesPage.jsx', ['October', '₹15K']],
    ['Loans & Advances', '/src/pages/LoansPage.jsx', ['HDFC Term Loan', 'Staff Advance - Ravi']],
    ['Sales', '/src/pages/SalesPage.jsx', ['Sales-1']],
    ['Dashboard', '/src/pages/DashboardPage.jsx', ['Sales', 'cost of sales', 'Tally P&L']],
  ]) {
    it(`${name} renders without crashing and shows its data`, async () => {
      const { crashed, text } = await mount(path)
      assert.equal(crashed, undefined, `${name} crashed: ${crashed?.split('\n').slice(0, 3).join(' | ')}`)
      for (const needle of expected) assert.ok(text.includes(needle), `${name} should show "${needle}"`)
    })
  }
})
