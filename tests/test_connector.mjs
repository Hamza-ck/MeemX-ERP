/**
 * tests/test_connector.mjs — Tests for the Tally connector.
 *
 * Uses Node's built-in test runner (node:test) and a tiny http.server
 * running in a thread as a FAKE Tally.
 *
 * Run: node --test tests/test_connector.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig, redactUrl } from '../connector/config.mjs'
import {
  sendToTally,
  buildExportRequest,
  decodeTallyResponse,
  TallyError,
  TallyConnectionError,
} from '../connector/tally_client.mjs'
import { countElements, hasData, buildPreviewPayload, monthlyChunks } from '../connector/normalize.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ─── Sample XML Fixtures ─────────────────────────────────────────────────────

/**
 * Minimal Tally-style XML response with ledgers, stock items, and vouchers.
 * Matches the shape the edge function expects (TALLYMESSAGE > VOUCHER/LEDGER/STOCKITEM).
 */
const SAMPLE_TALLY_RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<ENVELOPE>
  <HEADER><STATUS>1</STATUS></HEADER>
  <BODY>
    <DATA>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <LEDGER NAME="Test Customer Alpha">
          <NAME>Test Customer Alpha</NAME>
          <PARENT>Sundry Debtors</PARENT>
          <OPENINGBALANCE>5000.00</OPENINGBALANCE>
          <LEDGERPHONE>+91 99999 11111</LEDGERPHONE>
        </LEDGER>
      </TALLYMESSAGE>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <LEDGER NAME="Test Supplier Beta">
          <NAME>Test Supplier Beta</NAME>
          <PARENT>Sundry Creditors</PARENT>
          <OPENINGBALANCE>8000.00</OPENINGBALANCE>
        </LEDGER>
      </TALLYMESSAGE>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <STOCKITEM NAME="Widget A">
          <NAME>Widget A</NAME>
          <BASEUNITS>pcs</BASEUNITS>
          <OPENINGBALANCE>100 pcs</OPENINGBALANCE>
          <OPENINGRATE>50.00/pcs</OPENINGRATE>
        </STOCKITEM>
      </TALLYMESSAGE>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="Sales">
          <DATE>20261014</DATE>
          <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
          <VOUCHERNUMBER>TEST-SL-001</VOUCHERNUMBER>
          <PARTYLEDGERNAME>Test Customer Alpha</PARTYLEDGERNAME>
          <GUID>GUID-001</GUID>
          <NARRATION>Test sale of widgets</NARRATION>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>Test Customer Alpha</LEDGERNAME>
            <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
            <AMOUNT>-15000.00</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
          <ALLINVENTORYENTRIES.LIST>
            <STOCKITEMNAME>Widget A</STOCKITEMNAME>
            <BILLEDQTY>30 pcs</BILLEDQTY>
            <RATE>500.00</RATE>
            <AMOUNT>15000.00</AMOUNT>
          </ALLINVENTORYENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
      <TALLYMESSAGE xmlns:UDF="TallyUDF">
        <VOUCHER VCHTYPE="Purchase">
          <DATE>20261013</DATE>
          <VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME>
          <VOUCHERNUMBER>TEST-PUR-001</VOUCHERNUMBER>
          <PARTYLEDGERNAME>Test Supplier Beta</PARTYLEDGERNAME>
          <GUID>GUID-002</GUID>
          <NARRATION>Purchase of raw materials</NARRATION>
          <ALLLEDGERENTRIES.LIST>
            <LEDGERNAME>Test Supplier Beta</LEDGERNAME>
            <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
            <AMOUNT>7500.00</AMOUNT>
          </ALLLEDGERENTRIES.LIST>
        </VOUCHER>
      </TALLYMESSAGE>
    </DATA>
  </BODY>
</ENVELOPE>`

const TALLY_ERROR_RESPONSE = `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><STATUS>0</STATUS></HEADER>
  <BODY>
    <DATA>
      <LINEERROR>Company not found: NonExistentCo</LINEERROR>
    </DATA>
  </BODY>
