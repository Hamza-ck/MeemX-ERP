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
 *
 * @param {SupabaseConfig} config
 * @param {string} accessToken
 * @param {string} [jobId]  UUID of the last committed import job
 * @param {Function} [fetchFn]
 */
export async function setLastSyncDate(config, accessToken, jobId, fetchFn = globalThis.fetch, at = new Date()) {
  const url = `${config.url}/rest/v1/accounting_refresh_state?id=eq.1`
  const body = {
    last_successful_import_at: at.toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (jobId) body.last_successful_import_job = jobId

  const res = await fetchFn(url, {
    method: 'PATCH',
    // return=representation lets us detect an RLS-blocked update (0 rows) instead of silently losing the cursor
    // (header below is replaced accordingly)
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'apikey': config.anonKey,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Could not save sync cursor (HTTP ${res.status})`)
  const updated = await res.json().catch(() => [])
  if (!Array.isArray(updated) || updated.length === 0) {
    throw new Error('Sync cursor was not saved (no row updated — is the account an admin?)')
  }
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
