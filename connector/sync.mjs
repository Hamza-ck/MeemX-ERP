#!/usr/bin/env node

/**
 * connector/sync.mjs — CLI tool for syncing TallyPrime data to MeemX ERP.
 *
 * Usage:
 *   node connector/sync.mjs discover   [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *   node connector/sync.mjs pull       --from YYYY-MM-DD [--to YYYY-MM-DD]
 *   node connector/sync.mjs incremental
 *   node connector/sync.mjs incremental --loop --every 15
 *
 * Environment / .env:
 *   TALLY_HOST, TALLY_PORT, TALLY_COMPANY (required: exact company name in Tally),
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
 */

import { parseArgs } from 'node:util'
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, redactUrl } from './config.mjs'
import { sendToTally, buildExportRequest, TallyConnectionError } from './tally_client.mjs'
import { countElements, hasData, buildPreviewPayload, monthlyChunks, extractGroupParents, splitRange, ymdToIso } from './normalize.mjs'
import { loadState, saveState, acquireLock, sha256, financialYearStart } from './state.mjs'
import { authenticate, previewAndCommit, getLastSyncDate, setLastSyncDate, upsertPnl } from './supabase_client.mjs'
import { parsePnlXml, parsePnlRows, pnlPeriods, PnlError } from './pnl.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      from:           { type: 'string' },
      to:             { type: 'string' },
      loop:           { type: 'boolean', default: false },
      every:          { type: 'string',  default: '15' },
      'allow-remote': { type: 'boolean', default: false },
      'tally-host':   { type: 'string' },
      'tally-port':   { type: 'string' },
      'tally-company':{ type: 'string' },
      file:           { type: 'string' },
      help:           { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: false,
  })

  const command = positionals[0] || ''

  if (values.help || !command) {
    printUsage()
    process.exit(0)
  }

  // Map CLI flags to config keys
  const cliFlags = {}
  if (values['tally-host'])    cliFlags.TALLY_HOST = values['tally-host']
  if (values['tally-port'])    cliFlags.TALLY_PORT = values['tally-port']
  if (values['tally-company']) cliFlags.TALLY_COMPANY = values['tally-company']
  if (values['allow-remote'])  cliFlags.allowRemote = true

  return { command, values, cliFlags }
}

function printUsage() {
  console.log(`
MeemX Tally Connector — Read-only sync from TallyPrime to MeemX ERP

Commands:
  discover     Send test requests to Tally and save raw XML responses
               to connector/samples/ for inspection. Does NOT write to database.

  pull         Full sync for a date range.
               --from YYYY-MM-DD  (required)
               --to   YYYY-MM-DD  (default: today)

  pnl          Fetch Tally's own Profit & Loss (cost of sales, gross and nett profit)
               for --from/--to (default: this month), save the raw XML to
               connector/samples/, validate that it adds up, and store it.

  pnl-import   Load a Profit & Loss exported from Tally as Excel.
               --file path/to/PandL.xls

  incremental  Sync from (last successful run - 7 days) to today; once a day also
               re-reads and reconciles the whole financial year.
               --loop             Run repeatedly until Ctrl+C
               --every N          Minutes between runs (default: 15)

Options:
  --tally-host HOST       Override TALLY_HOST (default: 127.0.0.1)
  --tally-port PORT       Override TALLY_PORT (default: 9000)
  --tally-company NAME    Company name exactly as in Tally (required)
  --allow-remote          Allow non-loopback Tally host (UNSAFE)
  -h, --help              Show this help
`)
}

function localDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// ─── Commands ────────────────────────────────────────────────────────────────

/**
 * discover — Send export requests to Tally and save raw responses.
 * Does NOT touch the database.
 */