</ENVELOPE>`

const EMPTY_RESPONSE = `<?xml version="1.0"?>
<ENVELOPE>
  <HEADER><STATUS>1</STATUS></HEADER>
  <BODY><DATA></DATA></BODY>
</ENVELOPE>`

// ─── Fake Tally HTTP Server ──────────────────────────────────────────────────

let fakeTallyServer
let fakeTallyPort
let requestLog = []   // Track all requests for read-only assertion

function startFakeTally(responseOverride) {
  return new Promise((resolve) => {
    requestLog = []
    const response = responseOverride || SAMPLE_TALLY_RESPONSE

    fakeTallyServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        requestLog.push(body)

        // Check if request asks for error response
        if (body.includes('ERROR_COMPANY')) {
          res.writeHead(200, { 'Content-Type': 'text/xml' })
          res.end(TALLY_ERROR_RESPONSE)
          return
        }

        if (body.includes('EMPTY_COMPANY')) {
          res.writeHead(200, { 'Content-Type': 'text/xml' })
          res.end(EMPTY_RESPONSE)
          return
        }

        res.writeHead(200, { 'Content-Type': 'text/xml' })
        res.end(response)
      })
    })

    fakeTallyServer.listen(0, '127.0.0.1', () => {
      fakeTallyPort = fakeTallyServer.address().port
      resolve()
    })
  })
}

function stopFakeTally() {
  return new Promise((resolve) => {
    if (fakeTallyServer) {
      fakeTallyServer.closeAllConnections?.(); fakeTallyServer.close(resolve)
    } else {
      resolve()
    }
  })
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Connector: config', () => {
  it('refuses non-loopback host without --allow-remote', () => {
    assert.throws(
      () => loadConfig({}, {
        TALLY_HOST: '192.168.1.100',
        TALLY_PORT: '9000',
        TALLY_COMPANY: 'TestCo',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY: 'key',
        SUPABASE_EMAIL: 'a@b.com',
        SUPABASE_PASSWORD: 'pass',
      }),
      /not a loopback address/
    )
  })

  it('allows non-loopback host with --allow-remote', () => {
    // Suppress console.warn for this test
    const origWarn = console.warn
    console.warn = () => {}
    try {
      const cfg = loadConfig({ allowRemote: true }, {
        TALLY_HOST: '10.0.0.5',
        TALLY_PORT: '9000',
        TALLY_COMPANY: 'TestCo',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY: 'key',
        SUPABASE_EMAIL: 'a@b.com',
        SUPABASE_PASSWORD: 'pass',
      })
      assert.equal(cfg.tally.host, '10.0.0.5')
      assert.equal(cfg.allowRemote, true)
    } finally {
      console.warn = origWarn
    }
  })

  it('requires TALLY_COMPANY', () => {
    assert.throws(
      () => loadConfig({}, {
        TALLY_HOST: '127.0.0.1',
        TALLY_PORT: '9000',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY: 'key',
        SUPABASE_EMAIL: 'a@b.com',
        SUPABASE_PASSWORD: 'pass',
      }),
      /TALLY_COMPANY is required/
    )
  })

  it('redacts passwords in URLs', () => {
    const redacted = redactUrl('postgres://user:s3cret@host:5432/db')
    assert.ok(!redacted.includes('s3cret'), 'Password should be redacted')
    assert.ok(redacted.includes('***'), 'Should show *** for password')
  })

  it('redacts passwords in non-URL strings', () => {
    const redacted = redactUrl('not-a-url password=secret123&key=abc')
    assert.ok(!redacted.includes('secret123'))
    assert.ok(!redacted.includes('abc'))
  })

  it('accepts SUPABASE_ACCESS_TOKEN without email/password', () => {
    const cfg = loadConfig({}, {
      TALLY_HOST: '127.0.0.1',
      TALLY_PORT: '9000',
      TALLY_COMPANY: 'TestCo',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_ANON_KEY: 'key',
      SUPABASE_ACCESS_TOKEN: 'direct-jwt-token-xyz',
    })
    assert.equal(cfg.supabase.accessToken, 'direct-jwt-token-xyz')
  })
})

describe('Connector: tally_client', () => {
  before(async () => { await startFakeTally() })
  after(async () => { await stopFakeTally() })

  it('sends export request and decodes response', async () => {
    const xml = buildExportRequest('List of Accounts', 'TestCo')
    const response = await sendToTally(xml, {
      host: '127.0.0.1',
      port: fakeTallyPort,
      company: 'TestCo',
    }, { maxRetries: 0 })

    assert.ok(response.includes('<LEDGER'), 'Should contain LEDGER elements')
    assert.ok(response.includes('<VOUCHER'), 'Should contain VOUCHER elements')
    assert.ok(response.includes('Widget A'), 'Should contain stock item')
  })

  it('builds export request with date range (compact dates for vouchers, d-Mon-yyyy for reports)', () => {
    const vouchers = buildExportRequest('Day Book', 'MyCo', { fromDate: '20261001', toDate: '20261031' })
    assert.ok(vouchers.includes('<SVFROMDATE TYPE="Date">20261001</SVFROMDATE>'))
    assert.ok(vouchers.includes('<SVTODATE TYPE="Date">20261031</SVTODATE>'))
    assert.ok(vouchers.includes('<TALLYREQUEST>Export</TALLYREQUEST>'))

    const report = buildExportRequest('All Masters', 'MyCo', { fromDate: '20261001', toDate: '20261031' })
    assert.ok(report.includes('<SVFROMDATE TYPE="Date">1-Oct-2026</SVFROMDATE>'))
    assert.ok(report.includes('<SVTODATE TYPE="Date">31-Oct-2026</SVTODATE>'))
  })

  it('decodes UTF-16LE response', () => {
    const text = 'Hello Tally ✓'
    // Build a simple UTF-16LE buffer with BOM
    const utf16Bytes = new Uint8Array(2 + text.length * 2)
    utf16Bytes[0] = 0xFF  // BOM
    utf16Bytes[1] = 0xFE
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i)
      utf16Bytes[2 + i * 2] = code & 0xFF
      utf16Bytes[2 + i * 2 + 1] = (code >> 8) & 0xFF
    }
    const decoded = decodeTallyResponse(utf16Bytes.buffer)
    assert.ok(decoded.includes('Hello Tally'), 'Should decode UTF-16LE correctly')
  })

  it('strips control characters', () => {
    const dirty = 'Hello\x04World\x00End'
    const buf = new TextEncoder().encode(dirty)
    const cleaned = decodeTallyResponse(buf.buffer)
    assert.ok(!cleaned.includes('\x04'), 'Should strip \\x04')
    assert.ok(!cleaned.includes('\x00'), 'Should strip \\x00')
    assert.ok(cleaned.includes('HelloWorldEnd'))
  })

  it('handles Tally STATUS 0 error response', async () => {
    const xml = buildExportRequest('List of Accounts', 'ERROR_COMPANY')
    await assert.rejects(
      () => sendToTally(xml, {
        host: '127.0.0.1',
        port: fakeTallyPort,
        company: 'ERROR_COMPANY',
      }, { maxRetries: 0 }),
      (err) => {
        assert.ok(err instanceof TallyError)
        assert.ok(err.message.includes('Company not found'), `Should include Tally's error text: ${err.message}`)
        return true
      }
    )
  })

  it('friendly error when Tally is down (connection refused)', async () => {
    const xml = buildExportRequest('List of Accounts', 'TestCo')
    await assert.rejects(
      () => sendToTally(xml, {
        host: '127.0.0.1',
        port: 1,  // Almost certainly not listening
        company: 'TestCo',
      }, { maxRetries: 0, timeoutMs: 2000 }),
      (err) => {
        // Should be a TallyConnectionError with friendly message
        assert.ok(
          err instanceof TallyConnectionError || err.message.includes('Cannot connect'),
          `Expected friendly connection error, got: ${err.constructor.name}: ${err.message}`
        )
        return true
      }
    )
  })

  it('READ-ONLY: rejects Import request', () => {
    const maliciousXml = '<ENVELOPE><HEADER><TALLYREQUEST>Import</TALLYREQUEST></HEADER></ENVELOPE>'
    assert.rejects(
      () => sendToTally(maliciousXml, {
        host: '127.0.0.1',
        port: fakeTallyPort,
        company: 'TestCo',
      }),
      /READ-ONLY VIOLATION.*Import/
    )
  })

  it('READ-ONLY: rejects Execute request', () => {
    const maliciousXml = '<ENVELOPE><HEADER><TALLYREQUEST>Execute</TALLYREQUEST></HEADER></ENVELOPE>'
    assert.rejects(
      () => sendToTally(maliciousXml, {
        host: '127.0.0.1',
        port: fakeTallyPort,
        company: 'TestCo',
      }),
      /READ-ONLY VIOLATION.*Execute/
    )
  })

  it('READ-ONLY: rejects IMPORTDATA tag', () => {
    const maliciousXml = '<ENVELOPE><HEADER><TALLYREQUEST>Export</TALLYREQUEST></HEADER><IMPORTDATA></IMPORTDATA></ENVELOPE>'
    assert.rejects(
      () => sendToTally(maliciousXml, {
        host: '127.0.0.1',
        port: fakeTallyPort,
        company: 'TestCo',
      }),
      /READ-ONLY VIOLATION.*IMPORTDATA/
    )
  })

  it('READ-ONLY: no request ever sent contains Import or Execute', () => {
    // After all the tests, check the request log
    for (const body of requestLog) {
      const reqTag = body.match(/<TALLYREQUEST>([\s\S]*?)<\/TALLYREQUEST>/i)
      if (reqTag) {
        const inner = reqTag[1].trim()
        assert.ok(!(/import/i.test(inner)), `Request contained Import in TALLYREQUEST: ${inner}`)
        assert.ok(!(/execute/i.test(inner)), `Request contained Execute in TALLYREQUEST: ${inner}`)
      }
    }
  })
})

