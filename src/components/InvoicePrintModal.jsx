import { X, Printer, MessageCircle, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function InvoicePrintModal({ isOpen, onClose, invoice }) {
  const { shopName, invoiceFooter } = useAuth()

  if (!isOpen || !invoice) return null

  const items = invoice.items || []
  const hasDue = Number(invoice.due_amount) > 0
  const total = Number(invoice.amount) || 0
  const paid = Number(invoice.paid_amount) || 0
  const due = Number(invoice.due_amount) || 0

  function handlePrint() {
    window.print()
  }

  function handleWhatsAppShare() {
    const phone = (invoice.party_phone || invoice.phone || '').replace(/[^0-9]/g, '')
    const itemsSummary = items
      .map((it) => `• ${it.name} (x${it.qty || 1}) - ₹${(Number(it.amount) || 0).toLocaleString('en-IN')}`)
      .join('\n')

    const message = encodeURIComponent(
      `*Tax Invoice from ${shopName || 'Shop'}*\n` +
      `Invoice: #${invoice.voucher_no}\n` +
      `Date: ${invoice.date || 'Today'}\n` +
      `Customer: ${invoice.party_name || 'Valued Customer'}\n\n` +
      `*Items:*\n${itemsSummary || 'Sales Entry'}\n\n` +
      `*Total Amount:* ₹${total.toLocaleString('en-IN')}\n` +
      `*Paid:* ₹${paid.toLocaleString('en-IN')}\n` +
      (hasDue ? `*Outstanding Balance Due:* ₹${due.toLocaleString('en-IN')}\n` : `*Status:* Paid in Full\n`) +
      `\n${invoice.narration || invoiceFooter || 'Thank you for your business!'}`
    )

    if (phone) {
      window.open(`https://wa.me/${phone}?text=${message}`, '_blank')
    } else {
      window.open(`https://wa.me/?text=${message}`, '_blank')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-xs overflow-y-auto font-sans">
      <div className="w-full max-w-3xl bg-white rounded-3xl shadow-2xl border border-[#dce5df] overflow-hidden my-auto max-h-[96vh] flex flex-col">
        {/* Modal Controls Bar (Hidden in Print) */}
        <div className="bg-[#0e655d] text-white px-5 py-3.5 flex items-center justify-between no-print shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="font-extrabold text-sm sm:text-base">Tax Invoice Preview</span>
            <span className="rounded-lg bg-white/20 px-2.5 py-0.5 text-xs font-mono font-bold">
              #{invoice.voucher_no}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleWhatsAppShare}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#25d366] hover:bg-[#20ba5a] text-white text-xs font-bold shadow-xs transition"
              title="Share invoice on WhatsApp"
            >
              <MessageCircle size={15} />
              <span className="hidden sm:inline">WhatsApp</span>
            </button>

            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white text-[#0e655d] hover:bg-[#eef8f4] text-xs font-extrabold shadow-xs transition"
            >
              <Printer size={15} />
              <span>Print / PDF</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-xl text-white/80 hover:text-white hover:bg-white/10 transition"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Printable Invoice Sheet */}
        <div className="p-6 sm:p-10 bg-white text-[#15342c] overflow-y-auto printable-area flex-1">
          {/* Header */}
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between pb-6 border-b border-[#e1e9e3] gap-4">
            <div>
              <h1 className="text-2xl font-black tracking-tight text-[#0e655d]">
                {shopName || 'MEEMX Mobile & Accessories'}
              </h1>
              <p className="text-xs text-[#6e8a81] font-semibold mt-0.5">
                Premium Mobile Covers, Tempered Glass &amp; Electronics
              </p>
              <p className="text-[11px] text-[#86a197] font-mono mt-0.5">
                GSTIN: 19ABCDE1234F1Z5 · State Code: 19 (West Bengal)
              </p>
            </div>

            <div className="text-left sm:text-right">
              <span className="inline-block px-3 py-1 bg-[#e3f4ee] border border-[#cbe6dc] rounded-lg text-xs font-mono font-extrabold uppercase tracking-wider text-[#0e655d] mb-1">
                TAX INVOICE
              </span>
              <div className="text-sm font-extrabold text-[#11382f]">#{invoice.voucher_no}</div>
              <div className="text-xs text-[#6e8a81]">Date: {invoice.date || invoice.displayDate}</div>
            </div>
          </div>

          {/* Billed To & Customer Info */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 py-5 border-b border-[#e1e9e3]">
            <div>
              <span className="text-[10px] font-extrabold text-[#749087] uppercase tracking-wider block mb-1">
                Billed To (Customer)
              </span>
              <div className="text-base font-extrabold text-[#11382f]">
                {invoice.party_name || 'Walk-in customer'}
              </div>
              {(invoice.party_phone || invoice.phone) && (
                <div className="text-xs text-[#55736a] mt-0.5">
                  Tel: {invoice.party_phone || invoice.phone}
                </div>
              )}

              {/* Permanent Customer UID Badge */}
              {invoice.party_uid ? (
                <div className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#e2f3ec] border border-[#bde2d3] text-[#0d786d] rounded-lg text-xs font-extrabold font-mono">
                  <ShieldCheck size={14} />
                  <span>Customer UID: {invoice.party_uid}</span>
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-[#7a968d] italic">
                  Walk-in counter customer
                </div>
              )}
            </div>

            <div className="sm:text-right text-xs space-y-1.5">
              <div>
                <span className="text-[#6d8a80]">Payment Mode:</span>{' '}
                <strong className="text-[#11382f] font-bold">{invoice.payment_mode || 'Cash'}</strong>
              </div>
              <div>
                <span className="text-[#6d8a80]">Invoice Status:</span>{' '}
                <span
                  className={`inline-block px-2 py-0.5 rounded-md text-[10px] font-extrabold ${
                    hasDue ? 'bg-[#fef3eb] text-[#c25e19]' : 'bg-[#e2f3ec] text-[#0d786d]'
                  }`}
                >
                  {hasDue ? 'Due (Credit Sale)' : 'Paid in Full'}
                </span>
              </div>
              <div>
                <span className="text-[#6d8a80]">Place of Supply:</span>{' '}
                <strong className="text-[#11382f]">State (Intra-State)</strong>
              </div>
            </div>
          </div>

          {/* Line Items Table */}
          <div className="py-5">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b-2 border-[#11382f] text-[#11382f] uppercase font-extrabold text-[10px]">
                  <th className="py-2.5">#</th>
                  <th className="py-2.5">Description of Goods</th>
                  <th className="py-2.5 text-right">Qty</th>
                  <th className="py-2.5 text-right">Unit</th>
                  <th className="py-2.5 text-right">Rate (₹)</th>
                  <th className="py-2.5 text-right">Amount (₹)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#e1e9e3]">
                {items.length > 0 ? (
                  items.map((it, idx) => (
                    <tr key={idx} className="hover:bg-[#f9fbf9]">
                      <td className="py-3 text-[#7a968d] font-mono">{idx + 1}</td>
                      <td className="py-3 font-bold text-[#11382f]">
                        <div>{it.name}</div>
                        {it.sku && (
                          <span className="text-[10px] font-mono text-[#6e8a81]">{it.sku}</span>
                        )}
                      </td>
                      <td className="py-3 text-right font-semibold">{it.qty}</td>
                      <td className="py-3 text-right text-[#6e8a81]">{it.unit || 'pcs'}</td>
                      <td className="py-3 text-right font-medium">
                        ₹{Number(it.rate || 0).toLocaleString('en-IN')}
                      </td>
                      <td className="py-3 text-right font-extrabold text-[#11382f]">
                        ₹{Number(it.amount || it.qty * it.rate).toLocaleString('en-IN')}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-[#7a968d]">
                      Standard Sales Entry · ₹{total.toLocaleString('en-IN')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Totals & Due Summary */}
          <div className="pt-4 border-t border-[#e1e9e3] flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="text-xs text-[#6e8a81] max-w-sm">
              <p className="font-extrabold text-[#11382f] mb-0.5">Remarks / Terms:</p>
              <p className="italic">
                {invoice.narration || invoiceFooter || 'Thank you for your business!'}
              </p>
            </div>

            <div className="w-full sm:w-64 space-y-1.5 text-xs text-right">
              <div className="flex justify-between text-[#6e8a81]">
                <span>Items Subtotal:</span>
                <span className="font-bold text-[#11382f]">₹{total.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between text-[#0d786d] font-bold">
                <span>Amount Paid:</span>
                <span>₹{paid.toLocaleString('en-IN')}</span>
              </div>
              <div className="flex justify-between text-base font-extrabold text-[#11382f] pt-2 border-t border-[#e1e9e3]">
                <span>Invoice Total:</span>
                <span>₹{total.toLocaleString('en-IN')}</span>
              </div>
              {hasDue && (
                <div className="flex justify-between text-[#c25e19] font-extrabold bg-[#fef3eb] px-2.5 py-1 rounded-lg">
                  <span>Balance Due:</span>
                  <span>₹{due.toLocaleString('en-IN')}</span>
                </div>
              )}
            </div>
          </div>

          {/* Print Footer / Signatory */}
          <div className="pt-10 mt-6 border-t border-dashed border-[#ccdcd2] flex justify-between items-end text-[10px] text-[#7a968d]">
            <div>
              <p className="font-semibold text-[#11382f]">{shopName || 'MEEMX ERP'}</p>
              <p>Computer-generated invoice. No signature required.</p>
            </div>
            <div className="text-right">
              <p className="font-extrabold text-[#11382f]">For {shopName || 'MEEMX ERP'}</p>
              <p className="mt-8 text-[#55736a]">Authorized Signatory</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