async function cmdDiscover(config, values) {
  const today = localDateString(new Date())
  const fromDate = (values.from || today).replace(/-/g, '')
  const toDate = (values.to || today).replace(/-/g, '')

  console.log(`\n🔍 Discover: requesting masters and vouchers (${fromDate}–${toDate}) from Tally...`)
  console.log(`   Tally: ${config.tally.host}:${config.tally.port}, Company: ${config.tally.company || '(not set)'}\n`)

  const samplesDir = resolve(__dirname, 'samples')
  mkdirSync(samplesDir, { recursive: true })

  // 1. Masters (All Masters)
  console.log('📋 Requesting masters (ledgers + stock items)...')
  const mastersXml = buildExportRequest('List of Accounts', config.tally.company)
  try {
    const mastersResponse = await sendToTally(mastersXml, config.tally)
    const mastersFile = resolve(samplesDir, `discover_masters_${fromDate}.xml`)
    writeFileSync(mastersFile, mastersResponse, 'utf-8')
    const mc = countElements(mastersResponse)
    console.log(`   ✅ Saved ${mastersFile}`)
    console.log(`      Ledgers: ${mc.ledgerCount}, Stock Items: ${mc.stockCount}`)
  } catch (err) {
    console.error(`   ❌ Masters request failed: ${err.message}`)
    if (err instanceof TallyConnectionError) {
      process.exitCode = 1
      return
    }
  }

  // 1b. Stock Items
  console.log('📋 Requesting stock items...')
  const stockXml = buildExportRequest('List of Stock Items', config.tally.company)
  try {
    const stockResponse = await sendToTally(stockXml, config.tally)
    const stockFile = resolve(samplesDir, `discover_stock_${fromDate}.xml`)
    writeFileSync(stockFile, stockResponse, 'utf-8')
    const sc = countElements(stockResponse)
    console.log(`   ✅ Saved ${stockFile}`)
    console.log(`      Stock Items: ${sc.stockCount}`)
  } catch (err) {
    console.error(`   ❌ Stock items request failed: ${err.message}`)
  }

  // 1c. Stock Summary contains Tally's current closing quantity, rate, and value.
  console.log('📋 Requesting stock summary values...')
  try {
    const stockSummaryXml = buildExportRequest('Stock Summary', config.tally.company)
    const stockSummaryResponse = await sendToTally(stockSummaryXml, config.tally)
    const stockSummaryFile = resolve(samplesDir, `discover_stock_summary_${fromDate}.xml`)
    writeFileSync(stockSummaryFile, stockSummaryResponse, 'utf-8')
    const summaryCount = countElements(stockSummaryResponse).stockSummaryCount
    console.log(`   ✅ Saved ${stockSummaryFile} (${summaryCount} item balance rows)`)
  } catch (err) {
    console.error(`   ❌ Stock summary request failed: ${err.message}`)
  }

  // 2. Vouchers (Day Book for date range)
  console.log('📋 Requesting date-filtered vouchers...')
  const vouchersXml = buildExportRequest('Day Book', config.tally.company, { fromDate, toDate })
  try {
    const vouchersResponse = await sendToTally(vouchersXml, config.tally)
    const vouchersFile = resolve(samplesDir, `discover_vouchers_${fromDate}_${toDate}.xml`)
    writeFileSync(vouchersFile, vouchersResponse, 'utf-8')
    const vc = countElements(vouchersResponse)
    console.log(`   ✅ Saved ${vouchersFile}`)
    console.log(`      Vouchers: ${vc.voucherCount}, Ledgers: ${vc.ledgerCount}, Stock Items: ${vc.stockCount}`)
  } catch (err) {
    console.error(`   ❌ Vouchers request failed: ${err.message}`)
  }

  console.log('\n✅ Discover complete. Raw XML saved to connector/samples/')
  console.log('   Inspect the files and send them to me if you need help with normalization.\n')
}

// Large vouchers collections are split by date until each upload is small enough for the
// edge function (base64 length). A busy month used to exceed the limit and silently never sync.
const MAX_PAYLOAD_B64 = 4_000_000

const num = (value) => Number(value) || 0
const stamp = (result) => ({
  ins: num(result.commit?.inserted), upd: num(result.commit?.updated),
  skip: num(result.commit?.skipped), del: num(result.commit?.deleted),
})

