/**
 * connector/normalize.mjs — Convert Tally's raw XML response into the payload
 * shape expected by the tally-import edge function.
 *
 * The edge function expects contentBase64 (Base64-encoded XML) and uses its own
 * XML parser. So the simplest and most reliable approach is:
 *   1. Ensure the XML is clean UTF-8 (tally_client.decodeTallyResponse handles this).
 *   2. Base64-encode the cleaned XML.
 *   3. Send it to the edge function as { action: 'preview', filename, contentBase64, companyName }.
 *
 * This module provides helpers for:
 *   - Extracting a rough count of vouchers/ledgers/stock items from the XML (for progress logging)
 *   - Chunking voucher requests by month
 *   - Building the edge function payload
 */

import { createHash } from 'node:crypto'

/**
 * Count elements in Tally XML response (rough estimate for logging).
 * Uses simple regex — no full XML parse needed.
 */
export function countElements(xmlText) {
  const voucherCount = (xmlText.match(/<VOUCHER[\s>]/gi) || []).length
  const ledgerCount = (xmlText.match(/<LEDGER[\s>]/gi) || []).length
  const stockCount = (xmlText.match(/<STOCKITEM[\s>]/gi) || []).length
  const stockSummaryCount = (xmlText.match(/<DSPSTKINFO[\s>]/gi) || []).length
  return { voucherCount, ledgerCount, stockCount, stockSummaryCount }
}

/**
 * Check if the XML response looks like it contains data.
 * An empty export may contain <TALLYMESSAGE> but no child elements.
 */
export function hasData(xmlText) {
  return /<(VOUCHER|LEDGER|STOCKITEM|DSPSTKINFO)[\s>]/i.test(xmlText)
}

/**
 * Ensure voucher numbers are uniquely prefixed with voucher type (e.g. Sales-1 vs Receipt-1)
 * so that vouchers of different types with the same sequence number do not clash.
 */
export function prefixVoucherNumbers(xmlText) {
  return xmlText.replace(/<VOUCHER\b([\s\S]*?)<\/VOUCHER>/gi, (match) => {
    const typeMatch = match.match(/<VOUCHERTYPENAME[^>]*>([^<]+)<\/VOUCHERTYPENAME>/i) ||
                      match.match(/<VOUCHERTYPE[^>]*>([^<]+)<\/VOUCHERTYPE>/i) ||
                      match.match(/VCHTYPE=["']([^"']+)["']/i)
    const type = typeMatch ? typeMatch[1].trim() : 'Vch'

    if (/<VOUCHERNUMBER\b[^>]*>([^<]+)<\/VOUCHERNUMBER>/i.test(match)) {
      return match.replace(/<VOUCHERNUMBER(\b[^>]*)>([^<]+)<\/VOUCHERNUMBER>/i, (m, attrs, num) => {
        const trimmed = num.trim()
        if (trimmed.toLowerCase().startsWith(type.toLowerCase() + '-')) {
          return m
        }
        return `<VOUCHERNUMBER${attrs}>${type}-${trimmed}</VOUCHERNUMBER>`
      })
    } else if (/<MASTERID\b[^>]*>([^<]+)<\/MASTERID>/i.test(match)) {
      return match.replace(/<MASTERID(\b[^>]*)>([^<]+)<\/MASTERID>/i, (m, attrs, id) => {
        return `<VOUCHERNUMBER${attrs}>${type}-${id.trim()}</VOUCHERNUMBER><MASTERID${attrs}>${id}</MASTERID>`
      })
    }
    return match
  })
}

/**
 * Build the edge function preview payload.
 *
 * @param {string} xmlText     Clean UTF-8 XML from Tally
 * @param {string} company     Company name
 * @param {string} [filename]  Synthetic filename for the edge function
 * @returns {{ action: string, filename: string, contentBase64: string, companyName: string }}
 */
export function buildPreviewPayload(xmlText, company, filename, extra = {}) {
  const normalizedXml = prefixVoucherNumbers(xmlText)
  const contentBase64 = Buffer.from(normalizedXml, 'utf-8').toString('base64')
  return {
    action: 'preview',
    filename: filename || `tally-connector-${Date.now()}.xml`,
    contentBase64,
    companyName: company,
    // extra.window = { from, to } (YYYY-MM-DD) lets the server tombstone vouchers deleted in Tally.
    // extra.groups = { groupName: parentName } resolves sub-groups of Sundry Debtors etc.
    ...extra,
  }
}

const decodeEntities = (text) => text
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#0*4;/g, '').replace(/&amp;/g, '&')

/** Build { groupName: parentName } from a Tally "List of Groups" export. */
export function extractGroupParents(xmlText) {
  const groups = {}
  for (const match of xmlText.matchAll(/<GROUP\b([^>]*)>([\s\S]*?)<\/GROUP>/gi)) {
    const nameAttr = match[1].match(/NAME="([^"]*)"/i)
    const name = nameAttr ? decodeEntities(nameAttr[1]).trim() : ''
    if (!name) continue
    const parent = match[2].match(/<PARENT[^>]*>([^<]*)<\/PARENT>/i)
    groups[name] = parent ? decodeEntities(parent[1]).trim() : ''
  }
  return groups
}

const toDate = (ymd) => new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)))
const toYmd = (date) => date.toISOString().slice(0, 10).replace(/-/g, '')
export const ymdToIso = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`

/** Split a YYYYMMDD range into two halves (null when it is already a single day). */
export function splitRange(fromYmd, toYmdValue) {
  const from = toDate(fromYmd), to = toDate(toYmdValue)
  const days = Math.round((to - from) / 86_400_000)
  if (days < 1) return null
  const mid = new Date(from.getTime() + Math.floor(days / 2) * 86_400_000)
  return [
    { fromDate: fromYmd, toDate: toYmd(mid) },
    { fromDate: toYmd(new Date(mid.getTime() + 86_400_000)), toDate: toYmdValue },
  ]
}

/**
 * Compute SHA-256 hash of content (for dedup/logging).
 */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Generate monthly date ranges between fromDate and toDate.
 * Each chunk: { fromDate: 'YYYYMMDD', toDate: 'YYYYMMDD', label: 'Oct 2026' }
 *
 * @param {string} fromDateStr  'YYYY-MM-DD'
 * @param {string} toDateStr    'YYYY-MM-DD'
 * @returns {Array<{ fromDate: string, toDate: string, label: string }>}
 */
export function monthlyChunks(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr + 'T00:00:00')
  const to = new Date(toDateStr + 'T00:00:00')
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    throw new Error(`Invalid date range: ${fromDateStr} → ${toDateStr}`)
  }
  if (from > to) {
    throw new Error(`--from (${fromDateStr}) must be before --to (${toDateStr})`)
  }

  const chunks = []
  let cursor = new Date(from)

  while (cursor <= to) {
    const chunkStart = new Date(cursor)
    // End of month or toDate, whichever is earlier
    const endOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0) // last day of month
    const chunkEnd = endOfMonth < to ? endOfMonth : new Date(to)

    const fmtDate = (d) =>
      String(d.getFullYear()) +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0')

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const label = monthNames[chunkStart.getMonth()] + ' ' + chunkStart.getFullYear()

    chunks.push({
      fromDate: fmtDate(chunkStart),
      toDate: fmtDate(chunkEnd),
      label,
    })

    // Move to first day of next month
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
  }

  return chunks
}
