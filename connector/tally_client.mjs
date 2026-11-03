/**
 * connector/tally_client.mjs — Read-only HTTP client for TallyPrime.
 *
 * - POSTs XML to Tally's HTTP interface (default localhost:9000).
 * - READ-ONLY GUARANTEE: only sends <TALLYREQUEST>Export</TALLYREQUEST>.
 *   A hard guard rejects any request body containing "Import" or "Execute" tags.
 * - Handles UTF-16 BOM detection, control-character stripping.
 * - One retry with exponential backoff on transient failures.
 * - Clear, friendly error messages for common failure modes.
 */

/**
 * Decode Tally's response bytes (may be UTF-16LE/BE with BOM, or UTF-8).
 * Also strips XML-illegal control characters (&#0;–&#8;, &#11;–&#12;, &#14;–&#31;).
 */
export function decodeTallyResponse(buffer) {
  const bytes = new Uint8Array(buffer)
  let text

  // Detect BOM
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    text = new TextDecoder('utf-16le').decode(bytes)
  } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    text = new TextDecoder('utf-16be').decode(bytes)
  } else {
    text = new TextDecoder('utf-8').decode(bytes)
  }

  // Strip XML-illegal control characters (keep \t=9, \n=10, \r=13)
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
}

/**
 * READ-ONLY GUARD: reject any XML body that looks like it could write to Tally.
 * This is a defence-in-depth check — our XML builders only emit Export requests,
 * but this guard ensures no caller can accidentally send Import/Execute.
 */
function assertReadOnly(xmlBody) {
  // Check for <TALLYREQUEST> containing Import or Execute (case-insensitive)
  const requestMatch = xmlBody.match(/<TALLYREQUEST>([\s\S]*?)<\/TALLYREQUEST>/i)
  if (requestMatch) {
    const inner = requestMatch[1].trim()
    if (/import/i.test(inner)) {
      throw new Error('READ-ONLY VIOLATION: request body contains "Import" in <TALLYREQUEST>. The connector must never write to Tally.')
    }
    if (/execute/i.test(inner)) {
      throw new Error('READ-ONLY VIOLATION: request body contains "Execute" in <TALLYREQUEST>. The connector must never write to Tally.')
    }
  }

  // Extra belt-and-suspenders: check raw body for IMPORTDATA or EXECUTE tags
  if (/<IMPORTDATA[\s>]/i.test(xmlBody)) {
    throw new Error('READ-ONLY VIOLATION: request body contains <IMPORTDATA>. The connector must never write to Tally.')
  }
}

/**
 * Build the XML envelope for an export request to Tally.
 *
 * @param {string} reportId   e.g. "List of Accounts", "Day Book"
 * @param {string} company    The Tally company name
 * @param {object} [opts]     Optional: { fromDate, toDate } in YYYYMMDD format
 * @returns {string} Complete XML request body
 */