/**
 * Push one Tally export (masters / stock / stock summary) unless it is identical to the
 * last successfully pushed copy. Returns 'ok' | 'unchanged' | 'empty' | throws.
 */
async function pushExport({ config, accessToken, state, key, xml, filename, extra = {}, force = false, label, countFn }) {
  const hash = sha256(xml)
  if (!force && state.hashes[key] === hash) {
    console.log(`   ⏭️  ${label}: unchanged since last sync`)
    return 'unchanged'
  }
  const payload = buildPreviewPayload(xml, config.tally.company, filename, extra)
  const result = await previewAndCommit(config.supabase, accessToken, payload)
  const { ins, upd, skip } = stamp(result)
  console.log(`   ✅ ${label}: ${countFn(xml)} → ${ins} inserted, ${upd} updated, ${skip} unchanged`)
  state.hashes[key] = hash
  return 'ok'
}

/**
 * Sync vouchers for [fromYmd, toYmd]. Splits the range when the payload is too large.
 * Every upload carries its window so deletions/cancellations in Tally propagate.
 */
async function syncVoucherRange({ config, accessToken, state, fromDate, toDate, label, force, totals }) {
  const response = await sendToTally(
    buildExportRequest('Day Book', config.tally.company, { fromDate, toDate }),
    config.tally,
  )
  if (!/<ENVELOPE/i.test(response)) throw new Error('Tally returned a response without an <ENVELOPE>; refusing to reconcile.')

  const key = `vouchers:${fromDate}-${toDate}`
  const hash = sha256(response)
  const window = { from: ymdToIso(fromDate), to: ymdToIso(toDate) }
  const payload = buildPreviewPayload(response, config.tally.company, `tally-vouchers-${fromDate}-${toDate}.xml`, { window })

  if (payload.contentBase64.length > MAX_PAYLOAD_B64) {
    const halves = splitRange(fromDate, toDate)
    if (!halves) throw new Error(`A single day (${fromDate}) exceeds the upload limit; cannot split further.`)
    console.log(`   ↔️  ${label}: ${(payload.contentBase64.length / 1e6).toFixed(1)} MB — splitting`)
    for (const half of halves) {
      await new Promise((r) => setTimeout(r, 300))
      await syncVoucherRange({ config, accessToken, state, fromDate: half.fromDate, toDate: half.toDate, label: `${half.fromDate}–${half.toDate}`, force, totals })
    }
    return
  }

  if (!force && state.hashes[key] === hash) {
    console.log(`   ${label}: unchanged since last sync`)
    return
  }
  const result = await previewAndCommit(config.supabase, accessToken, payload)
  const { ins, upd, skip, del } = stamp(result)
  totals.inserted += ins; totals.updated += upd; totals.deleted += del
  const note = result.commit?.reconcileNote ? ` (deletion check ${result.commit.reconcileNote})` : ''
  console.log(`   ${label}: ${countElements(response).voucherCount} vouchers → ${ins} inserted, ${upd} updated, ${skip} unchanged, ${del} removed${note}`)
  state.hashes[key] = hash
}

/**
 * Core run: masters, stock, then vouchers for [fromDate, toDate] (YYYY-MM-DD).
 * @returns {Promise<{ failures: number }>}
 */
