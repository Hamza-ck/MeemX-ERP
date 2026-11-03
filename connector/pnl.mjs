/**
 * connector/pnl.mjs — read Tally's own Profit & Loss (Trading Account + Income Statement).
 *
 * Tally already computes cost of goods sold the way the books require:
 *   Cost of Sales = Opening Stock + Purchases (+ Direct Expenses) − Closing Stock
 * so the app reports Tally's figures instead of rebuilding cost from item quantities.
 *
 * Two inputs produce the same record:
 *   - rows  : [label, sub-amount, main-amount] lines, as in Tally's Excel export
 *   - xml   : Tally's XML export of the report (labels are in <DSPDISPNAME>)
 *
 * Nothing is stored unless the totals reconcile (see validatePnl), so a layout this parser
 * misreads is rejected instead of silently showing a wrong profit.
 */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100

export class PnlError extends Error {}

/** "1-Apr-2026" → "2026-04-01" */
export function parseTallyDisplayDate(text) {
  const match = String(text || '').trim().match(/^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]*(\d{4})$/)
  if (!match) return ''
  const month = MONTHS.indexOf(match[2].toLowerCase()) + 1
  return month ? `${match[3]}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}` : ''
}

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(String(value).replace(/,/g, '').replace(/\s*(Dr|Cr)\.?$/i, '').trim())
  return Number.isFinite(parsed) ? Math.abs(parsed) : null   // side is carried by the label, not the sign
}

const clean = (label) => String(label ?? '')
  .replace(/[\u0000-\u001f]/g, '')
  .replace(/^\s*(add|less)\s*:\s*/i, '')
  .replace(/\s*:\s*$/, '')
  .replace(/\s+/g, ' ')
  .trim()

/**
 * Turn report lines into a normalised record. Amounts are positive; losses are negative.
 * @param {Array<[string, any, any]>} rows
 * @param {{company?: string, from?: string, to?: string}} [meta]
 */
export function normalizePnl(rows, meta = {}) {
  const record = {
    company: meta.company || '', period_start: meta.from || '', period_end: meta.to || '',
    sales: 0, direct_income: 0, opening_stock: 0, purchases: 0, direct_expenses: 0, closing_stock: 0,
    cogs_reported: null, gross_profit: null, indirect_expenses: 0, indirect_income: 0, net_profit: null,
  }
  const seen = new Set()

  for (const [rawLabel, subRaw, mainRaw] of rows) {
    const label = clean(rawLabel).toLowerCase()
    if (!label) continue
    const sub = toNumber(subRaw)
    const main = toNumber(mainRaw)
    const any = main ?? sub          // group totals sit in the main column, stock/purchase lines in the sub column
    const once = (field, value) => {
      if (value === null || seen.has(field)) return   // the first occurrence is the report's own total
      seen.add(field)
      record[field] = value
    }

    if (/^sales accounts?$/.test(label)) once('sales', any)
    else if (/^direct incomes?$/.test(label)) once('direct_income', any)
    else if (/^cost of (sales|goods sold)$/.test(label)) once('cogs_reported', any)
    else if (/^opening stock$/.test(label)) once('opening_stock', any)
    else if (/^purchase accounts?$/.test(label)) once('purchases', any)
    else if (/^direct expenses$/.test(label)) once('direct_expenses', any)
    else if (/^closing stock$/.test(label)) once('closing_stock', any)
    else if (/^gross (profit|loss)\b/.test(label)) once('gross_profit', label.includes('loss') && any !== null ? -any : any)
    else if (/^indirect expenses$/.test(label)) once('indirect_expenses', any)
    else if (/^indirect incomes?$/.test(label)) once('indirect_income', any)
    else if (/^nett? (profit|loss)\b/.test(label)) once('net_profit', label.includes('loss') && any !== null ? -any : any)
  }

  const cogs = record.cogs_reported ?? (record.opening_stock + record.purchases + record.direct_expenses - record.closing_stock)
  const gross = record.gross_profit ?? (record.sales + record.direct_income - cogs)
  const net = record.net_profit ?? (gross + record.indirect_income - record.indirect_expenses)
  const out = {
    ...record, cogs: round2(cogs), gross_profit: round2(gross), net_profit: round2(net),
    sales: round2(record.sales), direct_income: round2(record.direct_income), opening_stock: round2(record.opening_stock),
    purchases: round2(record.purchases), direct_expenses: round2(record.direct_expenses), closing_stock: round2(record.closing_stock),
    indirect_expenses: round2(record.indirect_expenses), indirect_income: round2(record.indirect_income),
    had_totals: { gross: record.gross_profit !== null, net: record.net_profit !== null, cogs: record.cogs_reported !== null },
  }
  delete out.cogs_reported
  return validatePnl(out)
}