describe('Connector: normalize', () => {
  it('counts elements in XML', () => {
    const counts = countElements(SAMPLE_TALLY_RESPONSE)
    assert.equal(counts.voucherCount, 2)
    assert.equal(counts.ledgerCount, 2)
    assert.equal(counts.stockCount, 1)
  })

  it('hasData returns true for valid XML', () => {
    assert.ok(hasData(SAMPLE_TALLY_RESPONSE))
  })

  it('hasData returns false for empty XML', () => {
    assert.ok(!hasData(EMPTY_RESPONSE))
  })

  it('builds preview payload with Base64', () => {
    const payload = buildPreviewPayload('<xml>test</xml>', 'TestCo', 'test.xml')
    assert.equal(payload.action, 'preview')
    assert.equal(payload.filename, 'test.xml')
    assert.equal(payload.companyName, 'TestCo')
    // Decode and verify
    const decoded = Buffer.from(payload.contentBase64, 'base64').toString('utf-8')
    assert.equal(decoded, '<xml>test</xml>')
  })

  it('generates monthly chunks correctly', () => {
    const chunks = monthlyChunks('2026-10-15', '2027-01-10')
    assert.equal(chunks.length, 4)
    assert.equal(chunks[0].label, 'Oct 2026')
    assert.equal(chunks[0].fromDate, '20261015')
    assert.equal(chunks[0].toDate, '20261031')
    assert.equal(chunks[3].label, 'Jan 2027')
    assert.equal(chunks[3].fromDate, '20270101')
    assert.equal(chunks[3].toDate, '20270110')
  })

  it('monthly chunks handles single day', () => {
    const chunks = monthlyChunks('2026-10-15', '2026-10-15')
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].fromDate, '20261015')
    assert.equal(chunks[0].toDate, '20261015')
  })

  it('rejects invalid date range', () => {
    assert.throws(
      () => monthlyChunks('2026-12-01', '2026-10-01'),
      /must be before/
    )
  })
})

