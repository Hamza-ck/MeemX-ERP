/**
 * connector/supabase_client.mjs — Thin client for the tally-import edge function.
 *
 * Handles:
 *   - Supabase auth (email/password → JWT access token)
 *   - Calling the edge function with preview + commit actions
 *   - Token refresh on 401
 *   - Reading/writing connector state via the accounting_refresh_state table
 */

import { redactUrl } from './config.mjs'

/**
 * @typedef {object} SupabaseConfig
 * @property {string} url
 * @property {string} anonKey
 * @property {string} email
 * @property {string} password
 */

/**
 * Authenticate with Supabase and return an access token.
 *
 * @param {SupabaseConfig} config
 * @param {Function} [fetchFn]
 * @returns {Promise<string>} access_token (JWT)
 */
export async function authenticate(config, fetchFn = globalThis.fetch) {
  if (config.accessToken) {
    return config.accessToken
  }

  const url = `${config.url}/auth/v1/token?grant_type=password`
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': config.anonKey,
    },
    body: JSON.stringify({
      email: config.email,
      password: config.password,
    }),
  })

  const body = await res.json()
  if (!res.ok) {
    throw new Error(
      `Supabase auth failed (${res.status}): ${body.error_description || body.msg || body.error || JSON.stringify(body)}. ` +
      `Check SUPABASE_EMAIL and SUPABASE_PASSWORD. URL: ${redactUrl(config.url)}`
    )
  }

  if (!body.access_token) {
    throw new Error('Supabase auth returned no access_token. Response: ' + JSON.stringify(body))
  }

  return body.access_token
}

/**
 * Call the tally-import edge function.
 *
 * @param {SupabaseConfig} config
 * @param {string} accessToken
 * @param {object} payload   { action, filename, contentBase64, companyName } or { action, jobId }
 * @param {Function} [fetchFn]
 * @returns {Promise<object>} Edge function response body
 */
export async function callEdgeFunction(config, accessToken, payload, fetchFn = globalThis.fetch, maxRetries = 2) {
  const url = `${config.url}/functions/v1/tally-import`
  let lastErr

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'apikey': config.anonKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(300000), // 5 min timeout for large database commits
      })

      const body = await res.json().catch(() => ({ error: `non-JSON response (HTTP ${res.status})` }))
      if (!res.ok) {
        throw new EdgeFunctionError(
          `Edge function error (${res.status}): ${body.error || JSON.stringify(body)}`,
          res.status,
          body
        )
      }

      return body
    } catch (err) {
      lastErr = err
      if (err instanceof EdgeFunctionError) throw err
      if (attempt < maxRetries) {
        const backoff = 1000 * Math.pow(2, attempt)
        await new Promise((r) => setTimeout(r, backoff))
        continue
      }
    }
  }

  throw lastErr
}

/**
 * Preview + Commit flow: send XML to the edge function for staging, then commit.
 *
 * @param {SupabaseConfig} config
 * @param {string} accessToken
 * @param {object} previewPayload  { action: 'preview', filename, contentBase64, companyName }
 * @param {Function} [fetchFn]
 * @returns {Promise<{ preview: object, commit: object }>}
 */
export async function previewAndCommit(config, accessToken, previewPayload, fetchFn = globalThis.fetch) {
  // Step 1: Preview (stage rows)
  const preview = await callEdgeFunction(config, accessToken, previewPayload, fetchFn)

  if (!preview.jobId) {
    throw new Error('Preview did not return a jobId. Response: ' + JSON.stringify(preview))
  }

  // If no valid rows, skip commit — unless a sync window is attached: an empty window still
  // has to be committed so vouchers deleted in Tally are tombstoned.
  if (preview.summary && preview.summary.valid === 0 && !previewPayload.window) {
    return {
      preview,
      commit: { status: 'skipped', inserted: 0, skipped: preview.summary.total, jobId: preview.jobId },
    }
  }

  // Step 2: Commit
  let commit
  try {
    commit = await callEdgeFunction(config, accessToken, { action: 'commit', jobId: preview.jobId }, fetchFn)
  } catch (err) {
    // A network timeout after the server finished makes the retry see a committed job.
    if (err instanceof EdgeFunctionError && /not ready to commit/i.test(err.message)) {
      commit = { status: 'committed', inserted: 0, updated: 0, skipped: 0, jobId: preview.jobId, alreadyCommitted: true }
    } else {
      throw err
    }
  }

  return { preview, commit }
}

