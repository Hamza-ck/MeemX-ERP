import { createClient } from 'npm:@supabase/supabase-js@2'
import { XMLParser, XMLValidator } from 'npm:fast-xml-parser@4'
import * as XLSX from 'npm:xlsx@0.18.5'
import {
  parseTallyXml, classifyVoucherType, normalDate, signedAmount, val, digest,
} from './parser.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
// Tally day-ranges are split by the connector well below this; the cap only guards the function.
const MAX_BYTES = 8 * 1024 * 1024
const rowMessages = (row) => {
  const messages = []
  if (!row.payload?.name && ['ledger','party','stock_item'].includes(row.rowType)) messages.push('Master name is missing')
  if (row.rowType === 'voucher') {
    if (!row.payload?.voucher_no) messages.push('Voucher number is missing')
    if (!row.payload?.date) messages.push('Date is missing or invalid')
    if (!row.payload?.voucher_type) messages.push('Voucher type is not supported')
    if (!Number.isFinite(Number(row.payload?.amount)) || Number(row.payload.amount) <= 0) messages.push('Voucher amount is missing or zero')
  }
  return messages
}

async function parseSheet(bytes, company) {
  const workbook = XLSX.read(bytes, { type: 'array', cellDates: true })
  const firstSheet = workbook.SheetNames[0]
  if (!firstSheet) throw new Error('Spreadsheet contains no worksheet.')
  const records = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet], { defval: '', raw: false })
  const rows = []
  for (const record of records) {
    const header = {}
    for (const [key, value] of Object.entries(record)) header[String(key).toLowerCase().replace(/[^a-z0-9]/g, '')] = value
    const get = (pattern) => Object.entries(header).find(([key]) => pattern.test(key))?.[1] ?? ''
    const rawAmount = get(/^amount$|^totalamount$|voucheramount/)
    const debit = get(/^debitamount$|^debit$/)
    const credit = get(/^creditamount$|^credit$/)
    const amount = Math.abs(signedAmount(rawAmount)) || Math.max(Math.abs(signedAmount(debit)), Math.abs(signedAmount(credit)))
    const payload = {
      voucher_no: val(get(/voucherno|vouchernumber|^number$/)),
      voucher_type: classifyVoucherType(get(/vouchertype|vouchertypename|^type$/)).type,
      date: normalDate(get(/^(date|voucherdate|effectivedate)$/)),
      party_name: val(get(/partyname|partyledgername|ledgername|particulars|^party$/)) || 'Cash',
      party_uid: '', amount, paid_amount: amount, due_amount: 0, payment_mode: 'Tally import', items: [], ledger_entries: [],
      narration: val(get(/narration|description/)), reference_no: '', source_voucher_guid: val(get(/guid|voucherguid/)), source_company: company || 'default',
      source_system: 'tally',
    }
    payload.source_hash = await digest(JSON.stringify(payload))
    rows.push({ rowType: 'voucher', payload })
  }
  return rows
}

