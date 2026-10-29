/**
 * connector/config.mjs — Configuration for the Tally connector.
 *
 * Sources (highest priority first):
 *   1. CLI flags (--tally-host, --tally-port, --tally-company, --allow-remote)
 *   2. Environment variables (TALLY_HOST, TALLY_PORT, TALLY_COMPANY, SUPABASE_URL, etc.)
 *   3. connector/.env file (loaded manually, git-ignored)
 *   4. Root .env for shared Vite Supabase settings (loaded without printing values)
 *
 * Security:
 *   - TALLY_HOST must be loopback unless --allow-remote is passed.
 *   - Supabase URL without HTTPS prints a warning.
 *   - Secrets (SUPABASE_SERVICE_ROLE_KEY, passwords) are never logged.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/**
 * Load a .env file into a plain object (no process.env mutation).
 * Supports KEY=VALUE and KEY="VALUE" (strips outer quotes).
 */
function loadDotEnv(filePath) {
  const vars = {}
  if (!existsSync(filePath)) return vars
  const lines = readFileSync(filePath, 'utf-8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx < 1) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    // Strip surrounding quotes or handle inline comment
    if ((value.startsWith('"') && value.includes('"', 1)) ||
        (value.startsWith("'") && value.includes("'", 1))) {
      const q = value[0]
      const endQ = value.indexOf(q, 1)
      value = value.slice(1, endQ)
    } else {
      const hashIdx = value.indexOf('#')
      if (hashIdx >= 0) value = value.slice(0, hashIdx).trim()
    }
    vars[key] = value
  }
  return vars
}

/**
 * Redact passwords/keys in a URL for safe logging.
 * postgres://user:s3cret@host → postgres://user:***@host
 */
export function redactUrl(raw) {
  if (!raw) return '(not set)'
  try {
    const u = new URL(raw)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    // Not a valid URL — redact anything after key= or password=
    return raw.replace(/(password|key|secret|token)=([^&\s]+)/gi, '$1=***')
  }
}

/**
 * Build and validate configuration.
 *
 * @param {object} cliFlags  Parsed CLI flags
 * @param {object} [envOverride]  Override for process.env (testing)
 * @returns {{ tally: { host, port, company }, supabase: { url, anonKey, email, password }, allowRemote: boolean }}
 */
export function loadConfig(cliFlags = {}, envOverride = null) {
  // 1. Load connector/.env (only when envOverride is not provided)
  const dotEnv = envOverride ? {} : loadDotEnv(resolve(__dirname, '.env'))
  const rootEnv = envOverride ? {} : loadDotEnv(resolve(__dirname, '../.env'))

  // 2. Merge: CLI > process environment > connector .env > root .env
  const env = envOverride || process.env
  const get = (key) => cliFlags[key] ?? env[key] ?? dotEnv[key] ?? rootEnv[key] ?? ''

  let host = get('TALLY_HOST') || '127.0.0.1'
  host = host.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim()
  if (host.includes(':') && !host.startsWith('[')) {
    const parts = host.split(':')
    host = parts[0]
  }
  const port = parseInt(get('TALLY_PORT') || '9000', 10)
  const company = get('TALLY_COMPANY')
  const allowRemote = !!cliFlags.allowRemote

  const supabaseUrl = get('SUPABASE_URL') || get('VITE_SUPABASE_URL')
  const supabaseAnonKey = get('SUPABASE_ANON_KEY') || get('VITE_SUPABASE_ANON_KEY') || get('VITE_SUPABASE_PUBLISHABLE_KEY')
  const supabaseEmail = get('SUPABASE_EMAIL') || get('VITE_SUPABASE_EMAIL')
  const supabasePassword = get('SUPABASE_PASSWORD') || get('VITE_SUPABASE_PASSWORD')
  const supabaseAccessToken = get('SUPABASE_ACCESS_TOKEN')

  // --- Validation ---
  const errors = []

  // Loopback check
  if (!LOOPBACK.has(host.toLowerCase()) && !allowRemote) {
    errors.push(
      `TALLY_HOST="${host}" is not a loopback address. ` +
      'Tally has NO authentication — connecting to a remote host exposes it to the network. ' +
      'Pass --allow-remote to override (NOT recommended).'
    )
  }

  // Supabase config
  if (!supabaseUrl) errors.push('SUPABASE_URL is required.')
  if (!supabaseAnonKey) errors.push('SUPABASE_ANON_KEY is required.')
  if (!supabaseAccessToken) {
    if (!supabaseEmail) errors.push('SUPABASE_EMAIL is required (admin email for auth, or provide SUPABASE_ACCESS_TOKEN).')
    if (!supabasePassword) errors.push('SUPABASE_PASSWORD is required (admin password, or provide SUPABASE_ACCESS_TOKEN).')
  }

  if (errors.length) {
    const msg = 'Configuration errors:\n  • ' + errors.join('\n  • ')
    throw new Error(msg)
  }

  // --- Warnings ---
  if (!LOOPBACK.has(host.toLowerCase()) && allowRemote) {
    console.warn(
      '\n⚠️  WARNING: Connecting to non-loopback Tally host ' + host + ':' + port + '\n' +
      '   Tally\'s HTTP port has NO authentication or encryption.\n' +
      '   Anyone on the network can read and write your accounting data.\n' +
      '   Use this ONLY in trusted private networks.\n'
    )
  }

  if (supabaseUrl && !supabaseUrl.startsWith('https://')) {
    console.warn('⚠️  SUPABASE_URL does not use HTTPS — data in transit is unencrypted.')
  }

  return {
    tally: { host, port, company },
    supabase: {
      url: supabaseUrl,
      anonKey: supabaseAnonKey,
      email: supabaseEmail,
      password: supabasePassword,
      accessToken: supabaseAccessToken,
    },
    allowRemote,
  }
}
