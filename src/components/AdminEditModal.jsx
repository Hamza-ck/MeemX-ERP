import { useState, useEffect } from 'react'
import { X, ShieldCheck, Trash2, CheckCircle2, Lock } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  updatePartyRecord,
  updateMaterialRecord,
  updateVoucherRecord,
  updateLedgerRecord,
  deleteDbRecord,
} from '../lib/accountingDb'

export default function AdminEditModal({
  isOpen,
  onClose,
  type, // 'voucher' | 'debtor' | 'creditor' | 'material' | 'ledger'
  item,
  onSaved,
}) {
  const { role } = useAuth()
  const [formData, setFormData] = useState({})
  const [saving, setSaving] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)

  // Initialize form data when item changes
  useEffect(() => {
    if (item) {
      setFormData({ ...item })
      setDeleteConfirm(false)
      setSaveSuccess(false)
    }
  }, [item, isOpen])

  const isAuthorized = role === 'admin'

  if (!isOpen || !item) return null

  const handleChange = (field, value) => {
    setFormData((prev) => {
      const updated = { ...prev, [field]: value }

      // Auto update due amount and status for vouchers
      if (type === 'voucher' && (field === 'amount' || field === 'paid_amount')) {
        const amt = field === 'amount' ? Number(value) || 0 : Number(prev.amount) || 0
        const paid = field === 'paid_amount' ? Number(value) || 0 : Number(prev.paid_amount) || 0
        updated.due_amount = Math.max(0, amt - paid)
        updated.status = updated.due_amount <= 0 ? 'Paid' : 'Due'
      }

      return updated
    })
  }

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true)
    try {
      if (type === 'voucher') {
        await updateVoucherRecord(item.id, formData)
      } else if (type === 'debtor' || type === 'creditor') {
        await updatePartyRecord(item.id, formData)
      } else if (type === 'material') {
        await updateMaterialRecord(item.id, formData)
      } else if (type === 'ledger') {
        await updateLedgerRecord(item.id, formData)
      }

      setSaveSuccess(true)
      setTimeout(() => {
        setSaveSuccess(false)
        if (typeof onSaved === 'function') onSaved(formData)
        onClose()
      }, 500)
    } catch (err) {
      alert(`Failed to save record: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteConfirm) {
      setDeleteConfirm(true)
      return
    }

    setSaving(true)
    try {
      let table = 'vouchers'
      if (type === 'debtor' || type === 'creditor') table = 'parties'
      else if (type === 'material') table = 'materials'
      else if (type === 'ledger') table = 'ledgers'

      await deleteDbRecord(table, item.id)
      if (typeof onSaved === 'function') onSaved(null)
      onClose()
    } catch (err) {
      alert(`Failed to delete record: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fadeIn">
      <div className="bg-white rounded-3xl shadow-2xl border border-[#0e655d]/10 max-w-xl w-full max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="px-6 py-5 border-b border-[#0e655d]/10 flex items-center justify-between bg-[#f4f7f4] rounded-t-3xl">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#0e655d] text-white flex items-center justify-center shadow-sm">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-[#142d2a] capitalize">
                Admin Edit · {type === 'voucher' ? 'Invoice / Voucher' : type}
              </h2>
              <p className="text-xs text-[#0e655d] font-mono">
                ID #{item.id} {item.voucher_no || item.uid || item.sku || item.name}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#52796f] hover:bg-white hover:text-[#142d2a] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* PIN Verification View */}
        {!isAuthorized ? (
          <div className="p-8 text-center">
            <div className="w-14 h-14 rounded-3xl bg-[#fef3eb] text-[#c25e19] flex items-center justify-center mx-auto mb-4">
              <Lock className="w-6 h-6" />
            </div>
            <h3 className="text-base font-bold text-[#142d2a] mb-1">
              Admin Authentication Required
            </h3>
            <p className="text-xs text-[#52796f] mb-6 max-w-sm mx-auto">
              This account has read-only access. Sign in with an administrator account to edit records.
            </p>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-semibold text-[#52796f] hover:bg-slate-200 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          /* Editable Form */
          <form onSubmit={handleSave} className="p-6 space-y-4">
            {/* Voucher / Invoice Fields */}
            {type === 'voucher' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Voucher Number
                    </label>
                    <input
                      type="text"
                      value={formData.voucher_no || ''}
                      onChange={(e) => handleChange('voucher_no', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Date
                    </label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => handleChange('date', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Party Name
                    </label>
                    <input
                      type="text"
                      value={formData.party_name || ''}
                      onChange={(e) => handleChange('party_name', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Party UID (Debtor)
                    </label>
                    <input
                      type="text"
                      value={formData.party_uid || ''}
                      onChange={(e) => handleChange('party_uid', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      placeholder="UID-CUST-xxxx"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Total Amount (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.amount ?? 0}
                      onChange={(e) => handleChange('amount', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Paid Amount (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.paid_amount ?? 0}
                      onChange={(e) => handleChange('paid_amount', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Due Amount (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.due_amount ?? 0}
                      onChange={(e) => handleChange('due_amount', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Payment Mode
                    </label>
                    <select
                      value={formData.payment_mode || 'Credit'}
                      onChange={(e) => handleChange('payment_mode', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    >
                      <option value="Credit">Credit</option>
                      <option value="Cash">Cash</option>
                      <option value="UPI">UPI</option>
                      <option value="HDFC Bank">HDFC Bank</option>
                      <option value="Cheque">Cheque</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Status
                    </label>
                    <select
                      value={formData.status || 'Due'}
                      onChange={(e) => handleChange('status', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    >
                      <option value="Paid">Paid</option>
                      <option value="Due">Due</option>
                      <option value="Overdue">Overdue</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                    Narration / Notes
                  </label>
                  <textarea
                    rows={2}
                    value={formData.narration || ''}
                    onChange={(e) => handleChange('narration', e.target.value)}
                    className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                  />
                </div>
              </>
            )}

            {/* Debtor Fields */}
            {type === 'debtor' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Customer Name
                    </label>
                    <input
                      type="text"
                      value={formData.name || ''}
                      onChange={(e) => handleChange('name', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Permanent UID
                    </label>
                    <input
                      type="text"
                      value={formData.uid || ''}
                      onChange={(e) => handleChange('uid', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Phone Number
                    </label>
                    <input
                      type="text"
                      value={formData.phone || ''}
                      onChange={(e) => handleChange('phone', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Current Due Balance (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.current_balance ?? 0}
                      onChange={(e) => handleChange('current_balance', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Aging Bucket
                    </label>
                    <select
                      value={formData.age_bucket || '0–30d'}
                      onChange={(e) => handleChange('age_bucket', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    >
                      <option value="0–30d">0–30 days</option>
                      <option value="31–60d">31–60 days</option>
                      <option value="60d+">60+ days</option>
                      <option value="Settled">Settled</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Days Overdue
                    </label>
                    <input
                      type="number"
                      value={formData.due_days ?? 0}
                      onChange={(e) => handleChange('due_days', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Creditor Fields */}
            {type === 'creditor' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Supplier / Creditor Name
                    </label>
                    <input
                      type="text"
                      value={formData.name || ''}
                      onChange={(e) => handleChange('name', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Phone Number
                    </label>
                    <input
                      type="text"
                      value={formData.phone || ''}
                      onChange={(e) => handleChange('phone', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Current Balance Owed (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.current_balance ?? 0}
                      onChange={(e) => handleChange('current_balance', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Due Bucket
                    </label>
                    <select
                      value={formData.due_bucket || 'Due now'}
                      onChange={(e) => handleChange('due_bucket', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    >
                      <option value="Due now">Due now</option>
                      <option value="Next 15d">Next 15d</option>
                      <option value="Later">Later</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Next Payment Date
                    </label>
                    <input
                      type="text"
                      value={formData.next_payment || ''}
                      onChange={(e) => handleChange('next_payment', e.target.value)}
                      placeholder="e.g. 20 Oct"
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Due Status Note
                    </label>
                    <input
                      type="text"
                      value={formData.due_status || ''}
                      onChange={(e) => handleChange('due_status', e.target.value)}
                      placeholder="e.g. Due in 1d"
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Inventory / Material Fields */}
            {type === 'material' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      SKU Code
                    </label>
                    <input
                      type="text"
                      value={formData.sku || ''}
                      onChange={(e) => handleChange('sku', e.target.value)}
                      className="w-full text-xs font-mono px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Item Name
                    </label>
                    <input
                      type="text"
                      value={formData.name || ''}
                      onChange={(e) => handleChange('name', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Category
                    </label>
                    <input
                      type="text"
                      value={formData.category || ''}
                      onChange={(e) => handleChange('category', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Unit
                    </label>
                    <input
                      type="text"
                      value={formData.unit || 'pcs'}
                      onChange={(e) => handleChange('unit', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Stock Quantity
                    </label>
                    <input
                      type="number"
                      value={formData.current_qty ?? 0}
                      onChange={(e) => handleChange('current_qty', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Purchase Cost (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.purchase_rate ?? 0}
                      onChange={(e) => handleChange('purchase_rate', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Selling Rate (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.sales_rate ?? 0}
                      onChange={(e) => handleChange('sales_rate', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Reorder Threshold
                    </label>
                    <input
                      type="number"
                      value={formData.reorder_threshold ?? 10}
                      onChange={(e) => handleChange('reorder_threshold', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    />
                  </div>
                </div>
              </>
            )}

            {/* Ledger Fields */}
            {type === 'ledger' && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Ledger Name
                    </label>
                    <input
                      type="text"
                      value={formData.name || ''}
                      onChange={(e) => handleChange('name', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Account Group
                    </label>
                    <input
                      type="text"
                      value={formData.group || ''}
                      onChange={(e) => handleChange('group', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Current Balance (₹)
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={formData.current_balance ?? 0}
                      onChange={(e) => handleChange('current_balance', e.target.value)}
                      className="w-full text-xs font-mono tabular-nums px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                      Category
                    </label>
                    <select
                      value={formData.category || 'asset'}
                      onChange={(e) => handleChange('category', e.target.value)}
                      className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                    >
                      <option value="asset">Asset (Advances / Bank / Cash)</option>
                      <option value="liability">Liability (Loans / Borrowings)</option>
                      <option value="expense">Expense</option>
                      <option value="income">Income</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-[#142d2a] mb-1">
                    Notes / Repayment Terms
                  </label>
                  <input
                    type="text"
                    value={formData.note || ''}
                    onChange={(e) => handleChange('note', e.target.value)}
                    placeholder="e.g. EMI ₹18,500 due 5 Nov"
                    className="w-full text-xs px-3 py-2 border border-[#0e655d]/20 rounded-xl bg-white focus:outline-none focus:ring-1 focus:ring-[#0e655d]"
                  />
                </div>
              </>
            )}

            {/* Actions Bar */}
            <div className="pt-4 border-t border-[#0e655d]/10 flex items-center justify-between">
              <button
                type="button"
                onClick={handleDelete}
                className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-xl transition-colors ${
                  deleteConfirm
                    ? 'bg-rose-600 text-white hover:bg-rose-700'
                    : 'text-rose-600 hover:bg-rose-50'
                }`}
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{deleteConfirm ? 'Confirm Delete?' : 'Delete'}</span>
              </button>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-xs font-semibold text-[#52796f] bg-slate-100 rounded-xl hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-5 py-2 text-xs font-semibold text-white bg-[#0e655d] rounded-xl hover:bg-[#084d46] transition-colors shadow-sm disabled:opacity-50"
                >
                  {saveSuccess ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-white" />
                      <span>Saved!</span>
                    </>
                  ) : (
                    <span>{saving ? 'Saving...' : 'Save Changes'}</span>
                  )}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