async function disambiguateVoucherNumbers(adminClient, jobId) {
  const { data: stagedRows, error: stagedError } = await adminClient
    .from('import_rows')
    .select('id, row_number, payload')
    .eq('job_id', jobId)
    .eq('row_type', 'voucher')
    .eq('selected_for_import', true)
    .order('row_number')
  if (stagedError) throw new Error('Could not inspect staged vouchers: ' + stagedError.message)
  if (!stagedRows?.length) return

  const baseNumbers = [...new Set(stagedRows.map((row) => val(row.payload?.voucher_no)).filter(Boolean))]
  const sourceGuids = [...new Set(stagedRows.map((row) => val(row.payload?.source_voucher_guid)).filter(Boolean))]
  const [numberMatches, guidMatches] = await Promise.all([
    fetchVoucherMatches(adminClient, 'voucher_no', baseNumbers),
    fetchVoucherMatches(adminClient, 'source_voucher_guid', sourceGuids, true),
  ])

  const existingByNumber = new Map(numberMatches.map((voucher) => [voucher.voucher_no, voucher]))
  const existingByIdentity = new Map(guidMatches
    .filter((voucher) => voucher.source_voucher_guid)
    .map((voucher) => [`${String(voucher.source_company || '').toLowerCase()}|${voucher.source_voucher_guid}`, voucher]))
  const reservedNumbers = new Set(numberMatches.map((voucher) => voucher.voucher_no))
  for (const voucher of guidMatches) reservedNumbers.add(voucher.voucher_no)
  const rowsByNumber = new Map()
  for (const row of stagedRows) {
    const baseNumber = val(row.payload?.voucher_no)
    if (!baseNumber) continue
    if (!rowsByNumber.has(baseNumber)) rowsByNumber.set(baseNumber, [])
    rowsByNumber.get(baseNumber).push(row)
  }

  for (const [baseNumber, rows] of rowsByNumber) {
    const occupiedBase = existingByNumber.get(baseNumber)
    let baseIsTaken = Boolean(occupiedBase)
    const remaining = []

    for (const row of rows) {
      const company = val(row.payload.source_company || 'default').toLowerCase()
      const guid = val(row.payload.source_voucher_guid)
      const existing = guid ? existingByIdentity.get(`${company}|${guid}`) : null
      if (existing) {
        if (existing.voucher_no !== baseNumber) baseIsTaken = true
        if (row.payload.voucher_no !== existing.voucher_no) {
          row.payload.voucher_no = existing.voucher_no
          await persistDisambiguatedRow(adminClient, row)
        }
      } else {
        remaining.push(row)
      }
    }

    if (!baseIsTaken && remaining.length) {
      // Keep the original number on one row whenever the database has no conflict.
      remaining.shift()
      reservedNumbers.add(baseNumber)
    }

    for (const row of remaining) {
      const company = val(row.payload.source_company || 'default')
      const guid = val(row.payload.source_voucher_guid)
      const date = val(row.payload.date).slice(0, 10)
      const identity = guid || [company, row.payload.voucher_type, date, baseNumber].join('|')
      const suffix = (await digest(identity)).slice(0, 8)
      let displayNumber = `${baseNumber} [${date || suffix}]`
      if (reservedNumbers.has(displayNumber)) displayNumber = `${baseNumber} [${date || 'Tally'}-${suffix}]`
      let digits = 12
      while (reservedNumbers.has(displayNumber)) {
        displayNumber = `${baseNumber} [${date || 'Tally'}-${(await digest(identity)).slice(0, digits)}]`
        digits += 4
      }
      reservedNumbers.add(displayNumber)
      row.payload.voucher_no = displayNumber
      await persistDisambiguatedRow(adminClient, row)
    }
  }
}

async function persistDisambiguatedRow(adminClient, row) {
  const { source_hash: _previousHash, ...payloadWithoutHash } = row.payload
  row.payload.source_hash = await digest(JSON.stringify(payloadWithoutHash))
  const { error } = await adminClient.from('import_rows').update({ payload: row.payload }).eq('id', row.id)
  if (error) throw new Error('Could not save a disambiguated voucher number: ' + error.message)
}