async function runSync(config, accessToken, { fromDate, toDate, force = false, state }) {
  let failures = 0
  const company = config.tally.company

  // 1. Account groups → lets sub-groups of Sundry Debtors/Creditors etc. classify correctly.
  let groups = {}
  console.log('\n📋 Pulling account groups...')
  try {
    const groupsXml = await sendToTally(buildExportRequest('List of Groups', company), config.tally)
    groups = extractGroupParents(groupsXml)
    console.log(`   ✅ ${Object.keys(groups).length} groups`)
  } catch (err) {
    console.warn(`   ⚠️  Groups unavailable (${err.message}); falling back to name-based classification.`)
  }

  // 2. Ledgers
  console.log('\n📋 Pulling ledgers...')
  try {
    const xml = await sendToTally(buildExportRequest('List of Accounts', company), config.tally)
    if (hasData(xml)) {
      await pushExport({ config, accessToken, state, key: 'masters', xml, filename: `tally-masters-${toDate}.xml`, extra: { groups }, force, label: 'Ledgers', countFn: (x) => `${countElements(x).ledgerCount} ledgers` })
    } else {
      console.warn('   ⚠️  Tally returned no ledgers — check TALLY_COMPANY and that the company is open.')
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Ledgers failed: ${err.message}`)
  }

  // 3. Stock items
  console.log('\n📋 Pulling stock items...')
  try {
    const xml = await sendToTally(buildExportRequest('List of Stock Items', company), config.tally)
    if (hasData(xml)) {
      await pushExport({ config, accessToken, state, key: 'stock', xml, filename: `tally-stock-${toDate}.xml`, force, label: 'Stock items', countFn: (x) => `${countElements(x).stockCount} items` })
    } else {
      console.log('   ℹ️  No stock items returned by Tally.')
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Stock items failed: ${err.message}`)
  }

  // 4. Item-wise stock summary = live quantity, average rate, value
  console.log('\n📋 Pulling item-wise stock values...')
  try {
    const xml = await sendToTally(buildExportRequest('Stock Summary', company, { toDate: toDate.replace(/-/g, '') }), config.tally)
    if (countElements(xml).stockSummaryCount > 0) {
      await pushExport({ config, accessToken, state, key: 'stock-summary', xml, filename: `tally-stock-summary-${toDate}.xml`, force, label: 'Stock values', countFn: (x) => `${countElements(x).stockSummaryCount} items` })
    } else {
      console.log('   ℹ️  Tally returned no item-wise stock values.')
    }
  } catch (err) {
    // Stock values enrichment: warn if edge function does not support summary XML yet
    console.warn('   ⚠️  Stock values skipped: ' + err.message)
  }

  // 5. Vouchers (monthly chunks, adaptively split)
  const chunks = monthlyChunks(fromDate, toDate)
  console.log(`\n📋 Pulling vouchers ${fromDate} → ${toDate} in ${chunks.length} chunk(s)${force ? ' (full reconcile)' : ''}...`)
  const totals = { inserted: 0, updated: 0, deleted: 0 }
  for (const chunk of chunks) {
    // Tally's HTTP listener is single-threaded; give it a moment between requests.
    await new Promise((r) => setTimeout(r, 500))
    try {
      await syncVoucherRange({ config, accessToken, state, fromDate: chunk.fromDate, toDate: chunk.toDate, label: chunk.label, force, totals })
    } catch (err) {
      failures++
      console.error(`   ❌ ${chunk.label} failed: ${err.message}`)
    }
  }
  console.log(`\n📊 Vouchers: ${totals.inserted} inserted, ${totals.updated} updated, ${totals.deleted} removed, ${failures} failure(s)`)
  await syncPnl(config, accessToken, state, { force })
  return { failures }
}

/**
 * pull — Full sync for a date range (always uploads; ignores the unchanged-payload cache).
 */
