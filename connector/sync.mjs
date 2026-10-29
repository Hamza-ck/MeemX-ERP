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
 *   TALLY_HOST, TALLY_PORT, TALLY_COMPANY (optional; defaults to the active Tally company),
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
 */

import { parseArgs } from 'node:util'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, redactUrl } from './config.mjs'
import { sendToTally, buildExportRequest, TallyConnectionError } from './tally_client.mjs'
import { countElements, hasData, buildPreviewPayload, monthlyChunks } from './normalize.mjs'
import { authenticate, previewAndCommit, getLastSyncDate, setLastSyncDate } from './supabase_client.mjs'

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

  incremental  Sync from (last successful sync - 7 days) to today.
               --loop             Run repeatedly until Ctrl+C
               --every N          Minutes between runs (default: 15)

Options:
  --tally-host HOST       Override TALLY_HOST (default: 127.0.0.1)
  --tally-port PORT       Override TALLY_PORT (default: 9000)
  --tally-company NAME    Select a company (defaults to the active company in Tally)
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
  console.log(`   Tally: ${config.tally.host}:${config.tally.port}, Company: ${config.tally.company || 'active company'}\n`)

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

/**
 * pull — Full sync for a date range.
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

  console.log(`\n📥 Pull: syncing ${fromDate} → ${toDate}`)
  console.log(`   Tally: ${config.tally.host}:${config.tally.port}, Company: ${config.tally.company || 'active company'}`)
  console.log(`   Supabase: ${redactUrl(config.supabase.url)}\n`)

  let failures = 0

  // Authenticate with Supabase
  let accessToken
  try {
    accessToken = await authenticate(config.supabase)
    console.log('🔐 Authenticated with Supabase.')
  } catch (err) {
    console.error(`❌ Auth failed: ${err.message}`)
    process.exitCode = 1
    return
  }

  // 1. Masters (Ledgers)
  console.log('\n📋 Pulling ledgers...')
  try {
    const mastersXml = buildExportRequest('List of Accounts', config.tally.company)
    const mastersResponse = await sendToTally(mastersXml, config.tally)
    if (hasData(mastersResponse)) {
      const payload = buildPreviewPayload(mastersResponse, config.tally.company, `tally-masters-${toDate}.xml`)
      const result = await previewAndCommit(config.supabase, accessToken, payload)
      const ins = result.commit?.inserted ?? 0
      const upd = result.commit?.updated ?? 0
      const skip = result.commit?.skipped ?? 0
      const mc = countElements(mastersResponse)
      console.log(`   ✅ Ledgers: ${mc.ledgerCount} ledgers → ${ins} inserted, ${upd} updated, ${skip} unchanged`)
    } else {
      console.log('   ℹ️  No master data returned by Tally.')
      failures++
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Ledgers failed: ${err.message}`)
  }

  // 1b. Stock Items
  console.log('\n📋 Pulling stock items...')
  try {
    const stockXml = buildExportRequest('List of Stock Items', config.tally.company)
    const stockResponse = await sendToTally(stockXml, config.tally)
    if (hasData(stockResponse)) {
      const payload = buildPreviewPayload(stockResponse, config.tally.company, `tally-stock-${toDate}.xml`)
      const result = await previewAndCommit(config.supabase, accessToken, payload)
      const ins = result.commit?.inserted ?? 0
      const upd = result.commit?.updated ?? 0
      const skip = result.commit?.skipped ?? 0
      const sc = countElements(stockResponse)
      console.log(`   ✅ Stock Items: ${sc.stockCount} items → ${ins} inserted, ${upd} updated, ${skip} unchanged`)
    } else {
      console.log('   ℹ️  No stock items returned by Tally.')
      failures++
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Stock items failed: ${err.message}`)
  }

  // 1c. The item-wise Stock Summary carries the live quantity, valuation rate,
  // and closing value; the StockItem master export omits these on some Tally builds.
  console.log('\n📋 Pulling item-wise stock values...')
  try {
    const stockSummaryXml = buildExportRequest('Stock Summary', config.tally.company, {
      toDate: toDate.replace(/-/g, ''),
    })
    const stockSummaryResponse = await sendToTally(stockSummaryXml, config.tally)
    const summaryCount = countElements(stockSummaryResponse).stockSummaryCount
    if (summaryCount > 0) {
      const payload = buildPreviewPayload(
        stockSummaryResponse,
        config.tally.company,
        `tally-stock-summary-${toDate}.xml`
      )
      const result = await previewAndCommit(config.supabase, accessToken, payload)
      const ins = result.commit?.inserted ?? 0
      const upd = result.commit?.updated ?? 0
      const skip = result.commit?.skipped ?? 0
      console.log(`   ✅ Stock values: ${summaryCount} items → ${ins} inserted, ${upd} updated, ${skip} unchanged`)
    } else {
      console.log('   ℹ️  Tally returned no item-wise stock values.')
      failures++
    }
  } catch (err) {
    failures++
    console.error(`   ❌ Stock values failed: ${err.message}`)
  }

  // 2. Vouchers in monthly chunks from Tally's dated voucher collection.
  const chunks = monthlyChunks(fromDate, toDate)
  console.log(`\n📋 Pulling vouchers in ${chunks.length} monthly chunk(s)...`)

  let totalInserted = 0
  let totalSkipped = 0
  let lastJobId = null

  for (const chunk of chunks) {
    // 500ms pause allows Tally's single-threaded HTTP listener to recycle sockets cleanly
    await new Promise((r) => setTimeout(r, 500))
    try {
      const voucherXml = buildExportRequest('Day Book', config.tally.company, {
        fromDate: chunk.fromDate,
        toDate: chunk.toDate,
      })
      const response = await sendToTally(voucherXml, config.tally)

      if (!hasData(response)) {
        console.log(`   ${chunk.label}: no data`)
        continue
      }

      const payload = buildPreviewPayload(
        response,
        config.tally.company,
        `tally-vouchers-${chunk.fromDate}-${chunk.toDate}.xml`
      )
      const result = await previewAndCommit(config.supabase, accessToken, payload)
      const ins = result.commit?.inserted ?? 0
      const skip = result.commit?.skipped ?? 0
      totalInserted += ins
      totalSkipped += skip
      if (result.commit?.jobId) lastJobId = result.commit.jobId
      const vc = countElements(response)
      const upd = result.commit?.updated ?? 0
      console.log(`   ${chunk.label}: ${vc.voucherCount} vouchers → ${ins} inserted, ${upd} updated, ${skip} unchanged`)
    } catch (err) {
      failures++
      console.error(`   ❌ ${chunk.label} failed: ${err.message}`)
      // Continue with next chunk — earlier chunks are already saved
    }
  }

  console.log(`\n📊 Summary: ${totalInserted} inserted, ${totalSkipped} skipped, ${failures} failed chunk(s)`)

  if (failures === 0 && lastJobId) {
    try {
      await setLastSyncDate(config.supabase, accessToken, lastJobId)
    } catch { /* best effort */ }
  }

  if (failures > 0) {
    process.exitCode = 1
  }

  console.log('✅ Pull complete.\n')
}