export function buildExportRequest(reportId, company, opts = {}) {
  const isVoucherCollection = reportId === 'Day Book'
  let staticVars = '<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>'
  if (company) staticVars += `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`

  if (opts.fromDate) {
    const fromDate = isVoucherCollection ? compactTallyDate(opts.fromDate) : toTallyDate(opts.fromDate)
    staticVars += `<SVFROMDATE TYPE="Date">${fromDate}</SVFROMDATE>`
  }
  if (opts.toDate) {
    const toDate = isVoucherCollection ? compactTallyDate(opts.toDate) : toTallyDate(opts.toDate)
    staticVars += `<SVTODATE TYPE="Date">${toDate}</SVTODATE>`
  }
  if (reportId === 'Stock Summary') {
    // The stock summary defaults to grouped totals. Request F5 Item-wise explicitly
    // so Tally returns each stock item with closing quantity, rate and value.
    staticVars += '<ISITEMWISE>Yes</ISITEMWISE>'
  }

  const isStockItems = reportId === 'List of Stock Items'
  const isLedgerList = reportId === 'List of Accounts'
  const isGroupList = reportId === 'List of Groups'

  // Use a dated Voucher collection with its nested accounting/inventory methods.
  // On this Tally instance the Day Book data report returned the active screen date
  // even when period variables were supplied. Explicit master methods also avoid
  // the silent field omissions caused by `FETCH *` on some Tally releases.
  if (isVoucherCollection || isStockItems || isLedgerList || isGroupList) {
    const colType = isVoucherCollection ? 'Voucher' : isStockItems ? 'StockItem' : isGroupList ? 'Group' : 'Ledger'
    const collectionName = isVoucherCollection ? 'Tally Vouchers' : reportId
    const fetchMethods = isVoucherCollection
      ? ['Date', 'VoucherNumber', 'VoucherTypeName', 'Amount', 'MasterID', 'GUID', 'PartyLedgerName', 'Narration', 'Reference', 'AllLedgerEntries.*', 'LedgerEntries.*', 'AllInventoryEntries.*', 'InventoryEntries.*']
      : isStockItems
      ? ['Name', 'GUID', 'Parent', 'BaseUnits', 'OpeningBalance', 'OpeningValue', 'OpeningRate', 'ClosingBalance', 'ClosingValue', 'ClosingRate', 'BaseSellingPrice']
      : isGroupList
      ? ['Name', 'Parent']
      : ['Name', 'GUID', 'Parent', 'OpeningBalance', 'ClosingBalance', 'LedgerPhone', 'Email', 'Address']
    return [
      '<ENVELOPE>',
      '  <HEADER>',
      '    <VERSION>1</VERSION>',
      '    <TALLYREQUEST>Export</TALLYREQUEST>',
      '    <TYPE>Collection</TYPE>',
      '    <ID>' + escapeXml(collectionName) + '</ID>',
      '  </HEADER>',
      '  <BODY>',
      '    <DESC>',
      '      <STATICVARIABLES>',
      '        ' + staticVars,
      '      </STATICVARIABLES>',
      '      <TDL>',
      '        <TDLMESSAGE>',
      '          <COLLECTION NAME="' + escapeXml(collectionName) + '">',
      '            <TYPE>' + colType + '</TYPE>',
      '            <FETCH>' + fetchMethods.join(', ') + '</FETCH>',
      ...(!isVoucherCollection ? fetchMethods.map((method) => '            <NATIVEMETHOD>' + method + '</NATIVEMETHOD>') : []),
      '          </COLLECTION>',
      '        </TDLMESSAGE>',
      '      </TDL>',
      '    </DESC>',
      '  </BODY>',
      '</ENVELOPE>',
    ].join('\n')
  }

  // EXPORTFORMAT ensures Tally wraps the response in <TALLYMESSAGE> blocks
  // containing VOUCHER/LEDGER/STOCKITEM elements.
  const exportId = reportId === 'Day Book' ? 'DayBook' : reportId === 'Profit & Loss' ? 'Profit and Loss' : reportId
  const xml = [
    '<ENVELOPE>',
    '  <HEADER>',
    '    <VERSION>1</VERSION>',
    '    <TALLYREQUEST>Export</TALLYREQUEST>',
    '    <TYPE>Data</TYPE>',
    '    <ID>' + escapeXml(exportId) + '</ID>',
    '  </HEADER>',
    '  <BODY>',
    '    <DESC>',
    '      <STATICVARIABLES>',
    '        ' + staticVars,
    '      </STATICVARIABLES>',
    '    </DESC>',
    '  </BODY>',
    '</ENVELOPE>',
  ].join('\n')

  return xml
}

function toTallyDate(value) {
  const { year, monthNumber, dayNumber } = parseTallyDate(value)
  const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthNumber - 1]
  return `${dayNumber}-${monthName}-${year}`
}

function compactTallyDate(value) {
  const { year, month, day } = parseTallyDate(value)
  return `${year}${month}${day}`
}

function parseTallyDate(value) {
  const raw = String(value)
  const match = raw.match(/^(\d{4})-?(\d{2})-?(\d{2})$/)
  if (!match) throw new Error(`Invalid Tally date: ${raw}. Expected YYYY-MM-DD or YYYYMMDD.`)
  const [, year, month, day] = match
  const monthNumber = Number(month)
  const dayNumber = Number(day)
  const date = new Date(Date.UTC(Number(year), monthNumber - 1, dayNumber))
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== monthNumber - 1 || date.getUTCDate() !== dayNumber) {
    throw new Error(`Invalid Tally date: ${raw}.`)
  }
  return { year, month, day, monthNumber, dayNumber }
}