async function cmdPull(config, values) {
  const today = localDateString(new Date())
  const fromDate = values.from
  const toDate = values.to || today
  if (!fromDate) {
    console.error('❌ --from YYYY-MM-DD is required for the pull command.')
    process.exitCode = 1
    return
  }

  const release = acquireLock()
  if (!release) {
    console.warn('⏳ Another sync is already running; skipping this one.')
    return
  }
  try {
    console.log(`\n📥 Pull: syncing ${fromDate} → ${toDate}`)
    console.log(`   Tally: ${config.tally.host}:${config.tally.port}, Company: ${config.tally.company}`)
    console.log(`   Supabase: ${redactUrl(config.supabase.url)}\n`)

    let accessToken
    try {
      accessToken = await authenticate(config.supabase)
      console.log('🔐 Authenticated with Supabase.')
    } catch (err) {
      console.error(`❌ Auth failed: ${err.message}`)
      process.exitCode = 1
      return
    }

    const runStartedAt = new Date()
    const state = loadState()
    const { failures } = await runSync(config, accessToken, { fromDate, toDate, force: true, state })
    saveState(state)
    // Only a pull that reaches today may move the cursor; a historical back-fill must not make
    // the incremental run skip the days after it.
    if (failures === 0 && toDate >= today) {
      try { await setLastSyncDate(config.supabase, accessToken, null, undefined, runStartedAt) } catch (err) {
        console.error(`   ⚠️  ${err.message}`)
        process.exitCode = 1
      }
    }
    if (failures > 0) process.exitCode = 1
    console.log('✅ Pull complete.\n')
  } finally {
    release()
  }
}

/**
 * incremental — Sync (cursor − 7 days) → today. Once per calendar day it additionally
 * re-reads the whole current financial year and reconciles it, which self-heals edits
 * to old vouchers, deletions, and anything an earlier failed run missed.
 */
async function cmdIncremental(config, _values) {
  const release = acquireLock()
  if (!release) {
    console.warn('⏳ Another sync is already running; skipping this one.')
    return
  }
  try {
    console.log('\n🔄 Incremental sync...')
    let accessToken
    try {
      accessToken = await authenticate(config.supabase)
    } catch (err) {
      console.error(`❌ Auth failed: ${err.message}`)
      process.exitCode = 1
      return
    }

    let lastSync = null
    try {
      lastSync = await getLastSyncDate(config.supabase, accessToken)
    } catch (err) {
      console.warn(`   ⚠️  ${err.message}; using the 90-day catch-up window.`)
    }

    const runStartedAt = new Date()
    const today = localDateString(runStartedAt)
    const state = loadState()
    const needsDailyReconcile = state.lastFullSyncDate !== today

    let fromDate
    if (lastSync) {
      const d = new Date(lastSync)
      d.setDate(d.getDate() - 7)              // overlap: vouchers can be edited retroactively
      fromDate = localDateString(d)
      console.log(`   Last successful run: ${lastSync}`)
    } else {
      const d = new Date(runStartedAt)
      d.setDate(d.getDate() - 90)
      fromDate = localDateString(d)
      console.log('   No successful run recorded — pulling the last 90 days.')
    }
    if (needsDailyReconcile) {
      const fyStart = financialYearStart(runStartedAt, Number(process.env.FY_START_MONTH) || 4)
      if (fyStart < fromDate) fromDate = fyStart
      console.log(`   Daily reconcile due — reading the full financial year from ${fromDate}.`)
    }
    console.log(`   Pulling ${fromDate} → ${today}`)

    const { failures } = await runSync(config, accessToken, { fromDate, toDate: today, force: needsDailyReconcile, state })
    if (failures === 0) {
      if (needsDailyReconcile) state.lastFullSyncDate = today
      saveState(state)
      try {
        // Cursor = when this run STARTED, so edits made during the run are re-read next time.
        await setLastSyncDate(config.supabase, accessToken, null, undefined, runStartedAt)
      } catch (err) {
        console.error(`   ⚠️  ${err.message}`)
        process.exitCode = 1
      }
    } else {
      saveState(state)        // keep hashes of the parts that did succeed
      process.exitCode = 1    // cursor deliberately NOT advanced: the failed window is retried
    }
  } finally {
    release()
  }
}


// ─── Profit & Loss (Tally's own cost of sales and profit) ────────────────────

const PNL_REFRESH_MS = 10 * 60 * 1000