/**
 * incremental — Sync from (last sync - 7 days overlap) to today.
 */
async function cmdIncremental(config, values) {
  console.log('\n🔄 Incremental sync...')

  // Authenticate
  let accessToken
  try {
    accessToken = await authenticate(config.supabase)
  } catch (err) {
    console.error(`❌ Auth failed: ${err.message}`)
    process.exitCode = 1
    return
  }

  // Read last sync date
  let lastSync = null
  try {
    lastSync = await getLastSyncDate(config.supabase, accessToken)
  } catch { /* first run */ }

  const today = localDateString(new Date())
  let fromDate

  if (lastSync) {
    // Subtract 7 days for overlap (vouchers can be edited retroactively)
    const d = new Date(lastSync)
    d.setDate(d.getDate() - 7)
    fromDate = localDateString(d)
    console.log(`   Last sync: ${lastSync}`)
    console.log(`   Pulling from ${fromDate} (7-day overlap) to ${today}`)
  } else {
    // First run — default to 90 days back
    const d = new Date()
    d.setDate(d.getDate() - 90)
    fromDate = localDateString(d)
    console.log(`   First run — pulling last 90 days (${fromDate} to ${today})`)
  }

  // Delegate to pull logic
  values.from = fromDate
  values.to = today
  await cmdPull(config, values)
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
    case 'incremental':
      if (values.loop) {
        await cmdLoop(config, values)
      } else {
        await cmdIncremental(config, values)
      }
      break
    default:
      console.error(`❌ Unknown command: "${command}". Use discover, pull, or incremental.`)
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