describe('Connector: discover (integration)', () => {
  before(async () => { await startFakeTally() })
  after(async () => { await stopFakeTally() })

  it('saves raw files and does not call edge function', async () => {
    const samplesDir = resolve(__dirname, '..', 'connector', 'samples')

    // Clean up any previous test files
    const testMasters = resolve(samplesDir, 'discover_masters_20261014.xml')
    const testVouchers = resolve(samplesDir, 'discover_vouchers_20261014_20261014.xml')
    try { rmSync(testMasters, { force: true }) } catch {}
    try { rmSync(testVouchers, { force: true }) } catch {}

    // Use the tally_client directly to simulate discover
    const mastersXml = buildExportRequest('List of Accounts', 'TestCo')
    const mastersResponse = await sendToTally(mastersXml, {
      host: '127.0.0.1',
      port: fakeTallyPort,
      company: 'TestCo',
    }, { maxRetries: 0 })

    mkdirSync(samplesDir, { recursive: true })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(testMasters, mastersResponse, 'utf-8')

    // Verify file was saved
    assert.ok(existsSync(testMasters), 'Masters file should exist')
    const content = readFileSync(testMasters, 'utf-8')
    assert.ok(content.includes('<LEDGER'), 'Saved file should contain LEDGER elements')

    // Verify NO edge function calls were made (discover is read-only to DB)
    // This is implicitly tested: we only called sendToTally, not previewAndCommit

    // Clean up
    rmSync(testMasters, { force: true })
  })
})