async function fetchVoucherMatches(adminClient, column, values, tallyOnly = false) {
  const matches = []
  for (let offset = 0; offset < values.length; offset += 80) {
    let query = adminClient
      .from('vouchers')
      .select('id, voucher_no, source_system, source_company, source_voucher_guid, voucher_type, date')
      .in(column, values.slice(offset, offset + 80))
    if (tallyOnly) query = query.eq('source_system', 'tally')
    const { data, error } = await query
    if (error) throw new Error('Could not check existing voucher numbers: ' + error.message)
    matches.push(...(data || []))
  }
  return matches
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  if (request.method !== 'POST') return respond({ error: 'Method not allowed' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL') || ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY') || ''
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    const authorization = request.headers.get('Authorization') || ''
    if (!url || !anonKey || !serviceKey) throw new Error('Supabase function secrets are not configured.')
    if (!authorization.startsWith('Bearer ')) return respond({ error: 'Authentication required' }, 401)
    const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } })
    const { data: authData, error: authError } = await userClient.auth.getUser()
    if (authError || !authData.user) return respond({ error: 'Invalid session' }, 401)
    const adminClient = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: profile, error: profileError } = await adminClient.from('profiles').select('role').eq('id', authData.user.id).maybeSingle()
    if (profileError || profile?.role !== 'admin') return respond({ error: 'Admin role required' }, 403)

    const body = await request.json()
    if (body.action === 'commit') {
      await disambiguateVoucherNumbers(adminClient, body.jobId)
      const { data, error } = await userClient.rpc('commit_tally_import', { p_job_id: body.jobId })
      if (error) throw new Error(error.message)
      return respond(data)
    }
    if (body.action !== 'preview') return respond({ error: 'Action must be preview or commit' }, 400)
    if (!body.filename || !body.contentBase64) throw new Error('File name and content are required.')
    const extension = String(body.filename).split('.').pop().toLowerCase()
    if (!['xml','xlsx','xls','csv'].includes(extension)) throw new Error('Unsupported file. Use XML, XLSX, XLS, or CSV.')
    const bytes = Uint8Array.from(atob(body.contentBase64), (character) => character.charCodeAt(0))
    if (bytes.byteLength > MAX_BYTES) throw new Error('File exceeds the 8 MB upload limit.')
    const contentHash = await digest(bytes)
    const company = String(body.companyName || 'default')
    // Optional sync window: lets commit tombstone vouchers that were deleted/cancelled in Tally.
    let syncWindow = null
    if (body.window) {
      const from = normalDate(body.window.from), to = normalDate(body.window.to)
      if (!from || !to || from > to) throw new Error('window.from / window.to must be valid dates (from <= to).')
      if (!body.companyName) throw new Error('companyName is required when a sync window is supplied.')
      syncWindow = { from, to, company }
    }
    let rows = []
    let ignored = { nonAccounting: 0, cancelled: 0, optional: 0 }
    if (extension === 'xml') {
      // Group hierarchy lets sub-groups of Sundry Debtors/Creditors etc. resolve to their primary group.
      const groupParents = {}
      if (body.groups && typeof body.groups === 'object') {
        for (const [name, parent] of Object.entries(body.groups)) groupParents[String(name)] = String(parent ?? '')
      }
      const { data: cashRows, error: cashError } = await adminClient.from('ledgers').select('name').in('group', ['Cash-in-hand', 'Bank Accounts', 'Bank OD A/c'])
      if (cashError) throw new Error('Could not load cash/bank ledgers: ' + cashError.message)
      const cashLedgerNames = new Set((cashRows || []).map((row) => String(row.name).toLowerCase()))
      const parsed = await parseTallyXml(new TextDecoder().decode(bytes), company, { XMLParser, XMLValidator }, { groupParents, cashLedgerNames })
      rows = parsed.rows
      ignored = parsed.ignored
    } else {
      rows = await parseSheet(bytes, company)
    }
    if (!rows.length && !syncWindow) throw new Error('No supported voucher, ledger, or stock-item rows were found.')

    const seen = new Set()
    let valid = 0, duplicates = 0, problems = 0
    const staged = []
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.rowType === 'voucher' && !row.payload.source_hash) row.payload.source_hash = await digest(JSON.stringify(row.payload))
      const messages = rowMessages(row)
      const key = row.rowType === 'voucher' ? (row.payload.source_voucher_guid || [row.payload.voucher_no,row.payload.date,row.payload.voucher_type].join('|')) : row.rowType + '|' + row.payload.name
      let status = messages.length ? 'error' : 'valid'
      if (seen.has(key)) { status = 'duplicate'; messages.push('Duplicate within this file') }
      seen.add(key)
      if (status === 'valid') valid += 1
      else if (status === 'duplicate') duplicates += 1
      else problems += 1
      staged.push({ row_number: index + 1, row_type: row.rowType, reference: row.payload.voucher_no || row.payload.name || 'Row ' + (index + 1), payload: row.payload, validation_status: status, validation_messages: messages, selected_for_import: status === 'valid' })
    }

    const counts = { total: staged.length, valid, duplicates, problems, ignored, ...(syncWindow ? { window: syncWindow } : {}) }
    const { data: createdJob, error: jobError } = await adminClient.from('import_jobs').insert({ filename: body.filename, source_format: extension, content_sha256: contentHash, status: 'ready', counts, created_by: authData.user.id }).select('id').single()
    if (jobError) throw new Error(jobError.message)
    for (let offset = 0; offset < staged.length; offset += 400) {
      const { error: rowsError } = await adminClient.from('import_rows').insert(staged.slice(offset, offset + 400).map((row) => ({ ...row, job_id: createdJob.id })))
      if (rowsError) throw new Error('Could not stage import rows: ' + rowsError.message)
    }
    const previewRows = staged.slice(0, 50).map((row) => ({ id: createdJob.id + '-' + row.row_number, rowNumber: row.row_number, rowType: row.row_type, reference: row.reference, validationStatus: row.validation_status, messages: row.validation_messages }))
    return respond({ jobId: createdJob.id, filename: body.filename, sourceFormat: extension, status: 'ready', summary: counts, previewRows })
  } catch (error) {
    return respond({ error: error instanceof Error ? error.message : 'Unexpected import failure' }, 400)
  }
})
