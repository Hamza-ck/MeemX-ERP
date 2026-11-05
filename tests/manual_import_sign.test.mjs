import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { JSDOM } from 'jsdom'

describe('manual Tally XML import keeps the side of every balance', () => {
  let parseTallyXml
  before(async () => {
    globalThis.DOMParser = new JSDOM('').window.DOMParser
    ;({ parseTallyXml } = await import('../src/lib/tallyParser.js'))
  })
  const ledger = (name, parent, closing) => `<LEDGER NAME="${name}"><PARENT>${parent}</PARENT><OPENINGBALANCE>0</OPENINGBALANCE><CLOSINGBALANCE>${closing}</CLOSINGBALANCE></LEDGER>`

  it('a debtor who owes is positive, a customer advance is negative, an overdrawn bank is negative', () => {
    const { ledgers } = parseTallyXml(`<ENVELOPE>${ledger('Owes', 'Sundry Debtors', '-5000.00')}${ledger('Prepaid', 'Sundry Debtors', '700.00')}${ledger('HDFC OD', 'Bank Accounts', '1200.00')}${ledger('Supplier', 'Sundry Creditors', '900.00')}</ENVELOPE>`)
    const by = Object.fromEntries(ledgers.map((l) => [l.name, l.current_balance]))
    assert.equal(by.Owes, 5000)
    assert.equal(by.Prepaid, -700)
    assert.equal(by['HDFC OD'], -1200)
    assert.equal(by.Supplier, 900)
  })
})
