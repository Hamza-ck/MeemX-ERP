import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parsePnlRows, parsePnlXml, normalizePnl, pnlPeriods, PnlError } from '../connector/pnl.mjs'

// The figures below are the real Tally ERP 9 export supplied for this project (layout: label | sub | main).
const SHEET = [
  [null, 'Farhan Enterprises', null],
  ['Particulars', '1-Apr-2026 to 31-Oct-2026', null],
  ['Trading Account  :', null, null],
  ['Sales Accounts', null, 1083591.00],
  ['Sales', 1002444, null],
  ['Shop 2', 81147, null],
  ['Cost of Sales :', null, 919996.43],
  ['Opening Stock', 1085225.46, null],
  ['Add: Purchase Accounts', 1207570, null],
  ['Less: Closing Stock', 1372799.03, null],
  ['Gross Profit :', null, 163594.57],
  ['Income Statement :', null, null],
  ['Indirect Expenses', null, 88982.00],
  ['Maintenance', 9740, null], ['Shop Rent', 11600, null], ['Staff', 18200, null], ['Brokerage', 2850, null],
  ['Daily Exp.', 4750, null], ['Delivery', null, null], ['Discount', 1342, null], ['Drawings', null, null],
  ['Electricity', 3300, null], ['Shop', 37000, null], ['Stationary', 200, null],
  ['Nett Profit :', null, 74612.57],
]

describe("Tally's own Profit & Loss", () => {
  it('reads cost of sales and profit exactly as Tally reports them', () => {
    const r = parsePnlRows(SHEET)
    assert.equal(r.company, 'Farhan Enterprises')
    assert.equal(r.period_start, '2026-04-01')
    assert.equal(r.period_end, '2026-10-31')
    assert.equal(r.sales, 1083591)
    assert.equal(r.opening_stock, 1085225.46)
    assert.equal(r.purchases, 1207570)
    assert.equal(r.closing_stock, 1372799.03)
    assert.equal(r.cogs, 919996.43)
    assert.equal(r.gross_profit, 163594.57)
    assert.equal(r.indirect_expenses, 88982)
    assert.equal(r.net_profit, 74612.57)
  })

  it('shows why purchases cannot stand in for cost: stock grew by ₹2.87L', () => {
    const r = parsePnlRows(SHEET)
    assert.ok(r.sales - r.purchases - r.indirect_expenses < 0)      // −2,12,961: wrong
    assert.equal(r.net_profit > 0, true)                            // +74,612.57: Tally's answer
  })

  it('refuses a report whose totals do not add up instead of storing a wrong profit', () => {
    const tampered = SHEET.map((row) => (row[0] === 'Less: Closing Stock' ? [row[0], 1072799.03, null] : row))
    assert.throws(() => parsePnlRows(tampered), (e) => e instanceof PnlError && /did not add up/.test(e.message))
  })

  it('needs a period in the header', () => {
    assert.throws(() => parsePnlRows(SHEET.filter((_, i) => i !== 1)), /period/)
  })

  it('a loss is negative, and income that is only sales still reconciles', () => {
    const r = normalizePnl([['Sales Accounts', null, 1000], ['Opening Stock', 500, null], ['Add: Purchase Accounts', 900, null],
      ['Less: Closing Stock', 100, null], ['Gross Loss', null, 300], ['Indirect Expenses', null, 200], ['Nett Loss', null, 500]],
      { company: 'Co', from: '2026-10-01', to: '2026-10-31' })
    assert.equal(r.cogs, 1300)
    assert.equal(r.gross_profit, -300)
    assert.equal(r.net_profit, -500)
  })

  it('computes missing totals from the parts when Tally omits a zero line (a quiet day)', () => {
    const r = normalizePnl([['Opening Stock', 1000, null], ['Less: Closing Stock', 1000, null], ['Gross Profit', null, 0], ['Nett Profit', null, 0]],
      { company: 'Co', from: '2026-11-01', to: '2026-11-01' })
    assert.equal(r.cogs, 0)
    assert.equal(r.net_profit, 0)
  })
})

describe('XML export', () => {
  const line = (name, sub, main) => `<DSPACCNAME><DSPDISPNAME>${name}</DSPDISPNAME></DSPACCNAME><PLAMT><PLSUBAMT>${sub ?? ''}</PLSUBAMT><BSMAINAMT>${main ?? ''}</BSMAINAMT></PLAMT>`
  const xml = (inner) => `<ENVELOPE>${inner}</ENVELOPE>`

  it('parses the same report from XML, whatever the sign convention', () => {
    const body = line('Sales Accounts', '', '1083591.00') + line('Opening Stock', '-1085225.46', '') + line('Purchase Accounts', '-1207570.00', '') +
      line('Closing Stock', '1372799.03', '') + line('Cost of Sales', '', '-919996.43') + line('Gross Profit', '', '163594.57') +
      line('Indirect Expenses', '', '-88982.00') + line('Nett Profit', '', '74612.57')
    const r = parsePnlXml(xml(body), { company: 'Farhan Enterprises', from: '2026-04-01', to: '2026-10-31' })
    assert.equal(r.cogs, 919996.43)
    assert.equal(r.net_profit, 74612.57)
  })

  it('decodes entities in labels and rejects empty or errored responses', () => {
    const r = parsePnlXml(xml(line('Sales Accounts', '', '100') + line('Gross Profit', '', '100') + line('Indirect Expenses', '', '10') + line('Nett Profit', '', '90')), { from: '2026-10-01', to: '2026-10-01' })
    assert.equal(r.net_profit, 90)
    assert.throws(() => parsePnlXml('<html>nope</html>', {}), /ENVELOPE/)
    assert.throws(() => parsePnlXml(xml('<STATUS>0</STATUS>'), {}), /error/)
    assert.throws(() => parsePnlXml(xml('<X/>'), {}), /no report lines/)
  })
})

describe('periods', () => {
  it('matches the dashboard windows, including a previous month that crosses a year end', () => {
    const p = Object.fromEntries(pnlPeriods(new Date(2027, 0, 10)).map((x) => [x.key, x]))
    assert.deepEqual([p.today.from, p.today.to], ['2027-01-10', '2027-01-10'])
    assert.deepEqual([p.week.from, p.week.to], ['2027-01-04', '2027-01-10'])
    assert.deepEqual([p.month.from, p.month.to], ['2027-01-01', '2027-01-10'])
    assert.deepEqual([p.lastMonth.from, p.lastMonth.to], ['2026-12-01', '2026-12-31'])
  })
})