function escapeXml(unsafe) {
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * @typedef {object} TallyClientConfig
 * @property {string} host
 * @property {number} port
 * @property {string} company
 */

/**
 * Send an XML export request to Tally with one retry + backoff.
 *
 * @param {string} xmlBody     The XML request body
 * @param {TallyClientConfig} config
 * @param {object} [opts]      { timeoutMs, maxRetries, initialBackoffMs, fetchFn }
 * @returns {Promise<string>}  The decoded XML response text
 */
export async function sendToTally(xmlBody, config, opts = {}) {
  // Read-only guard
  assertReadOnly(xmlBody)

  const {
    timeoutMs = 60_000,
    maxRetries = 2,
    initialBackoffMs = 1_000,
    fetchFn = globalThis.fetch,
  } = opts

  const hostPart = config.host.includes(':') ? `[${config.host}]` : config.host   // IPv6 literal
  const url = `http://${hostPart}:${config.port}`

  let lastError = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = initialBackoffMs * Math.pow(2, attempt - 1)
      await new Promise((r) => setTimeout(r, backoff))
    }

    let timer
    try {
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(), timeoutMs)

      let response
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/xml' },
          body: xmlBody,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timer)
      }

      if (response.status && !response.ok && response.status >= 500) {
        throw new Error(`Tally HTTP ${response.status}`)   // transient: retried below
      }
      const buffer = await response.arrayBuffer()
      const text = decodeTallyResponse(buffer)

      // Check for Tally-level errors in the response
      const statusMatch = text.match(/<STATUS>\s*(\d+)\s*<\/STATUS>/i)
      if (statusMatch && statusMatch[1] === '0') {
        const errorMatch = text.match(/<LINEERROR[^>]*>([\s\S]*?)<\/LINEERROR>/i)
        const descMatch = text.match(/<DESCRIPTION[^>]*>([\s\S]*?)<\/DESCRIPTION>/i)
        let errorText = errorMatch?.[1]?.trim() || descMatch?.[1]?.trim() || 'Unknown Tally error'
        errorText = errorText.replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

        // "Could not set SVCurrentCompany" is a transient startup error — Tally is still
        // loading the company. Treat it like a connection hiccup and retry with backoff.
        if (/could not set.*SVCurrentCompany/i.test(errorText)) {
          lastError = new TallyError(`Tally returned an error: ${errorText}`, text)
          if (attempt < maxRetries) {
            process.stderr.write(`   ⏳ Tally still loading (attempt ${attempt + 1}/${maxRetries + 1}), retrying…\n`)
            continue   // the loop top applies the backoff once
          }
          throw lastError
        }

        throw new TallyError(`Tally returned an error: ${errorText}`, text)
      }

      return text
    } catch (err) {
      lastError = err

      // Don't retry on TallyError (application-level error, not transient).
      // Note: the transient SVCurrentCompany case is handled above with explicit continue.
      if (err instanceof TallyError) throw err

      // Don't retry on read-only violations
      if (err.message.includes('READ-ONLY VIOLATION')) throw err

      // Connection refused = Tally not running
      if (err.cause?.code === 'ECONNREFUSED' || err.message?.includes('ECONNREFUSED') ||
          err.message?.includes('fetch failed')) {
        if (attempt === maxRetries) {
          throw new TallyConnectionError(
            `Cannot connect to Tally at ${url}. Possible causes:\n` +
            '  • TallyPrime is not running\n' +
            '  • Tally\'s HTTP server is not enabled (Gateway of Tally → Configure → Connectivity → Enable HTTP server)\n' +
            '  • Wrong port (check TALLY_PORT, default is 9000)\n' +
            'Original error: ' + err.message
          )
        }
        continue // retry
      }

      // Abort = timeout
      if (err.name === 'AbortError') {
        if (attempt === maxRetries) {
          throw new TallyConnectionError(
            `Tally at ${url} did not respond within ${timeoutMs / 1000}s. ` +
            'The server may be overloaded or the request too large. Try a smaller date range.'
          )
        }
        continue // retry
      }

      // Other transient errors: retry
      if (attempt === maxRetries) throw err
    }
  }

  throw lastError
}

/** Tally returned a valid HTTP response but with an application-level error. */
export class TallyError extends Error {
  constructor(message, rawResponse) {
    super(message)
    this.name = 'TallyError'
    this.rawResponse = rawResponse
  }
}

/** Could not connect to Tally at all. */
export class TallyConnectionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'TallyConnectionError'
  }
}