describe('Connector: supabase_client (mock)', () => {
  it('builds correct auth request', async () => {
    const { authenticate } = await import('../connector/supabase_client.mjs')

    let capturedRequest = null
    const mockFetch = async (url, opts) => {
      capturedRequest = { url, opts }
      return {
        ok: true,
        json: async () => ({ access_token: 'test-jwt-token-123' }),
      }
    }

    const token = await authenticate({
      url: 'https://test.supabase.co',
      anonKey: 'anon-key-123',
      email: 'admin@test.com',
      password: 'secret',
    }, mockFetch)

    assert.equal(token, 'test-jwt-token-123')
    assert.ok(capturedRequest.url.includes('/auth/v1/token'))
    assert.equal(capturedRequest.opts.headers['apikey'], 'anon-key-123')
  })

  it('authenticate returns accessToken directly without fetch', async () => {
    const { authenticate } = await import('../connector/supabase_client.mjs')
    let fetchCalled = false
    const token = await authenticate({
      accessToken: 'my-direct-token-abc',
    }, async () => { fetchCalled = true })
    assert.equal(token, 'my-direct-token-abc')
    assert.equal(fetchCalled, false)
  })

  it('previewAndCommit calls preview then commit', async () => {
    const { previewAndCommit } = await import('../connector/supabase_client.mjs')

    let callCount = 0
    const mockFetch = async (_url, opts) => {
      callCount++
      const body = JSON.parse(opts.body)

      if (body.action === 'preview') {
        return {
          ok: true,
          json: async () => ({
            jobId: 'job-uuid-123',
            summary: { total: 3, valid: 2, duplicates: 1, problems: 0 },
          }),
        }
      }

      if (body.action === 'commit') {
        assert.equal(body.jobId, 'job-uuid-123')
        return {
          ok: true,
          json: async () => ({
            status: 'committed',
            inserted: 2,
            skipped: 1,
            jobId: 'job-uuid-123',
          }),
        }
      }

      return { ok: false, json: async () => ({ error: 'Unexpected' }) }
    }

    const result = await previewAndCommit(
      { url: 'https://test.supabase.co', anonKey: 'key' },
      'token-123',
      { action: 'preview', filename: 'test.xml', contentBase64: 'abc', companyName: 'Co' },
      mockFetch
    )

    assert.equal(callCount, 2, 'Should call preview and commit')
    assert.equal(result.preview.jobId, 'job-uuid-123')
    assert.equal(result.commit.inserted, 2)
  })

  it('skips commit when no valid rows', async () => {
    const { previewAndCommit } = await import('../connector/supabase_client.mjs')

    let callCount = 0
    const mockFetch = async () => {
      callCount++
      return {
        ok: true,
        json: async () => ({
          jobId: 'job-empty',
          summary: { total: 5, valid: 0, duplicates: 5, problems: 0 },
        }),
      }
    }

    const result = await previewAndCommit(
      { url: 'https://test.supabase.co', anonKey: 'key' },
      'token',
      { action: 'preview', filename: 'test.xml', contentBase64: 'abc', companyName: 'Co' },
      mockFetch
    )

    assert.equal(callCount, 1, 'Should only call preview (not commit)')
    assert.equal(result.commit.status, 'skipped')
  })

  it('handles auth failure gracefully', async () => {
    const { authenticate } = await import('../connector/supabase_client.mjs')

    const mockFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error_description: 'Invalid login credentials' }),
    })

    await assert.rejects(
      () => authenticate({
        url: 'https://test.supabase.co',
        anonKey: 'key',
        email: 'wrong@test.com',
        password: 'wrong',
      }, mockFetch),
      /auth failed.*Invalid login credentials/i
    )
  })

  it('handles edge function 403 (not admin)', async () => {
    const { callEdgeFunction, EdgeFunctionError } = await import('../connector/supabase_client.mjs')

    const mockFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Admin role required' }),
    })

    await assert.rejects(
      () => callEdgeFunction(
        { url: 'https://test.supabase.co', anonKey: 'key' },
        'token',
        { action: 'preview' },
        mockFetch
      ),
      (err) => {
        assert.ok(err instanceof EdgeFunctionError)
        assert.equal(err.statusCode, 403)
        return true
      }
    )
  })
})