/** Fetch, validate and store Tally's Profit & Loss for each window the dashboard shows. */
async function syncPnl(config, accessToken, state, { force = false, now = new Date() } = {}) {
  if (!force && state.lastPnlAt && now.getTime() - Number(state.lastPnlAt) < PNL_REFRESH_MS) {
    console.log('\n📋 Profit & Loss: refreshed recently, skipping.')
    return { stored: 0, failed: 0 }
  }
  console.log('\n📋 Pulling Tally Profit & Loss...')
  let stored = 0, failed = 0
  for (const period of pnlPeriods(now)) {
    let xml = ''
    try {
      const request = buildExportRequest('Profit & Loss', config.tally.company, { fromDate: period.from.replace(/-/g, ''), toDate: period.to.replace(/-/g, '') })
      xml = await sendToTally(request, config.tally)
      const record = parsePnlXml(xml, { company: config.tally.company, from: period.from, to: period.to })
      await upsertPnl(config.supabase, accessToken, record)
      stored += 1
      console.log(`   ✅ ${period.key} (${period.from} → ${period.to}): sales ${record.sales}, cost of sales ${record.cogs}, net profit ${record.net_profit}`)
    } catch (err) {
      failed += 1
      // Profit is reported separately from voucher sync: a P&L problem must never hold back the cursor.
      console.warn(`   ⚠️  ${period.key}: ${err.message}`)
      if (err instanceof PnlError && xml) {      // keep the raw response so the layout can be inspected
        try {
          const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'samples')
          mkdirSync(dir, { recursive: true })
          writeFileSync(resolve(dir, `pnl-rejected-${period.key}.xml`), xml, 'utf-8')
          console.warn(`      Raw response saved to connector/samples/pnl-rejected-${period.key}.xml`)
        } catch { /* best effort */ }
      }
    }
  }
  if (stored > 0) state.lastPnlAt = now.getTime()
  return { stored, failed }
}

/** pnl — fetch Tally's Profit & Loss for a period, save the raw XML, validate and upload it. */
async function cmdPnl(config, values) {
  const today = new Date()
  const [monthPeriod] = pnlPeriods(today).filter((p) => p.key === 'month')
  const from = values.from || monthPeriod.from
  const to = values.to || monthPeriod.to
  console.log(`\n📋 Profit & Loss ${from} → ${to} (${config.tally.company})`)
  const xml = await sendToTally(buildExportRequest('Profit & Loss', config.tally.company, { fromDate: from.replace(/-/g, ''), toDate: to.replace(/-/g, '') }), config.tally)
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), 'samples')
  mkdirSync(dir, { recursive: true })
  const file = resolve(dir, `pnl-${from}-${to}.xml`)
  writeFileSync(file, xml, 'utf-8')
  console.log(`   Raw Tally response saved to ${file}`)
  let record
  try {
    record = parsePnlXml(xml, { company: config.tally.company, from, to })
  } catch (err) {
    console.error(`   ❌ ${err.message}\n   Send the saved XML file so the parser can be matched to this Tally release.`)
    process.exitCode = 1
    return
  }
  console.log(`   Sales ${record.sales} | Cost of sales ${record.cogs} (opening ${record.opening_stock} + purchases ${record.purchases} + direct exp ${record.direct_expenses} − closing ${record.closing_stock})`)
  console.log(`   Gross profit ${record.gross_profit} | Indirect expenses ${record.indirect_expenses} | Nett profit ${record.net_profit}`)
  const accessToken = await authenticate(config.supabase)
  await upsertPnl(config.supabase, accessToken, record)
  console.log('   ✅ Stored.')
}

/** pnl-import — load a Profit & Loss exported from Tally as Excel (.xls/.xlsx). */
async function cmdPnlImport(config, values) {
  if (!values.file) { console.error('❌ --file path/to/PandL.xls is required.'); process.exitCode = 1; return }
  const XLSX = (await import('xlsx')).default ?? (await import('xlsx'))
  const workbook = XLSX.read(readFileSync(values.file), { type: 'buffer' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true })
  let record
  try {
    record = parsePnlRows(rows)
  } catch (err) {
    console.error(`❌ ${err.message}`)
    process.exitCode = 1
    return
  }
  if (config.tally?.company) record.company = config.tally.company
  console.log(`   ${record.company}: ${record.period_start} → ${record.period_end}`)
  console.log(`   Sales ${record.sales} | Cost of sales ${record.cogs} | Gross profit ${record.gross_profit} | Indirect expenses ${record.indirect_expenses} | Nett profit ${record.net_profit}`)
  const accessToken = await authenticate(config.supabase)
  await upsertPnl(config.supabase, accessToken, record, { source: 'excel' })
  console.log('   ✅ Stored.')
}