/**
 * The report must add up. If it does not, we have misread it (or Tally returned something else),
 * and a wrong profit is worse than no profit.
 */
export function validatePnl(record, tolerance = 1.01) {
  const problems = []
  const hasTotals = record.had_totals.gross || record.had_totals.net || record.had_totals.cogs || (record.opening_stock > 0 && record.closing_stock > 0)
  if (!hasTotals) problems.push('no Gross Profit, Nett Profit, or Cost of Sales line was found')
  const cogsFromParts = record.opening_stock + record.purchases + record.direct_expenses - record.closing_stock
  if (Math.abs(cogsFromParts - record.cogs) > tolerance) {
    problems.push(`Cost of Sales ${record.cogs} ≠ opening ${record.opening_stock} + purchases ${record.purchases} + direct expenses ${record.direct_expenses} − closing ${record.closing_stock}`)
  }
  const grossCheck = record.sales + record.direct_income - record.cogs
  if (Math.abs(grossCheck - record.gross_profit) > tolerance) {
    problems.push(`Gross Profit ${record.gross_profit} ≠ sales ${record.sales} + direct income ${record.direct_income} − cost of sales ${record.cogs}`)
  }
  const netCheck = record.gross_profit + record.indirect_income - record.indirect_expenses
  if (Math.abs(netCheck - record.net_profit) > tolerance) {
    problems.push(`Nett Profit ${record.net_profit} ≠ gross ${record.gross_profit} + indirect income ${record.indirect_income} − indirect expenses ${record.indirect_expenses}`)
  }
  if (problems.length) throw new PnlError(`Profit & Loss did not add up: ${problems.join('; ')}`)
  const { had_totals: _ignored, ...clean } = record
  return clean
}

/** Rows from a worksheet exported by Tally (Excel). Period and company are read from the header. */
export function parsePnlRows(sheetRows) {
  let from = '', to = '', company = ''
  for (const row of sheetRows.slice(0, 6)) {
    for (const cell of row) {
      const range = String(cell ?? '').match(/(\d{1,2}-[A-Za-z]{3}-\d{4})\s+to\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i)
      if (range) { from = parseTallyDisplayDate(range[1]); to = parseTallyDisplayDate(range[2]) }
    }
  }
  const first = (sheetRows[0] || []).find((cell) => String(cell ?? '').trim())
  if (first) company = String(first).trim()
  if (!from || !to) throw new PnlError('Could not find the period ("1-Apr-2026 to 31-Oct-2026") in the report header.')
  const lines = sheetRows.map((row) => [row[0], row[1], row[2]])
  return normalizePnl(lines, { company, from, to })
}

const decodeEntities = (text) => String(text)
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * Tally's XML export: every line is a <DSPDISPNAME> followed by its amounts. Amount tags vary
 * between releases (…SUBAMT / …MAINAMT), so they are matched by suffix. Signs are ignored
 * because the label says which side a line is on, and validatePnl() guards the result.
 */
export function pnlRowsFromXml(xml) {
  const rows = []
  for (const part of String(xml).split(/<DSPDISPNAME[^>]*>/i).slice(1)) {
    const end = part.indexOf('<')
    const label = decodeEntities(end === -1 ? part : part.slice(0, end))
    const pick = (suffix) => part.match(new RegExp(`<\\w*${suffix}[^>]*>([^<]*)<`, 'i'))?.[1] ?? null
    rows.push([label, pick('SUBAMT'), pick('MAINAMT')])
  }
  return rows
}

export function parsePnlXml(xml, meta) {
  if (!/<ENVELOPE/i.test(xml)) throw new PnlError('Tally did not return a report (no <ENVELOPE>).')
  const status = String(xml).match(/<STATUS>\s*(\d+)\s*<\/STATUS>/i)?.[1]
  if (status === '0') throw new PnlError('Tally reported an error for the Profit & Loss request.')
  const rows = pnlRowsFromXml(xml)
  if (!rows.length) throw new PnlError('The Profit & Loss response contained no report lines.')
  return normalizePnl(rows, meta)
}

/** The windows the dashboard shows. Keys match the dashboard's period toggles. */
export function pnlPeriods(now = new Date()) {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return [
    { key: 'today', from: iso(today), to: iso(today) },
    { key: 'week', from: iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)), to: iso(today) },
    { key: 'month', from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to: iso(today) },
    { key: 'lastMonth', from: iso(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: iso(new Date(today.getFullYear(), today.getMonth(), 0)) },
  ]
}
