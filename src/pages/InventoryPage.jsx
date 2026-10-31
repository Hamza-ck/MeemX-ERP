import { useState, useMemo, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ChevronLeft,
  Search,
  FileSpreadsheet,
  Edit3,
  X,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import Nav from '../components/Nav'
import { accDb, updateStockQty } from '../lib/accountingDb'
import AdminEditModal from '../components/AdminEditModal'

export default function InventoryPage() {
  const { isAdmin } = useAuth()
  const navigate = useNavigate()
  const [filter, setFilter] = useState('All') // 'All' | 'Low stock' | 'Slow moving'
  const [search, setSearch] = useState('')
  const [items, setItems] = useState([])
  const [adjustModal, setAdjustModal] = useState(null)
  const [newQty, setNewQty] = useState('')
  const [editingMaterial, setEditingMaterial] = useState(null)

  // Load materials from Dexie
  const loadMaterials = useCallback(async () => {
    try {
      const dbMats = await accDb.materials.toArray()
      if (dbMats && dbMats.length > 0) {
        setItems(dbMats)
      } else {
        setItems([])
      }
    } catch {
      setItems([])
    }
  }, [])

  useEffect(() => {
    loadMaterials()
    const onUpdate = () => loadMaterials()
    window.addEventListener('accounting-data-updated', onUpdate)
    return () => window.removeEventListener('accounting-data-updated', onUpdate)
  }, [loadMaterials])

  // Dynamic stock calculations
  const totalStockValue = useMemo(() => {
    return items.reduce((acc, it) => {
      const qty = Number(it.current_qty) || 0
      const costValue = it.current_value != null && Number.isFinite(Number(it.current_value))
        ? Number(it.current_value)
        : qty * (Number(it.purchase_rate) || 0)
      return acc + costValue
    }, 0)
  }, [items])

  const lowStockCount = useMemo(() => {
    return items.filter((it) => (Number(it.current_qty) || 0) <= (Number(it.reorder_threshold) || 10)).length
  }, [items])

  const filteredItems = useMemo(() => {
    let list = items
    if (filter === 'Low stock') {
      list = list.filter((it) => (Number(it.current_qty) || 0) <= (Number(it.reorder_threshold) || 10))
    } else if (filter === 'Slow moving') {
      list = list.filter((it) => it.isSlowMoving || (Number(it.current_qty) || 0) === 0)
    }

    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        (it.sku && it.sku.toLowerCase().includes(q))
    )
  }, [items, filter, search])

  // Save Adjusted Stock
  const handleSaveStock = async (e) => {
    e.preventDefault()
    if (!adjustModal) return
    const qty = Number(newQty) || 0

    try {
      if (adjustModal.id) {
        await updateStockQty(adjustModal.id, qty)
      }
      setAdjustModal(null)
      loadMaterials()
    } catch (err) {
      alert(`Could not update stock: ${err.message}`)
    }
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-2xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header with Back button and Tally Import button (PDF Page 7) */}
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="grid h-9 w-9 place-items-center rounded-xl bg-white text-[#153e34] shadow-2xs hover:bg-[#ebf4ef] transition"
              aria-label="Back to dashboard"
            >
              <ChevronLeft size={20} />
            </button>
            <h1 className="text-[22px] font-extrabold tracking-tight text-[#11382f]">
              Inventory
            </h1>
          </div>

          {isAdmin && (
            <button
              type="button"
              onClick={() => navigate('/tally')}
              className="flex items-center gap-1.5 rounded-2xl bg-[#0e655d] px-3.5 py-2 text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] transition active:scale-95"
              title="Import stock items and rates from Tally"
            >
              <FileSpreadsheet size={16} strokeWidth={2.5} />
              <span>Tally import</span>
            </button>
          )}
        </header>

        {/* Stock Value & Low Stock Dual Cards (PDF Page 7) */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4">
          <div className="rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs">
            <span className="text-xs font-bold text-[#6a847c]">Stock value</span>
            <strong className="mt-1 block text-[26px] font-extrabold tracking-tight text-[#11382f] sm:text-[32px]">
              ₹{(totalStockValue / 100000).toFixed(1)}L
            </strong>
          </div>

          <div className="rounded-3xl border border-[#e1e9e3] border-l-4 border-l-[#c25e19] bg-white p-5 shadow-xs">
            <span className="text-xs font-bold text-[#6a847c]">Low stock</span>
            <strong className="mt-1 block text-[26px] font-extrabold tracking-tight text-[#c25e19] sm:text-[32px]">
              {lowStockCount} items
            </strong>
          </div>
        </div>

        {/* Search Phone model or case input (PDF Page 7) */}
        <div className="mb-4 flex items-center gap-2 rounded-2xl border border-[#dbe6df] bg-white px-3.5 py-2.5 shadow-2xs focus-within:border-[#0e655d] transition">
          <Search size={18} className="text-[#7c978f] shrink-0" />
          <input
            type="text"
            className="w-full bg-transparent text-xs font-semibold text-[#11382f] outline-none placeholder:text-[#88a098]"
            placeholder="Search phone model, case or SKU..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {/* Filter Pills: All / Low stock / Slow moving (PDF Page 7) */}
        <div className="mb-4 flex items-center gap-2">
          {['All', 'Low stock', 'Slow moving'].map((pill) => (
            <button
              key={pill}
              type="button"
              onClick={() => setFilter(pill)}
              className={`rounded-xl px-4 py-1.5 text-xs font-bold transition ${
                filter === pill
                  ? 'bg-[#0e655d] text-white shadow-xs'
                  : 'bg-white border border-[#dce5df] text-[#557369] hover:bg-[#eef5f1]'
              }`}
            >
              {pill}
            </button>
          ))}
        </div>

        {/* Items List (PDF Page 7) */}
        <div className="space-y-3">
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => {
              const qty = Number(item.current_qty) || 0
              const thresh = Number(item.reorder_threshold) || 10
              const isLow = qty <= thresh
              const isZero = qty === 0

              const status = isZero ? 'Out of stock' : isLow ? 'Low' : 'Healthy'
              const statusTone = isZero
                ? 'bg-[#fbeee8] text-[#b84825]'
                : isLow
                ? 'bg-[#faece6] text-[#c05423]'
                : 'bg-[#e3f3ed] text-[#157a6c]'
              const barFill = isZero ? 'bg-[#b84825]' : isLow ? 'bg-[#c05423]' : 'bg-[#157a6c]'
              const barWidth = isZero ? '0%' : `${Math.min(100, Math.max(10, Math.round((qty / (thresh * 3)) * 100)))}%`
              const itemValue = item.current_value != null && Number.isFinite(Number(item.current_value))
                ? Number(item.current_value)
                : qty * (Number(item.purchase_rate) || 0)

              return (
                <article
                  key={item.id}
                  className="rounded-3xl border border-[#e1e9e3] bg-white p-5 shadow-xs transition hover:shadow-md"
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h2 className="text-[16px] font-extrabold text-[#11382f]">
                        {item.name}
                      </h2>
                      <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-[#718d84]">
                        <span>SKU {item.sku}</span>
                        <span>· ₹{item.sales_rate || item.purchase_rate || 0}</span>
                      </div>
                    </div>

                    <div className="text-right">
                      <strong className="block text-[17px] font-extrabold text-[#11382f]">
                        {qty} {item.unit || 'pcs'}
                      </strong>
                      <span
                        className={`mt-1 inline-block rounded-md px-2.5 py-0.5 text-[11px] font-bold ${statusTone}`}
                      >
                        {status}
                      </span>
                      <span className="mt-1 block text-[11px] font-semibold text-[#718d84]">
                        Stock value ₹{itemValue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  </div>

                  {/* Progress bar matching PDF */}
                  <div className="mt-4 flex h-2 w-full overflow-hidden rounded-full bg-[#e8ecea]">
                    <div
                      className={`h-full rounded-full ${barFill} transition-all`}
                      style={{ width: barWidth }}
                    />
                  </div>

                  {isAdmin && (
                    <div className="mt-3 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => setEditingMaterial(item)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[#cfded6] bg-[#f8faf9] px-2.5 py-1 text-[11px] font-bold text-[#0e655d] hover:bg-[#ebf3ef]"
                        title="Edit item master"
                      >
                        <Edit3 size={12} />
                        <span>Edit item</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setAdjustModal(item)
                          setNewQty(String(qty))
                        }}
                        className="text-[11px] font-bold text-[#0e655d] hover:underline"
                      >
                        Adjust stock quantity
                      </button>
                    </div>
                  )}
                </article>
              )
            })
          ) : (
            <div className="rounded-3xl border border-[#e1e9e3] bg-white p-8 text-center">
              <p className="text-sm font-bold text-[#11382f]">No inventory items found</p>
              <p className="text-xs text-[#6e8a81] mt-1">
                Import Stock Items from Tally XML to track materials and quantities.
              </p>
            </div>
          )}
        </div>

        {/* Admin Edit Modal */}
        <AdminEditModal
          isOpen={Boolean(editingMaterial)}
          onClose={() => setEditingMaterial(null)}
          type="material"
          item={editingMaterial}
          onSaved={() => loadMaterials()}
        />

        {/* Adjust Stock Quantity Modal */}
        {isAdmin && adjustModal && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs"
            onClick={() => setAdjustModal(null)}
          >
            <form
              onSubmit={handleSaveStock}
              className="w-full max-w-sm rounded-3xl bg-white p-6 shadow-2xl animate-in zoom-in-95"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between pb-3 border-b border-[#e5ebe7]">
                <h3 className="text-base font-extrabold text-[#11382f]">
                  Adjust Stock Quantity
                </h3>
                <button
                  type="button"
                  onClick={() => setAdjustModal(null)}
                  className="text-[#6d8a81]"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="mt-4 space-y-3">
                <div>
                  <span className="block text-xs text-[#6e8a81]">Item</span>
                  <strong className="block text-sm font-bold text-[#11382f]">
                    {adjustModal.name}
                  </strong>
                  <span className="text-xs text-[#7c978f] font-mono">
                    SKU: {adjustModal.sku}
                  </span>
                </div>
                <div>
                  <label className="block text-xs font-bold text-[#44655b] mb-1">
                    New Current Quantity ({adjustModal.unit || 'pcs'})
                  </label>
                  <input
                    type="number"
                    min="0"
                    required
                    className="w-full rounded-xl border border-[#d8e3de] px-3 py-2 text-xs text-[#11382f] font-bold outline-none focus:border-[#0e655d]"
                    value={newQty}
                    onChange={(e) => setNewQty(e.target.value)}
                  />
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAdjustModal(null)}
                  className="rounded-xl border border-[#d6e2dd] py-2.5 text-xs font-bold text-[#55736a]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-[#0e655d] py-2.5 text-xs font-bold text-white shadow-xs hover:bg-[#0a4f49]"
                >
                  Save Stock
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
    </div>
  )
}