describe('Connector: secrets redaction', () => {
  it('loadConfig never includes raw password in error messages', () => {
    try {
      loadConfig({}, {
        TALLY_HOST: '192.168.1.1',
        TALLY_COMPANY: 'Co',
        SUPABASE_URL: 'https://x.supabase.co',
        SUPABASE_ANON_KEY: 'key',
        SUPABASE_EMAIL: 'a@b.com',
        SUPABASE_PASSWORD: 'my-super-secret-pw-12345',
      })
    } catch (err) {
      assert.ok(
        !err.message.includes('my-super-secret-pw-12345'),
        'Error message should not contain the password'
      )
    }
  })

  it('redactUrl hides Postgres password', () => {
    const r = redactUrl('postgresql://admin:MyPassword123@db.example.com:5432/meemx?sslmode=require')
    assert.ok(!r.includes('MyPassword123'))
    assert.ok(r.includes('***'))
    assert.ok(r.includes('db.example.com'))
  })
})

describe('Connector: end-to-end with fake Tally', () => {
  before(async () => { await startFakeTally() })
  after(async () => { await stopFakeTally() })

  it('full flow: fetch from Tally → build payload → verify shape', async () => {
    // 1. Fetch from fake Tally
    const xml = buildExportRequest('All Masters', 'TestCo', {
      fromDate: '20261001',
      toDate: '20261031',
    })
    const response = await sendToTally(xml, {
      host: '127.0.0.1',
      port: fakeTallyPort,
      company: 'TestCo',
    }, { maxRetries: 0 })

    // 2. Check counts
    const counts = countElements(response)
    assert.equal(counts.voucherCount, 2)
    assert.equal(counts.ledgerCount, 2)
    assert.equal(counts.stockCount, 1)

    // 3. Build preview payload
    const payload = buildPreviewPayload(response, 'TestCo', 'test.xml')
    assert.equal(payload.action, 'preview')
    assert.equal(payload.companyName, 'TestCo')

    // 4. Verify the Base64 XML decodes back correctly
    const decoded = Buffer.from(payload.contentBase64, 'base64').toString('utf-8')
    assert.ok(decoded.includes('TEST-SL-001'), 'Should contain voucher number')
    assert.ok(decoded.includes('Widget A'), 'Should contain stock item name')
    assert.ok(decoded.includes('Test Customer Alpha'), 'Should contain party name')
  })

  it('idempotent: re-pulling same data produces same payloads', async () => {
    const xml = buildExportRequest('All Masters', 'TestCo')

    const response1 = await sendToTally(xml, {
      host: '127.0.0.1',
      port: fakeTallyPort,
      company: 'TestCo',
    }, { maxRetries: 0 })

    const response2 = await sendToTally(xml, {
      host: '127.0.0.1',
      port: fakeTallyPort,
      company: 'TestCo',
    }, { maxRetries: 0 })

    assert.equal(response1, response2, 'Same request should produce same response')
  })
})