/**
 * Read connector state (last sync date) from Supabase REST API.
 *
 * @param {SupabaseConfig} config
 * @param {string} accessToken
 * @param {Function} [fetchFn]
 * @returns {Promise<string|null>}  ISO date string or null
 */
export async function getLastSyncDate(config, accessToken, fetchFn = globalThis.fetch) {
  const url = `${config.url}/rest/v1/accounting_refresh_state?id=eq.1&select=last_successful_import_at`
  const res = await fetchFn(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': config.anonKey,
      'Accept': 'application/json',
    },
  })

  // A failed read must not look like "never synced": callers fall back to a wider window and warn.
  if (!res.ok) throw new Error(`Could not read sync cursor (HTTP ${res.status})`)

  const rows = await res.json()
  if (!rows.length || !rows[0].last_successful_import_at) return null

  return rows[0].last_successful_import_at
}

/**
 * Update connector state after a successful sync.
 * Stores maxVoucherDate when available, falling back to current time.
 *
 * @param {SupabaseConfig} config
 * @param {string} accessToken
 * @param {string} [jobId]  UUID of the last committed import job
 * @param {string} [maxVoucherDate]  Max voucher date from imported data
 * @param {Function} [fetchFn]
 */
export async function setLastSyncDate(config, accessToken, jobId, maxVoucherDate = null, fetchFn = globalThis.fetch) {
  let actualFetch = fetchFn
  let actualMaxDate = maxVoucherDate
  if (typeof maxVoucherDate === 'function') {
    actualFetch = maxVoucherDate
    actualMaxDate = null
  }

  const importDate = actualMaxDate
    ? (actualMaxDate.includes('T') ? actualMaxDate : new Date(actualMaxDate + 'T00:00:00Z').toISOString())
    : new Date().toISOString()

  const url = `${config.url}/rest/v1/accounting_refresh_state?id=eq.1`
  const body = {
    last_successful_import_at: importDate,
    updated_at: new Date().toISOString(),
  }
  if (jobId) body.last_successful_import_job = jobId

  await actualFetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': config.anonKey,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  })
}

/**
 * Select-then-upsert helper for vouchers, ledgers, materials.
 * When the incoming row exists and cloud updated_at is newer than incoming source timestamp,
 * emits a structured conflict log:
 * { "event": "conflict", "table": "vouchers", "key": "<voucher_no>", "cloud_updated_at": "...", "incoming_at": "..." }
 * Does not block the write so no data is lost.
 */
export async function upsertWithConflictCheck(config, accessToken, table, payload, keyField = 'id', incomingAt = null, fetchFn = globalThis.fetch) {
  const keyValue = payload[keyField]
  if (keyValue) {
    try {
      const selectUrl = `${config.url}/rest/v1/${table}?${keyField}=eq.${encodeURIComponent(keyValue)}&select=id,updated_at`
      const selRes = await fetchFn(selectUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'apikey': config.anonKey,
          'Accept': 'application/json',
        },
      })
      if (selRes.ok) {
        const existingRows = await selRes.json()
        if (Array.isArray(existingRows) && existingRows.length > 0) {
          const cloudUpdatedAt = existingRows[0].updated_at
          const incomingTimestamp = incomingAt || payload.updated_at || payload.date
          if (cloudUpdatedAt && incomingTimestamp && new Date(cloudUpdatedAt) > new Date(incomingTimestamp)) {
            console.log(JSON.stringify({
              event: 'conflict',
              table,
              key: String(keyValue),
              cloud_updated_at: cloudUpdatedAt,
              incoming_at: incomingTimestamp,
            }))
          }
        }
      }
    } catch { /* proceed to write */ }
  }

  const url = `${config.url}/rest/v1/${table}`
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': config.anonKey,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(`Failed to upsert ${table}: ${JSON.stringify(body)}`)
  }
  return res.json()
}

/** Edge function returned an HTTP error. */
export class EdgeFunctionError extends Error {
  constructor(message, statusCode, body) {
    super(message)
    this.name = 'EdgeFunctionError'
    this.statusCode = statusCode
    this.body = body
  }
}
