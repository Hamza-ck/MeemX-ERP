import { useState, useEffect, useMemo } from 'react'
import {
  X,
  Plus,
  Minus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Receipt,
  User,
  Calendar,
  Phone,
  CreditCard,
  Hash,
  Box,
  BadgeCheck,
  Printer,
} from 'lucide-react'
import { accDb, createVoucher, updateVoucher } from '../lib/accountingDb'

export default function VoucherModal({
  isOpen,
  onClose,
  editingVoucher = null,
  onSuccess,
  onSaveAndPrint,
}) {
  // Form State
  const [voucherNo, setVoucherNo] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [partyName, setPartyName] = useState('')
  const [partyPhone, setPartyPhone] = useState('')
  const [paymentMode, setPaymentMode] = useState('Cash')
  const [narration, setNarration] = useState('')
  const [discountType, setDiscountType] = useState('flat') // 'flat' | 'percent'
  const [discountVal, setDiscountVal] = useState(0)
  const [taxPercent, setTaxPercent] = useState(0) // 0, 5, 12, 18
  const [paidAmount, setPaidAmount] = useState(0)
  const [isCustomPaid, setIsCustomPaid] = useState(false)

  const [items, setItems] = useState([
    {
      material_id: '',
      sku: '',
      name: '',
      qty: 1,
      rate: 0,
      cost_rate: 0,
      unit: 'pcs',
      amount: 0,
    },
  ])

  // Masters loaded from Dexie
  const [materials, setMaterials] = useState([])
  const [parties, setParties] = useState([])
  const [customerSuggestions, setCustomerSuggestions] = useState([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Load materials & existing parties
  useEffect(() => {
    if (!isOpen) return
    let active = true

    async function loadData() {
      try {
        const [mats, pts, vouchers] = await Promise.all([
          accDb.materials.toArray(),
          accDb.parties.toArray(),
          accDb.vouchers.toArray(),
        ])
        if (!active) return

        setMaterials(mats)
        setParties(pts)

        if (editingVoucher) {
          setVoucherNo(editingVoucher.voucher_no || '')
          setDate(editingVoucher.date || new Date().toISOString().slice(0, 10))
          setPartyName(editingVoucher.party_name || '')
          setPartyPhone(editingVoucher.party_phone || editingVoucher.phone || '')
          setPaymentMode(editingVoucher.payment_mode || 'Cash')
          setNarration(editingVoucher.narration || '')
          setPaidAmount(Number(editingVoucher.paid_amount) || 0)
          setIsCustomPaid(true)

          if (Array.isArray(editingVoucher.items) && editingVoucher.items.length > 0) {
            setItems(
              editingVoucher.items.map((it) => ({
                material_id: it.material_id ? String(it.material_id) : '',
                sku: it.sku || '',
                name: it.name || '',
                qty: Math.max(1, Number(it.qty) || 1),
                rate: Number(it.rate) || 0,
                cost_rate: Number(it.cost_rate) || 0,
                unit: it.unit || 'pcs',
                amount: (Number(it.qty) || 1) * (Number(it.rate) || 0),
              }))
            )
          }
        } else {
          // Auto-generate next invoice number (e.g., INV-0413)
          const invNums = vouchers
            .map((v) => {
              const match = String(v.voucher_no || '').match(/INV-(\d+)/)
              return match ? parseInt(match[1], 10) : 0
            })
            .filter((n) => !isNaN(n))
          const maxNum = invNums.length > 0 ? Math.max(...invNums) : 412
          const nextInvNo = `INV-0${maxNum + 1}`

          setVoucherNo(nextInvNo)
          setDate(new Date().toISOString().slice(0, 10))
          setPartyName('')
          setPartyPhone('')
          setPaymentMode('Cash')
          setNarration('')
          setDiscountVal(0)
          setTaxPercent(0)
          setIsCustomPaid(false)

          // Preload first item from inventory
          const firstMat = mats[0]
          if (firstMat) {
            const initialQty = 1
            const initialRate = Number(firstMat.sales_rate) || 0
            const initialTotal = initialQty * initialRate
            setItems([
              {
                material_id: String(firstMat.id),
                sku: firstMat.sku || '',
                name: firstMat.name || '',
                qty: initialQty,
                rate: initialRate,
                cost_rate: Number(firstMat.purchase_rate) || 0,
                unit: firstMat.unit || 'pcs',
                amount: initialTotal,
              },
            ])
            setPaidAmount(initialTotal)
          } else {
            setItems([
              {
                material_id: '',
                sku: '',
                name: '',
                qty: 1,
                rate: 0,
                cost_rate: 0,
                unit: 'pcs',
                amount: 0,
              },
            ])
            setPaidAmount(0)
          }
          setError('')
        }
      } catch (err) {
        console.warn('Error loading masters for invoice form:', err)
      }
    }

    loadData()
    return () => {
      active = false
    }
  }, [isOpen, editingVoucher])

  // Calculation helpers
  const subtotal = useMemo(() => {
    return items.reduce((acc, it) => acc + (Number(it.amount) || 0), 0)
  }, [items])

  const discountAmount = useMemo(() => {
    const val = Number(discountVal) || 0
    if (val <= 0) return 0
    if (discountType === 'percent') {
      return (subtotal * val) / 100
    }
    return Math.min(subtotal, val)
  }, [subtotal, discountVal, discountType])

  const taxableAmount = useMemo(() => {
    return Math.max(0, subtotal - discountAmount)
  }, [subtotal, discountAmount])

  const taxAmount = useMemo(() => {
    if (!taxPercent || taxPercent <= 0) return 0
    return (taxableAmount * taxPercent) / 100
  }, [taxableAmount, taxPercent])

  const totalAmount = useMemo(() => {
    return Math.round(taxableAmount + taxAmount)
  }, [taxableAmount, taxAmount])

  const dueAmount = useMemo(() => {
    return Math.max(0, totalAmount - (Number(paidAmount) || 0))
  }, [totalAmount, paidAmount])

  // Auto-update paid amount when total changes (unless user manually entered partial amount or selected Credit)
  useEffect(() => {
    if (paymentMode === 'Credit') {
      setPaidAmount(0)
    } else if (!isCustomPaid) {
      setPaidAmount(totalAmount)
    }
  }, [totalAmount, paymentMode, isCustomPaid])

  // Matched customer for permanent UID and prior balance
  const matchedCustomer = useMemo(() => {
    if (!partyName.trim()) return null
    return parties.find(
      (p) => p.name.trim().toLowerCase() === partyName.trim().toLowerCase()
    )
  }, [parties, partyName])

  // Customer suggestions filter
  useEffect(() => {
    if (!partyName.trim()) {
      setCustomerSuggestions([])
      return
    }
    const q = partyName.toLowerCase()
    const matches = parties.filter((p) => p.name.toLowerCase().includes(q))
    setCustomerSuggestions(matches)
  }, [partyName, parties])

  const handleSelectCustomer = (cust) => {
    setPartyName(cust.name)
    if (cust.phone) setPartyPhone(cust.phone)
    setShowSuggestions(false)
  }

  // Handle line item updates
  const updateItem = (index, field, value) => {
    const updated = [...items]
    const item = { ...updated[index], [field]: value }

    if (field === 'material_id') {
      const mat = materials.find((m) => String(m.id) === String(value))
      if (mat) {
        item.sku = mat.sku || ''
        item.name = mat.name || ''
        item.unit = mat.unit || 'pcs'
        item.rate = Number(mat.sales_rate) || 0
        item.cost_rate = Number(mat.purchase_rate) || 0
      }
    }

    const q = Math.max(1, Number(field === 'qty' ? value : item.qty) || 1)
    const r = Math.max(0, Number(field === 'rate' ? value : item.rate) || 0)
    item.qty = q
    item.rate = r
    item.amount = q * r

    updated[index] = item
    setItems(updated)
  }

  const changeQty = (index, delta) => {
    const current = Number(items[index]?.qty) || 1
    const newQty = Math.max(1, current + delta)
    updateItem(index, 'qty', newQty)
  }

  const addItem = () => {
    const defaultMat = materials.find((m) => !items.some((it) => it.material_id === String(m.id))) || materials[0]
    setItems([
      ...items,
      {
        material_id: defaultMat ? String(defaultMat.id) : '',
        sku: defaultMat ? defaultMat.sku || '' : '',
        name: defaultMat ? defaultMat.name || '' : '',
        qty: 1,
        rate: defaultMat ? Number(defaultMat.sales_rate) || 0 : 0,
        cost_rate: defaultMat ? Number(defaultMat.purchase_rate) || 0 : 0,
        unit: defaultMat ? defaultMat.unit || 'pcs' : 'pcs',
        amount: defaultMat ? Number(defaultMat.sales_rate) || 0 : 0,
      },
    ])
  }

  const removeItem = (index) => {
    if (items.length <= 1) return
    setItems(items.filter((_, i) => i !== index))
  }

  const handlePaymentModeSelect = (mode) => {
    setPaymentMode(mode)
    if (mode === 'Credit') {
      setIsCustomPaid(true)
      setPaidAmount(0)
    } else if (mode === 'Partial') {
      setIsCustomPaid(true)
      // default half upfront
      setPaidAmount(Math.round(totalAmount / 2))
    } else {
      setIsCustomPaid(false)
      setPaidAmount(totalAmount)
    }
  }

  const handleSaveInternal = async (printAfterSave = false) => {
    setError('')

    if (!partyName.trim()) {
      setError('Please enter or select a customer name.')
      return
    }

    if (totalAmount <= 0) {
      setError('Please add at least one line item with a price greater than ₹0.')
      return
    }

    setLoading(true)
    try {
      const payload = {
        voucher_type: 'sales',
        voucher_no: voucherNo.trim() || `INV-${Date.now().toString().slice(-4)}`,
        date,
        party_name: partyName.trim(),
        party_phone: partyPhone.trim(),
        phone: partyPhone.trim(),
        party_uid: matchedCustomer?.uid || null,
        payment_mode: paymentMode,
        status: dueAmount > 0 ? 'Due' : 'Paid',
        subtotal,
        discount_amount: discountAmount,
        tax_amount: taxAmount,
        amount: totalAmount,
        paid_amount: Number(paidAmount) || 0,
        due_amount: dueAmount,
        narration: narration.trim() || (dueAmount > 0 ? 'Credit invoice' : 'Full settlement invoice'),
        items: items.map((it) => ({
          material_id: it.material_id ? Number(it.material_id) : null,
          sku: it.sku || '',
          name: it.name || 'Custom item',
          qty: Number(it.qty) || 1,
          rate: Number(it.rate) || 0,
          cost_rate: Number(it.cost_rate) || 0,
          unit: it.unit || 'pcs',
          amount: (Number(it.qty) || 1) * (Number(it.rate) || 0),
        })),
      }

      let savedRecord
      if (editingVoucher?.id) {
        savedRecord = await updateVoucher(editingVoucher.id, payload)
      } else {
        savedRecord = await createVoucher(payload)
      }

      window.dispatchEvent(new Event('accounting-data-updated'))

      if (printAfterSave && onSaveAndPrint) {
        onSaveAndPrint(savedRecord || payload)
      } else if (onSuccess) {
        onSuccess(savedRecord || payload)
      }

      onClose()
    } catch (err) {
      console.error('Save invoice error:', err)
      setError(err.message || 'Failed to save sales invoice.')
    } finally {
      setLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-2 sm:p-4 backdrop-blur-xs overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl rounded-3xl border border-[#dce5df] bg-white p-5 sm:p-7 shadow-[0_24px_70px_rgba(14,101,93,0.2)] my-auto max-h-[96vh] flex flex-col font-sans"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header - PDF Pine Green Aesthetic */}
        <div className="flex items-center justify-between pb-4 border-b border-[#edf3f0] shrink-0">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#0e655d] text-white shadow-xs shrink-0">
              <Receipt size={22} strokeWidth={2.3} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[19px] font-extrabold tracking-tight text-[#11382f]">
                  {editingVoucher ? 'Edit Sales Invoice' : 'New Sales Invoice'}
                </h3>
                <span className="rounded-lg bg-[#e3f4ee] px-2.5 py-0.5 font-mono text-[11px] font-extrabold text-[#0e655d]">
                  {voucherNo}
                </span>
              </div>
              <p className="text-xs text-[#6e8a81]">
                Quick billing with live inventory deduction &amp; automatic dues tracking
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="grid h-9 w-9 place-items-center rounded-xl text-[#6d8a81] hover:bg-[#f0f6f3] hover:text-[#11382f] transition"
            aria-label="Close modal"
          >
            <X size={19} />
          </button>
        </div>

        {/* Scrollable Form Body */}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            handleSaveInternal(false)
          }}
          className="mt-4 space-y-4 overflow-y-auto pr-1 flex-1 text-slate-800"
        >
          {/* Top Row: Invoice Number & Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-[#143d35] mb-1">
                Invoice Number
              </label>
              <div className="flex items-center gap-2 rounded-2xl border border-[#d8e3de] bg-[#f8faf9] px-3.5 py-2.5 focus-within:border-[#0e655d] focus-within:bg-white transition">
                <Hash size={15} className="text-[#78968d] shrink-0" />
                <input
                  type="text"
                  required
                  value={voucherNo}
                  onChange={(e) => setVoucherNo(e.target.value)}
                  className="w-full bg-transparent font-mono text-xs font-extrabold text-[#11382f] outline-none"
                  placeholder="INV-0413"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-bold text-[#143d35] mb-1">
                Invoice Date
              </label>
              <div className="flex items-center gap-2 rounded-2xl border border-[#d8e3de] bg-[#f8faf9] px-3.5 py-2.5 focus-within:border-[#0e655d] focus-within:bg-white transition">
                <Calendar size={15} className="text-[#78968d] shrink-0" />
                <input
                  type="date"
                  required
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="w-full bg-transparent text-xs font-bold text-[#11382f] outline-none"
                />
              </div>
            </div>
          </div>

          {/* Customer / Debtor Selection Card */}
          <div className="rounded-2xl border border-[#e1e9e3] bg-[#fafcfb] p-3.5 sm:p-4 relative">
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-extrabold text-[#143d35] flex items-center gap-1.5">
                <User size={15} className="text-[#0e655d]" />
                Customer Details <span className="text-[#c25e19]">*</span>
              </label>

              {matchedCustomer && (
                <div className="flex items-center gap-2">
                  {matchedCustomer.uid && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[#e3f4ee] px-2 py-0.5 font-mono text-[10px] font-extrabold text-[#0e655d]">
                      <BadgeCheck size={12} /> {matchedCustomer.uid}
                    </span>
                  )}
                  {Number(matchedCustomer.current_balance) > 0 && (
                    <span className="rounded-md bg-[#fef1ec] px-2 py-0.5 text-[10px] font-extrabold text-[#c25e19]">
                      Owes: ₹{Number(matchedCustomer.current_balance).toLocaleString('en-IN')}
                    </span>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {/* Name Input with Autocomplete */}
              <div className="relative">
                <input
                  type="text"
                  required
                  placeholder="Enter or search customer name"
                  value={partyName}
                  onFocus={() => setShowSuggestions(true)}
                  onChange={(e) => {
                    setPartyName(e.target.value)
                    setShowSuggestions(true)
                  }}
                  className="w-full rounded-xl border border-[#d8e3de] bg-white px-3.5 py-2.5 text-xs font-bold text-[#11382f] outline-none focus:border-[#0e655d] placeholder:font-normal placeholder:text-[#8ea59d] transition"
                />

                {/* Suggestions Dropdown */}
                {showSuggestions && customerSuggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-30 max-h-48 overflow-y-auto rounded-xl border border-[#d8e3de] bg-white p-1 shadow-lg">
                    {customerSuggestions.map((c) => (
                      <button
                        key={c.id || c.name}
                        type="button"
                        onClick={() => handleSelectCustomer(c)}
                        className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-xs hover:bg-[#eef7f3] transition"
                      >
                        <span className="font-bold text-[#11382f]">{c.name}</span>
                        <div className="flex items-center gap-2 text-[10px] text-[#6e8a81]">
                          {c.uid && <span className="font-mono text-[#0e655d]">{c.uid}</span>}
                          {Number(c.current_balance) > 0 && (
                            <span className="text-[#c25e19] font-bold">
                              ₹{Number(c.current_balance).toLocaleString('en-IN')}
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Phone / WhatsApp Input */}
              <div className="flex items-center gap-2 rounded-xl border border-[#d8e3de] bg-white px-3 py-2 focus-within:border-[#0e655d] transition">
                <Phone size={14} className="text-[#78968d] shrink-0" />
                <input
                  type="tel"
                  placeholder="+91 98765 43210 (WhatsApp invoice)"
                  value={partyPhone}
                  onChange={(e) => setPartyPhone(e.target.value)}
                  className="w-full bg-transparent text-xs font-semibold text-[#11382f] outline-none placeholder:font-normal placeholder:text-[#8ea59d]"
                />
              </div>
            </div>

            {/* Quick Customer Selection Chips */}
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold text-[#7c968e] mr-1">Frequent:</span>
              {[
                ...parties.slice(0, 4).map((p) => ({ name: p.name, phone: p.phone || '' })),
                { name: 'Walk-in customer', phone: '' },
              ].map((cust) => (
                <button
                  key={cust.name}
                  type="button"
                  onClick={() => handleSelectCustomer(cust)}
                  className={`rounded-lg px-2 py-0.5 text-[11px] font-bold transition ${
                    partyName === cust.name
                      ? 'bg-[#0e655d] text-white shadow-2xs'
                      : 'border border-[#d8e3de] bg-white text-[#44655b] hover:bg-[#edf5f1]'
                  }`}
                >
                  {cust.name}
                </button>
              ))}
            </div>
          </div>

          {/* Line Items Table / Products */}
          <div className="rounded-2xl border border-[#e1e9e3] bg-[#fafcfb] p-3.5 sm:p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-extrabold text-[#11382f] flex items-center gap-1.5">
                <Box size={15} className="text-[#0e655d]" />
                Invoice Items ({items.length})
              </span>
              <button
                type="button"
                onClick={addItem}
                className="inline-flex items-center gap-1 rounded-xl bg-[#0e655d] px-3 py-1 text-[11px] font-extrabold text-white hover:bg-[#0a4e47] transition shadow-2xs active:scale-98"
              >
                <Plus size={13} /> Add item
              </button>
            </div>

            <div className="space-y-2.5">
              {items.map((it, idx) => {
                const selectedMat = materials.find((m) => String(m.id) === String(it.material_id))
                const currentStock = selectedMat ? selectedMat.current_qty : null

                return (
                  <div
                    key={idx}
                    className="rounded-2xl border border-[#e2e9e4] bg-white p-3 shadow-2xs transition hover:border-[#ccdcd2]"
                  >
                    <div className="grid grid-cols-12 gap-2 items-center">
                      {/* Product Selection */}
                      <div className="col-span-12 sm:col-span-5">
                        <select
                          value={it.material_id}
                          onChange={(e) => updateItem(idx, 'material_id', e.target.value)}
                          className="w-full rounded-xl border border-[#d8e3de] bg-[#fafcfb] px-3 py-2 text-xs font-bold text-[#11382f] outline-none focus:border-[#0e655d]"
                        >
                          <option value="">-- Select Inventory Product --</option>
                          {materials.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name} · ({m.current_qty} {m.unit || 'pcs'} stock · ₹{m.sales_rate})
                            </option>
                          ))}
                        </select>
                        {selectedMat && (
                          <div className="mt-1 flex items-center gap-2 text-[10px] text-[#6d8a80]">
                            <span>SKU: {selectedMat.sku || 'N/A'}</span>
                            <span
                              className={`font-bold ${
                                currentStock <= (selectedMat.reorder_level || 10)
                                  ? 'text-[#c25e19]'
                                  : 'text-[#0d786d]'
                              }`}
                            >
                              Stock: {currentStock} {selectedMat.unit || 'pcs'}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Quantity with + / - controls */}
                      <div className="col-span-5 sm:col-span-3">
                        <label className="block text-[10px] font-bold text-[#748f86] mb-0.5">
                          Quantity ({it.unit || 'pcs'})
                        </label>
                        <div className="flex items-center rounded-xl border border-[#d8e3de] bg-[#fafcfb] overflow-hidden">
                          <button
                            type="button"
                            onClick={() => changeQty(idx, -1)}
                            className="grid h-8 w-8 place-items-center text-[#55736a] hover:bg-[#eaf3ef] transition"
                            title="Decrease quantity"
                          >
                            <Minus size={13} />
                          </button>
                          <input
                            type="number"
                            min="1"
                            value={it.qty}
                            onChange={(e) => updateItem(idx, 'qty', e.target.value)}
                            className="w-full bg-transparent text-center text-xs font-extrabold text-[#11382f] outline-none py-1"
                          />
                          <button
                            type="button"
                            onClick={() => changeQty(idx, 1)}
                            className="grid h-8 w-8 place-items-center text-[#55736a] hover:bg-[#eaf3ef] transition"
                            title="Increase quantity"
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                      </div>

                      {/* Selling Price / Rate */}
                      <div className="col-span-4 sm:col-span-2">
                        <label className="block text-[10px] font-bold text-[#748f86] mb-0.5">
                          Rate (₹)
                        </label>
                        <div className="flex items-center rounded-xl border border-[#d8e3de] bg-[#fafcfb] px-2 py-1.5 focus-within:border-[#0e655d] focus-within:bg-white transition">
                          <span className="text-[11px] text-[#78968d] font-bold mr-0.5">₹</span>
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={it.rate}
                            onChange={(e) => updateItem(idx, 'rate', e.target.value)}
                            className="w-full bg-transparent text-xs font-extrabold text-[#11382f] outline-none text-right"
                          />
                        </div>
                      </div>

                      {/* Item Total & Delete */}
                      <div className="col-span-3 sm:col-span-2 flex items-center justify-end gap-2 pl-1">
                        <div className="text-right">
                          <span className="block text-[10px] text-[#748f86]">Total</span>
                          <strong className="text-xs font-extrabold text-[#11382f]">
                            ₹{(Number(it.amount) || 0).toLocaleString('en-IN')}
                          </strong>
                        </div>
                        {items.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeItem(idx)}
                            className="grid h-7 w-7 place-items-center rounded-lg text-[#9cb0a8] hover:bg-[#fdeeed] hover:text-[#ba3b2a] transition"
                            title="Remove item"
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Bill Summary Breakdown */}
            <div className="mt-3.5 space-y-2 pt-3 border-t border-[#e2e9e4]">
              {/* Subtotal */}
              <div className="flex items-center justify-between text-xs text-[#5e7c73]">
                <span>Items Subtotal</span>
                <span className="font-bold text-[#11382f]">₹{subtotal.toLocaleString('en-IN')}</span>
              </div>

              {/* Discount Row */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[#5e7c73]">Discount:</span>
                  <div className="flex items-center rounded-lg border border-[#d8e3de] bg-white px-2 py-0.5">
                    <input
                      type="number"
                      min="0"
                      value={discountVal || ''}
                      placeholder="0"
                      onChange={(e) => setDiscountVal(Number(e.target.value) || 0)}
                      className="w-14 text-xs font-bold text-[#11382f] outline-none text-right bg-transparent"
                    />
                    <button
                      type="button"
                      onClick={() => setDiscountType(discountType === 'flat' ? 'percent' : 'flat')}
                      className="ml-1 text-[10px] font-extrabold text-[#0e655d]"
                    >
                      {discountType === 'flat' ? '₹ Flat' : '% Off'}
                    </button>
                  </div>
                </div>
                <span className="font-bold text-[#c25e19]">
                  {discountAmount > 0 ? `- ₹${discountAmount.toLocaleString('en-IN')}` : '₹0'}
                </span>
              </div>

              {/* Tax / GST Row */}
              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[#5e7c73]">GST / Tax:</span>
                  <div className="flex items-center gap-1">
                    {[0, 5, 12, 18].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => setTaxPercent(pct)}
                        className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold transition ${
                          taxPercent === pct
                            ? 'bg-[#0e655d] text-white'
                            : 'bg-white border border-[#d8e3de] text-[#44655b] hover:bg-[#edf5f1]'
                        }`}
                      >
                        {pct === 0 ? 'None' : `${pct}%`}
                      </button>
                    ))}
                  </div>
                </div>
                <span className="font-bold text-[#11382f]">
                  {taxAmount > 0 ? `+ ₹${taxAmount.toLocaleString('en-IN')}` : '₹0'}
                </span>
              </div>

              {/* Grand Total Banner */}
              <div className="flex items-center justify-between rounded-2xl bg-[#0e655d] px-4 py-3 text-white shadow-xs">
                <div>
                  <span className="text-[11px] font-medium text-[#c4e4dc] uppercase tracking-wider block">
                    Grand Total
                  </span>
                  <span className="text-xs text-[#dff1ec]">
                    {items.length} line {items.length === 1 ? 'item' : 'items'}
                  </span>
                </div>
                <strong className="text-xl sm:text-2xl font-extrabold tracking-tight">
                  ₹{totalAmount.toLocaleString('en-IN')}
                </strong>
              </div>
            </div>
          </div>

          {/* Payment & Settlement Card */}
          <div className="rounded-2xl border border-[#e1e9e3] bg-white p-4 space-y-3 shadow-2xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-extrabold text-[#11382f] flex items-center gap-1.5">
                <CreditCard size={15} className="text-[#0e655d]" />
                Payment Mode &amp; Settlement
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-extrabold ${
                  dueAmount > 0
                    ? 'bg-[#fef3eb] text-[#c25e19]'
                    : 'bg-[#e2f3ec] text-[#0d786d]'
                }`}
              >
                {dueAmount > 0 ? `Due: ₹${dueAmount.toLocaleString('en-IN')}` : 'Paid in Full'}
              </span>
            </div>

            {/* Payment Mode Chips */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {[
                { id: 'Cash', label: 'Cash (Full)' },
                { id: 'UPI', label: 'UPI / QR' },
                { id: 'HDFC Bank', label: 'Bank / NEFT' },
                { id: 'Credit', label: 'Credit (Due)' },
                { id: 'Partial', label: 'Split / Partial' },
              ].map((pm) => (
                <button
                  key={pm.id}
                  type="button"
                  onClick={() => handlePaymentModeSelect(pm.id)}
                  className={`rounded-xl py-2 px-1 text-xs font-bold transition text-center ${
                    paymentMode === pm.id
                      ? 'bg-[#0e655d] text-white shadow-2xs'
                      : 'border border-[#d8e3de] bg-[#f8faf9] text-[#44655b] hover:bg-[#eef7f3]'
                  }`}
                >
                  {pm.label}
                </button>
              ))}
            </div>

            {/* Paid Amount vs Balance Due */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-bold text-[#143d35]">
                    Amount Received Upfront
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setIsCustomPaid(false)
                      setPaidAmount(totalAmount)
                      setPaymentMode('Cash')
                    }}
                    className="text-[10px] font-bold text-[#0e655d] hover:underline"
                  >
                    Set Full
                  </button>
                </div>
                <div className="flex items-center gap-1 rounded-xl border border-[#d8e3de] px-3 py-2 bg-[#fafcfb] focus-within:border-[#0e655d] focus-within:bg-white transition">
                  <span className="text-xs text-[#718d84] font-bold">₹</span>
                  <input
                    type="number"
                    min="0"
                    max={totalAmount}
                    value={paidAmount}
                    onChange={(e) => {
                      setIsCustomPaid(true)
                      setPaidAmount(Number(e.target.value) || 0)
                    }}
                    className="w-full bg-transparent text-xs font-extrabold text-[#11382f] outline-none text-right"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-[#143d35] mb-1">
                  Closing Balance Outstanding
                </label>
                <div className="flex items-center justify-between rounded-xl border border-[#d8e3de] px-3 py-2 bg-[#fafcfb]">
                  <strong
                    className={`text-xs font-extrabold ${
                      dueAmount > 0 ? 'text-[#c25e19]' : 'text-[#0e655d]'
                    }`}
                  >
                    ₹{dueAmount.toLocaleString('en-IN')}
                  </strong>
                  <span
                    className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                      dueAmount > 0
                        ? 'bg-[#fef1ec] text-[#c25e19]'
                        : 'bg-[#e2f3ec] text-[#0d786d]'
                    }`}
                  >
                    {dueAmount > 0 ? 'Credit Dues' : 'Settled'}
                  </span>
                </div>
              </div>
            </div>

            {dueAmount > 0 && (
              <p className="text-[11px] text-[#6d8a80] leading-relaxed bg-[#f8fbf9] p-2.5 rounded-xl border border-[#e1ece6]">
                💡 Outstanding balance of <strong>₹{dueAmount.toLocaleString('en-IN')}</strong> will automatically appear in <strong>Debtors</strong> aging and the evening WhatsApp summary.
              </p>
            )}
          </div>

          {/* Narration / Notes */}
          <div>
            <label className="block text-xs font-bold text-[#143d35] mb-1">
              Invoice Remarks / Footer Note
            </label>
            <input
              type="text"
              placeholder="e.g. Thank you for your business! Delivered via counter."
              value={narration}
              onChange={(e) => setNarration(e.target.value)}
              className="w-full rounded-2xl border border-[#d8e3de] bg-[#fafcfb] px-3.5 py-2.5 text-xs font-medium text-[#11382f] outline-none focus:border-[#0e655d] focus:bg-white transition"
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="flex items-center gap-2 rounded-2xl border border-[#f5d0c8] bg-[#fff4f2] p-3 text-xs font-semibold text-[#b43c29]">
              <AlertCircle size={15} className="shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-[#edf3f0] shrink-0">
            <div className="w-full sm:w-auto">
              <span className="block text-[11px] text-[#6d8a80]">Payable Amount</span>
              <strong className="text-lg font-extrabold text-[#11382f]">
                ₹{totalAmount.toLocaleString('en-IN')}
              </strong>
            </div>

            <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl border border-[#d6e2dd] bg-white px-4 py-2.5 text-xs font-bold text-[#55736a] hover:bg-[#f2f7f4] transition"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={loading}
                onClick={() => handleSaveInternal(true)}
                className="inline-flex items-center gap-1.5 rounded-2xl border border-[#0e655d] bg-[#f0f9f5] px-4 py-2.5 text-xs font-extrabold text-[#0e655d] hover:bg-[#e2f3ec] disabled:opacity-50 transition"
              >
                <Printer size={15} />
                <span>Save &amp; Print</span>
              </button>

              <button
                type="submit"
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-5 py-2.5 text-xs font-extrabold text-white shadow-xs hover:bg-[#094e48] disabled:opacity-50 transition active:scale-98"
              >
                <CheckCircle2 size={15} />
                {loading
                  ? 'Saving Invoice…'
                  : editingVoucher
                  ? 'Update Invoice'
                  : 'Save & Create Invoice'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
