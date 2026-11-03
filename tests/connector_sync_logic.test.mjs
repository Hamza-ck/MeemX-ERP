import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, financialYearStart, loadState, saveState, sha256 } from '../connector/state.mjs'
import { extractGroupParents, splitRange, ymdToIso, monthlyChunks } from '../connector/normalize.mjs'
import { parseHost, loadConfig } from '../connector/config.mjs'
import { previewAndCommit } from '../connector/supabase_client.mjs'

const dir = () => mkdtempSync(join(tmpdir(), 'meemx-'))

describe('run lock', () => {
  it('blocks an overlapping run, releases cleanly, and recovers from a stale lock', () => {
    const file = join(dir(), 'lock')
    const release = acquireLock(file, 1_000_000)
    assert.ok(release)
    assert.equal(acquireLock(file, 1_000_000 + 60_000), null)             // another run is live
    release()
    const again = acquireLock(file, 1_000_000 + 61_000); assert.ok(again); again()
    writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 1_000_000 }))
    assert.ok(acquireLock(file, 1_000_000 + 31 * 60_000))                  // crashed run (>30 min) is taken over
  })
})

describe('state + financial year', () => {
  it('Indian FY starts 1 April; before April it is the previous year', () => {
    assert.equal(financialYearStart(new Date(2026, 9, 31)), '2026-04-01')
    assert.equal(financialYearStart(new Date(2027, 1, 10)), '2026-04-01')
    assert.equal(financialYearStart(new Date(2026, 3, 1)), '2026-04-01')
  })
  it('round-trips state and tolerates a missing/corrupt file', () => {
    const file = join(dir(), 's.json')
    assert.deepEqual(loadState(file), { lastFullSyncDate: null, hashes: {} })
    saveState({ lastFullSyncDate: '2026-10-31', hashes: { masters: sha256('x') } }, file)
    assert.equal(loadState(file).lastFullSyncDate, '2026-10-31')
    writeFileSync(file, '{not json')
    assert.deepEqual(loadState(file), { lastFullSyncDate: null, hashes: {} })
  })
})

describe('chunking', () => {
  it('splits a date range into two non-overlapping halves that cover it, down to one day', () => {
    const [a, b] = splitRange('20261001', '20261031')
    assert.equal(a.fromDate, '20261001')
    assert.equal(b.toDate, '20261031')
    assert.equal(ymdToIso(b.fromDate) > ymdToIso(a.toDate), true)
    assert.equal(splitRange('20261005', '20261005'), null)
    const [x, y] = splitRange('20261005', '20261006')
    assert.deepEqual([x.fromDate, x.toDate, y.fromDate, y.toDate], ['20261005', '20261005', '20261006', '20261006'])
  })
  it('monthly chunks never straddle a month (so never a financial year boundary)', () => {
    const chunks = monthlyChunks('2026-03-15', '2026-05-10')
    assert.equal(chunks.length, 3)
    assert.equal(chunks[0].toDate, '20260331')
    assert.equal(chunks[1].fromDate, '20260401')
  })
})

describe('group hierarchy extraction', () => {
  it('reads names and parents, decoding entities and Tally control characters', () => {
    const xml = '<GROUP NAME="Retail Customers"><PARENT>Sundry Debtors</PARENT></GROUP>' +
      '<GROUP NAME="Duties &amp; Taxes"><PARENT>&#4; Primary</PARENT></GROUP>'
    assert.deepEqual(extractGroupParents(xml), { 'Retail Customers': 'Sundry Debtors', 'Duties & Taxes': 'Primary' })
  })
})

describe('config', () => {
  it('keeps IPv6 literals intact instead of cutting them at the first colon', () => {
    assert.equal(parseHost('::1'), '::1')
    assert.equal(parseHost('[::1]:9000'), '::1')
    assert.equal(parseHost('http://localhost:9000/'), 'localhost')
  })
  it('rejects a bad port and an empty env value does not hide a real one', () => {
    const base = { TALLY_COMPANY: 'Co', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'k', SUPABASE_EMAIL: 'a@b.c', SUPABASE_PASSWORD: 'p' }
    assert.throws(() => loadConfig({}, { ...base, TALLY_PORT: 'abc' }), /not a valid port/)
    assert.equal(loadConfig({}, { ...base, TALLY_HOST: '', TALLY_PORT: '9000' }).tally.host, '127.0.0.1')
  })
})

describe('upload retry safety', () => {
  const cfg = { url: 'https://x.supabase.co', anonKey: 'k' }
  // const reply helper

  it('still commits an empty window so Tally deletions propagate', async () => {
    const calls = []
    const fetchFn = async (url, init) => {
      const body = JSON.parse(init.body); calls.push(body.action)
      return body.action === 'preview'
        ? { ok: true, status: 200, json: async () => ({ jobId: 'j', summary: { valid: 0, total: 0 } }) }
        : { ok: true, status: 200, json: async () => ({ status: 'committed', deleted: 3 }) }
    }
    const result = await previewAndCommit(cfg, 'tok', { action: 'preview', window: { from: '2026-10-01', to: '2026-10-31' } }, fetchFn)
    assert.deepEqual(calls, ['preview', 'commit'])
    assert.equal(result.commit.deleted, 3)
  })

  it('treats "not ready to commit" on a retry as already committed rather than failing the chunk', async () => {
    let n = 0
    const fetchFn = async (url, init) => {
      const body = JSON.parse(init.body)
      if (body.action === 'preview') return { ok: true, status: 200, json: async () => ({ jobId: 'j', summary: { valid: 2 } }) }
      n += 1
      return { ok: false, status: 400, json: async () => ({ error: 'Import job is not ready to commit' }) }
    }
    const result = await previewAndCommit(cfg, 'tok', { action: 'preview' }, fetchFn)
    assert.equal(result.commit.alreadyCommitted, true)
    assert.equal(n, 1)
  })
})

describe('uploading Profit & Loss', () => {
  it('upserts one row per company + period and fails loudly if the server rejects it', async () => {
    const { upsertPnl } = await import('../connector/supabase_client.mjs')
    const sent = []
    const ok = async (url, init) => { sent.push({ url, init }); return { ok: true, status: 201, text: async () => '' } }
    const record = { company: 'Co', period_start: '2026-10-01', period_end: '2026-10-31', sales: 1, direct_income: 0, opening_stock: 2, purchases: 3, direct_expenses: 0,
      closing_stock: 4, cogs: 1, gross_profit: 0, indirect_expenses: 0, indirect_income: 0, net_profit: 0, junk: 'ignored' }
    await upsertPnl({ url: 'https://x.supabase.co', anonKey: 'k' }, 'tok', record, { source: 'excel' }, ok)
    assert.match(sent[0].url, /tally_pnl_periods\?on_conflict=company,period_start,period_end$/)
    assert.equal(sent[0].init.headers.Prefer, 'resolution=merge-duplicates,return=minimal')
    const body = JSON.parse(sent[0].init.body)
    assert.equal(body.source, 'excel')
    assert.equal(body.junk, undefined)
    const denied = async () => ({ ok: false, status: 403, text: async () => 'new row violates row-level security policy' })
    await assert.rejects(() => upsertPnl({ url: 'https://x', anonKey: 'k' }, 't', record, {}, denied), /HTTP 403.*row-level security/)
  })
})
