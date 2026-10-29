import { createClient } from 'npm:@supabase/supabase-js@2'
import { XMLParser, XMLValidator } from 'npm:fast-xml-parser@4'
import * as XLSX from 'npm:xlsx@0.18.5'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const MAX_BYTES = 8 * 1024 * 1024
const asArray = (value) => value == null ? [] : Array.isArray(value) ? value : [value]
const val = (value) => value == null ? '' : typeof value === 'object' && '#text' in value ? String(value['#text'] ?? '').trim() : String(value).trim()
const num = (value) => {
  const raw = val(value)
  if (!raw) return 0
  const match = raw.replace(/[(),]/g, '').match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)/)
  if (!match) return 0
  let parsed = Number(match[0])
  if (/^\(.*\)$/.test(raw) || /\bCr\.?\s*$/i.test(raw)) parsed = -Math.abs(parsed)
  return Number.isFinite(parsed) ? parsed : 0
}
const maybeNum = (value) => val(value) === '' ? null : num(value)
const normalDate = (value) => {
  const raw = value instanceof Date ? value.toISOString().slice(0, 10) : val(value)
  if (/^\d{8}$/.test(raw)) {
    const iso = raw.slice(0, 4) + '-' + raw.slice(4, 6) + '-' + raw.slice(6, 8)
    return validIsoDate(iso) ? iso : ''
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validIsoDate(raw) ? raw : ''
  if (/^\d{1,2}[-/]\d{1,2}[-/]\d{4}$/.test(raw)) {
    const parts = raw.split(/[-/]/)
    const iso = parts[2] + '-' + parts[1].padStart(2, '0') + '-' + parts[0].padStart(2, '0')
    return validIsoDate(iso) ? iso : ''
  }
  return ''
}
const validIsoDate = (value) => {
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}
const digest = async (input) => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
const collectNamed = (object, wanted, output = []) => {
  if (!object || typeof object !== 'object') return output
  if (Array.isArray(object)) { for (const item of object) collectNamed(item, wanted, output); return output }
  for (const [key, child] of Object.entries(object)) {
    if (key.toUpperCase() === wanted.toUpperCase()) output.push(...asArray(child))
    if (child && typeof child === 'object') collectNamed(child, wanted, output)
  }
  return output
}
const first = (object, keys) => {
  for (const key of keys) if (object?.[key] != null && val(object[key]) !== '') return object[key]
  return ''
}
const typeNormal = (value) => {
  const type = val(value).toLowerCase()
  if (type.includes('sales') || type === 'sale') return 'sales'
  if (type.includes('purchase')) return 'purchase'
  if (type.includes('receipt')) return 'receipt'
  if (type.includes('payment')) return 'payment'
  if (type.includes('contra')) return 'contra'
  if (type.includes('journal')) return 'journal'
  return ''
}
const ledgerCategory = (group) => {
  const name = val(group).toLowerCase()
  if (name.includes('expense') || name.includes('purchase account')) return 'expense'
  if (name.includes('income') || name.includes('sales account')) return 'income'
  if (name.includes('liabilit') || name.includes('creditor') || name.includes('capital') || name.includes('loan') || name.includes('provision')) return 'liability'
  return 'asset'
}
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

async function parseXml(text, company) {
  const validation = XMLValidator.validate(text)
  if (validation !== true) throw new Error('Invalid XML: ' + (validation.err?.msg || 'document validation failed'))
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true }).parse(text)
  const rows = []
  for (const voucher of collectNamed(parsed, 'VOUCHER')) {
    const date = normalDate(first(voucher, ['DATE','EFFECTIVEDATE']))
    const inventoryEntries = [...asArray(voucher['ALLINVENTORYENTRIES.LIST']), ...asArray(voucher['INVENTORYENTRIES.LIST'])]
    const entries = [
      ...asArray(voucher['ALLLEDGERENTRIES.LIST']),
      ...asArray(voucher['LEDGERENTRIES.LIST']),
      ...inventoryEntries.flatMap((item) => asArray(item['ACCOUNTINGALLOCATIONS.LIST'])),
    ]
    const ledgerEntries = entries.map((entry) => ({
      ledger_name: val(first(entry, ['LEDGERNAME'])),
      amount: Math.abs(num(entry.AMOUNT)),
      is_debit: /^yes$/i.test(val(first(entry, ['ISDEEMEDPOSITIVE']))) || num(entry.AMOUNT) < 0,
    })).filter((entry) => entry.ledger_name)
    const items = inventoryEntries.map((item) => ({
      name: val(first(item, ['STOCKITEMNAME','NAME'])),
      qty: Math.abs(num(first(item, ['BILLEDQTY','ACTUALQTY']))),
      rate: Math.abs(num(item.RATE)),
      amount: Math.abs(num(item.AMOUNT)),
    })).filter((item) => item.name)
    const partyName = val(first(voucher, ['PARTYLEDGERNAME','PARTYNAME'])) || 'Cash'
    const inventoryTotal = items.reduce((sum, item) => sum + item.amount, 0)
    const amount = Math.max(Math.abs(num(first(voucher, ['AMOUNT']))), inventoryTotal, ...ledgerEntries.map((entry) => entry.amount), 0)
    const voucherType = typeNormal(first(voucher, ['@_VCHTYPE','VOUCHERTYPENAME','VOUCHERTYPE']))
    const partyEntry = ledgerEntries.find((entry) => entry.ledger_name.toLowerCase() === partyName.toLowerCase())
    const isCash = partyName.toLowerCase().includes('cash')
    const dueAmount = voucherType === 'sales' && partyEntry?.is_debit
      ? Math.min(amount, partyEntry.amount)
      : voucherType === 'purchase' && partyEntry && !partyEntry.is_debit
        ? Math.min(amount, partyEntry.amount)
        : isCash ? 0 : amount
    const payload = {
      voucher_no: val(first(voucher, ['VOUCHERNUMBER','VOUCHERNO','MASTERID'])),
      voucher_type: voucherType,
      date, party_name: partyName,
      party_uid: '', amount, paid_amount: Math.max(0, amount - dueAmount), due_amount: dueAmount, payment_mode: 'Tally import', items, ledger_entries: ledgerEntries,
      narration: val(voucher.NARRATION), reference_no: val(first(voucher, ['REFERENCE','REFERENCEID'])),
      source_voucher_guid: val(first(voucher, ['GUID','MASTERID'])), source_company: company || 'default',
      source_system: 'tally',
    }
    payload.source_hash = await digest(JSON.stringify(payload))
    rows.push({ rowType: 'voucher', payload })
  }
  for (const ledger of collectNamed(parsed, 'LEDGER')) {
    const name = val(first(ledger, ['@_NAME','NAME']))
    if (!name) continue
    const group = val(first(ledger, ['PARENT'])) || 'General'
    const opening = Math.abs(num(first(ledger, ['OPENINGBALANCE'])))
    const closing = maybeNum(first(ledger, ['CLOSINGBALANCE']))
    const type = group.toLowerCase().includes('creditor') ? 'creditor' : group.toLowerCase().includes('debtor') ? 'debtor' : ''
    const payload = { name, group, category: ledgerCategory(group), opening_balance: opening, current_balance: closing === null ? opening : Math.abs(closing), closing_balance: closing === null ? null : Math.abs(closing), phone: val(first(ledger, ['LEDGERPHONE','PHONE'])), email: val(first(ledger, ['EMAIL'])), address: val(first(ledger, ['ADDRESS'])) }
    rows.push({ rowType: type ? 'party' : 'ledger', payload: type ? { ...payload, type } : payload })
  }
  for (const stock of collectNamed(parsed, 'STOCKITEM')) {
    const name = val(first(stock, ['@_NAME','NAME']))
    if (!name) continue
    const closingQty = maybeNum(first(stock, ['CLOSINGBALANCE']))
    const openingQty = maybeNum(first(stock, ['OPENINGBALANCE']))
    const closingValue = maybeNum(first(stock, ['CLOSINGVALUE']))
    const closingRate = maybeNum(first(stock, ['CLOSINGRATE']))
    const openingRate = maybeNum(first(stock, ['OPENINGRATE']))
    const salesRate = maybeNum(first(stock, ['BASESELLPRICE','SALEPRICE']))
    const currentQty = closingQty ?? openingQty
    rows.push({ rowType: 'stock_item', payload: {
      name, sku: 'TALLY-' + (await digest(name.toLowerCase())).slice(0, 12).toUpperCase(),
      category: val(first(stock, ['PARENT'])) || 'General', unit: val(first(stock, ['BASEUNITS'])) || 'pcs',
      ...(currentQty !== null ? { current_qty: Math.abs(currentQty) } : {}),
      ...(closingValue !== null ? { current_value: Math.abs(closingValue) } : {}),
      ...(closingRate !== null || openingRate !== null ? { purchase_rate: Math.abs(closingRate ?? openingRate) } : {}),
      ...(salesRate !== null ? { sales_rate: Math.abs(salesRate) } : {}),
    } })
  }
  // Stock Summary is the reliable source for live item valuation on Tally builds
  // whose StockItem collection only returns its display name.
  const stockSummaryNames = collectNamed(parsed, 'DSPACCNAME')
  const stockSummaryInfo = collectNamed(parsed, 'DSPSTKINFO')
  for (let index = 0; index < Math.min(stockSummaryNames.length, stockSummaryInfo.length); index++) {
    const name = val(first(stockSummaryNames[index], ['DSPDISPNAME']))
    if (!name) continue
    const closing = first(stockSummaryInfo[index], ['DSPSTKCL'])
    if (!closing || typeof closing !== 'object') continue
    const quantityText = val(first(closing, ['DSPCLQTY']))
    const quantity = maybeNum(quantityText)
    const rate = maybeNum(first(closing, ['DSPCLRATE']))
    const value = maybeNum(first(closing, ['DSPCLAMTA']))
    const unit = quantityText.match(/\s+([\p{L}][\p{L} ._-]*)\s*$/u)?.[1]?.trim()
    rows.push({ rowType: 'stock_item', payload: {
      name,
      sku: 'TALLY-' + (await digest(name.toLowerCase())).slice(0, 12).toUpperCase(),
      ...(unit ? { unit } : {}),
      ...(quantity !== null ? { current_qty: Math.abs(quantity) } : {}),
      ...(rate !== null ? { purchase_rate: Math.abs(rate) } : {}),
      ...(value !== null ? { current_value: Math.abs(value) } : {}),
    } })
  }
  return rows
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
    const amount = Math.abs(num(rawAmount)) || Math.max(Math.abs(num(debit)), Math.abs(num(credit)))
    const payload = {
      voucher_no: val(get(/voucherno|vouchernumber|^number$/)),
      voucher_type: typeNormal(get(/vouchertype|vouchertypename|^type$/)),
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
    let rows = extension === 'xml' ? await parseXml(new TextDecoder().decode(bytes), company) : await parseSheet(bytes, company)
    if (!rows.length) throw new Error('No supported voucher, ledger, or stock-item rows were found.')

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

    const counts = { total: staged.length, valid, duplicates, problems }
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