// ─── Loop Mode ───────────────────────────────────────────────────────────────

async function cmdLoop(config, values) {
  const parsedEvery = Number.parseInt(values.every || '15', 10)
  const everyMin = Number.isFinite(parsedEvery) && parsedEvery > 0 ? parsedEvery : 15
  console.log(`\n🔁 Loop mode: running incremental every ${everyMin} minutes. Press Ctrl+C to stop.\n`)

  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    console.log('\n🛑 Stopping loop...')
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  while (!stopping) {
    process.exitCode = undefined
    await runOnce(config, values)
    if (stopping) break
    await new Promise((resolvePromise) => {
      const timeout = setTimeout(resolvePromise, everyMin * 60 * 1000)
      const wakeOnStop = () => {
        clearTimeout(timeout)
        process.off('SIGINT', wakeOnStop)
        process.off('SIGTERM', wakeOnStop)
        resolvePromise()
      }
      process.once('SIGINT', wakeOnStop)
      process.once('SIGTERM', wakeOnStop)
    })
  }
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}

async function runOnce(config, values) {
  const startTime = new Date()
  console.log(`\n──── Run at ${startTime.toLocaleString()} ────`)
  try {
    await cmdIncremental(config, values)
  } catch (err) {
    console.error(`❌ Run failed: ${err.message}`)
    // One failed run does not stop the loop
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const { command, values, cliFlags } = parseCliArgs(process.argv.slice(2))

  let config
  try {
    // discover doesn't need Supabase credentials
    if (command === 'discover') {
      try {
        config = loadConfig(cliFlags)
      } catch (err) {
        // For discover, only Tally config is required
        if (err.message.includes('SUPABASE_')) {
          // Create a minimal config with just Tally settings
          const dotEnv = {}
          const get = (key) => cliFlags[key] ?? process.env[key] ?? dotEnv[key] ?? ''
          config = {
            tally: {
              host: get('TALLY_HOST') || '127.0.0.1',
              port: parseInt(get('TALLY_PORT') || '9000', 10),
              company: get('TALLY_COMPANY'),
            },
            supabase: { url: '', anonKey: '', email: '', password: '' },
            allowRemote: !!cliFlags.allowRemote,
          }
          // Re-check loopback
          const host = config.tally.host.toLowerCase()
          if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !cliFlags.allowRemote) {
            console.error(`❌ TALLY_HOST="${config.tally.host}" is not loopback. Pass --allow-remote to override.`)
            process.exitCode = 1
            return
          }
        } else {
          throw err
        }
      }
    } else {
      config = loadConfig(cliFlags)
    }
  } catch (err) {
    console.error(`❌ ${err.message}`)
    process.exitCode = 1
    return
  }

  switch (command) {
    case 'discover':
      await cmdDiscover(config, values)
      break
    case 'pull':
      await cmdPull(config, values)
      break
    case 'pnl':
      await cmdPnl(config, values)
      break
    case 'pnl-import':
      await cmdPnlImport(config, values)
      break
    case 'incremental':
      if (values.loop) {
        await cmdLoop(config, values)
      } else {
        await cmdIncremental(config, values)
      }
      break
    default:
      console.error(`❌ Unknown command: "${command}". Use discover, pull, incremental, pnl, or pnl-import.`)
      printUsage()
      process.exitCode = 1
  }
}

main().catch((err) => {
  console.error(`\n💥 Unexpected error: ${err.message}`)
  console.error(err.stack)
  process.exitCode = 1
})

// Export for testing
export { cmdDiscover, cmdPull, cmdIncremental, parseCliArgs }
