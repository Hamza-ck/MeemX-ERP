/**
 * connector/state.mjs — small local state: payload hashes (skip unchanged uploads),
 * the date of the last full reconcile, and a lock that prevents overlapping runs
 * (Task Scheduler + --loop, or two scheduled instances, must never run together).
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const STATE_FILE = resolve(__dirname, '.sync-state.json')
export const LOCK_FILE = resolve(__dirname, '.sync.lock')
const STALE_LOCK_MS = 30 * 60 * 1000

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function loadState(file = STATE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'))
    return { lastFullSyncDate: parsed.lastFullSyncDate || null, hashes: parsed.hashes || {}, pushedAt: parsed.pushedAt || {}, lastPnlAt: parsed.lastPnlAt || null }
  } catch {
    return { lastFullSyncDate: null, hashes: {}, pushedAt: {}, lastPnlAt: null }
  }
}

export function saveState(state, file = STATE_FILE) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8')
}

/**
 * Take the run lock. Returns a release() function, or null when another live run holds it.
 * A lock older than 30 minutes is treated as left over from a crash.
 */
export function acquireLock(file = LOCK_FILE, now = Date.now()) {
  if (existsSync(file)) {
    try {
      const held = JSON.parse(readFileSync(file, 'utf-8'))
      if (now - Number(held.startedAt) < STALE_LOCK_MS) return null
    } catch { /* unreadable lock = stale */ }
  }
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: now }), 'utf-8')
  return () => { try { unlinkSync(file) } catch { /* already gone */ } }
}

/** First day of the financial year containing `date` (India default: 1 April). */
export function financialYearStart(date, startMonth = 4) {
  const year = date.getMonth() + 1 >= startMonth ? date.getFullYear() : date.getFullYear() - 1
  return `${year}-${String(startMonth).padStart(2, '0')}-01`
}
