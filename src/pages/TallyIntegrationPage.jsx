import { useState, useRef, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Upload,
  FileCode,
  CheckCircle2,
  Download,
  X,
  Sparkles,
  RefreshCw,
} from 'lucide-react'
import { accDb } from '../lib/accountingDb'
import {
  parseTallyXml,
  parseTallyExcel,
  importTallyDataToDb,
  SAMPLE_TALLY_XML,
} from '../lib/tallyParser'
import { syncFromSupabase } from '../lib/syncService'
import Nav from '../components/Nav'

export default function TallyIntegrationPage() {
  const navigate = useNavigate()
  const fileInputRef = useRef(null)

  const [activeTab, setActiveTab] = useState('Transactions') // 'Masters' | 'Transactions'
  const [selectedFile, setSelectedFile] = useState(null)
  const [parsedDataset, setParsedDataset] = useState(null)
  const [showProblemsView, setShowProblemsView] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importSuccess, setImportSuccess] = useState(null)
  const [recentImports, setRecentImports] = useState([])
  const [cloudSyncing, setCloudSyncing] = useState(false)

  // Problem items matching PDF Page 12 (empty by default; populated on simulated test or real parse issues)
  const [problems, setProblems] = useState([])

  const handleToggleProblemsView = () => {
    if (!showProblemsView) {
      if (problems.length === 0) {
        setProblems([
          {
            id: 1,
            where: 'Voucher 128 · 14 Oct',
            problem: 'Customer “Rahul Hub” is not in the masters',
            howToFix: 'Import masters first',
            actionLabel: 'Import masters',
            resolved: false,
          },
          {
            id: 2,
            where: 'Item “Case A12”',
            problem: 'Stock item has no unit or price',
            howToFix: 'Add it in Tally, then re-export',
            actionLabel: 'Skip item',
            resolved: false,
          },
          {
            id: 3,
            where: 'Voucher 131 · 15 Oct',
            problem: 'Date could not be read',
            howToFix: 'Re-export the Day Book as XML',
            actionLabel: 'Skip voucher',
            resolved: false,
          },
        ])
      }
      setShowProblemsView(true)
    } else {
      setShowProblemsView(false)
    }
  }

  // Load recent imports log from Dexie
  const loadRecentImports = useCallback(async () => {
    try {
      const dbImports = await accDb.imports.reverse().limit(10).toArray()
      if (dbImports && dbImports.length > 0) {
        setRecentImports(
          dbImports.map((imp) => ({
            id: imp.id,
            date: imp.date,
            filename: imp.filename,
            badge: imp.status || `${imp.added_count || 0} added`,
            badgeTone:
              (imp.problems_count || 0) > 0
                ? 'bg-[#fef1ec] text-[#c25e19]'
                : 'bg-[#e2f3ec] text-[#0d786d]',
          }))
        )
      } else {
        setRecentImports([])
      }
    } catch {
      setRecentImports([])
    }
  }, [])

  useEffect(() => {
    loadRecentImports()
  }, [loadRecentImports])

  // Handle Real File Upload and Parser Invocation
  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const isXml = file.name.endsWith('.xml')
      const isExcel = file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv')

      let parsed = null

      if (isXml) {
        const text = await file.text()
        parsed = parseTallyXml(text)
      } else if (isExcel) {
        parsed = await parseTallyExcel(file)
      } else {
        alert('Unsupported file format. Please upload Tally XML, Excel (.xlsx), or CSV.')
        return
      }

      setParsedDataset(parsed)

      const vouchersCount = parsed.vouchers?.length || 0
      const mastersCount = (parsed.ledgers?.length || 0) + (parsed.stockItems?.length || 0)
      const count = vouchersCount > 0 ? vouchersCount : mastersCount

      setSelectedFile({
        name: file.name,
        status: 'Ready to import',
        voucherCount: vouchersCount > 0 ? `${vouchersCount} vouchers` : `${mastersCount} master items`,
        newCount: count,
        skippedCount: 0,
        updatedCount: 0,
        problemsCount: 0,
      })
      setShowProblemsView(false)
    } catch (err) {
      console.error('File parsing error:', err)
      alert(`Could not parse Tally file: ${err.message}`)
    }
  }

  // Built-in Demo Tally File Loader
  const handleLoadDemoTally = () => {
    try {
      const parsed = parseTallyXml(SAMPLE_TALLY_XML)
      setParsedDataset(parsed)
      const vouchersCount = parsed.vouchers.length
      const mastersCount = parsed.ledgers.length + parsed.stockItems.length

      setSelectedFile({
        name: 'TallyPrime_Export_Sample.xml',
        status: 'Parsed & ready to import',
        voucherCount: `${vouchersCount} vouchers, ${mastersCount} masters`,
        newCount: vouchersCount + mastersCount,
        skippedCount: 0,
        updatedCount: 0,
        problemsCount: 0,
      })
      setShowProblemsView(false)
    } catch (err) {
      alert(`Error loading sample Tally data: ${err.message}`)
    }
  }

  // Import into DB
  const handleImportNow = async () => {
    if (!selectedFile) return
    setImporting(true)

    try {
      let finalResult = { newCount: selectedFile.newCount || 0, skippedCount: 0, updatedCount: 0 }

      if (parsedDataset) {
        finalResult = await importTallyDataToDb(parsedDataset)
      }

      const logEntry = {
        filename: selectedFile.name,
        date: 'Today, ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        added_count: finalResult.newCount,
        skipped_count: finalResult.skippedCount,
        status: `${finalResult.newCount} added`,
        problems_count: finalResult.problems?.length || 0,
      }

      await accDb.imports.add(logEntry)
      await loadRecentImports()

      setImportSuccess(
        `Successfully imported ${finalResult.newCount} entries! (${finalResult.skippedCount} skipped, ${finalResult.updatedCount} updated)`
      )

      window.dispatchEvent(new Event('accounting-data-updated'))

      setTimeout(() => {
        setImporting(false)
        setImportSuccess(null)
        navigate('/')
      }, 1500)
    } catch (err) {
      console.error('Import failure:', err)
      alert(`Import error: ${err.message}`)
      setImporting(false)
    }
  }

  const handleResolveProblem = (id) => {
    setProblems(problems.map((p) => (p.id === id ? { ...p, resolved: true } : p)))
  }

  const handleCloudSync = async () => {
    setCloudSyncing(true)
    try {
      const res = await syncFromSupabase()
      if (res.success) {
        setImportSuccess(
          `Synced from Cloud: ${res.counts.vouchers} vouchers, ${res.counts.parties} parties, and ${res.counts.ledgers} ledgers loaded into local database!`
        )
        const logEntry = {
          filename: 'Supabase Cloud Sync',
          date: 'Today, ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          added_count: res.counts.vouchers + res.counts.parties,
          skipped_count: 0,
          status: `${res.counts.vouchers} vouchers live`,
          problems_count: 0,
        }
        await accDb.imports.add(logEntry)
        await loadRecentImports()
      } else {
        alert('Cloud sync notice: ' + (res.error || 'Failed to sync'))
      }
    } catch (e) {
      alert('Cloud sync error: ' + e.message)
    } finally {
      setCloudSyncing(false)
    }
  }

  const handleDownloadErrorReport = () => {
    const rows = [
      ['Tally Import Error Report'],
      ['Generated On', new Date().toLocaleString()],
      [],
      ['Where', 'Problem', 'How To Fix', 'Status'],
      ...problems.map((p) => [p.where, p.problem, p.howToFix, p.resolved ? 'Resolved' : 'Pending']),
    ]
    const csvContent = 'data:text/csv;charset=utf-8,' + rows.map((e) => e.join(',')).join('\n')
    const encodedUri = encodeURI(csvContent)
    const link = document.createElement('a')
    link.setAttribute('href', encodedUri)
    link.setAttribute('download', `Tally_Import_Errors_${new Date().toISOString().slice(0, 10)}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  // Download sample XML file
  const handleDownloadSampleXml = () => {
    const blob = new Blob([SAMPLE_TALLY_XML], { type: 'application/xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'Sample_TallyPrime_Export.xml'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="min-h-screen bg-[#f4f7f4] pb-24 lg:pl-64 lg:pb-10 font-sans">
      <Nav />

      <main className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 sm:pt-6">
        {/* Top Header matching PDF Page 4 (Mobile) & Page 11 (Desktop) */}
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="text-xs font-semibold text-[#5e7c73]">Tally data</span>
            <h1 className="text-[24px] font-extrabold tracking-tight text-[#11382f]">
              {showProblemsView ? '3 problems found' : 'Import from Tally'}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Supabase Cloud Sync Button */}
            <button
              type="button"
              onClick={handleCloudSync}
              disabled={cloudSyncing}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#0e655d] bg-[#0e655d] px-3.5 py-1.5 text-xs font-bold text-white hover:bg-[#0b534d] transition shadow-xs disabled:opacity-50"
              title="Pull latest live vouchers and masters from Supabase Cloud"
            >
              <RefreshCw size={14} className={cloudSyncing ? 'animate-spin' : ''} />
              <span>{cloudSyncing ? 'Syncing...' : 'Sync from Supabase'}</span>
            </button>

            {/* Quick Demo Button */}
            <button
              type="button"
              onClick={handleLoadDemoTally}
              className="inline-flex items-center gap-1.5 rounded-xl border border-[#0e655d] bg-[#eef7f3] px-3 py-1.5 text-xs font-bold text-[#0e655d] hover:bg-[#e1f0e9] transition"
              title="Load built-in Tally XML export for testing"
            >
              <Sparkles size={14} />
              <span>Load Demo Tally XML</span>
            </button>

            {/* Toggle to inspect error resolution view (PDF Page 12) */}
            <button
              type="button"
              onClick={handleToggleProblemsView}
              className={`rounded-xl px-3 py-1.5 text-xs font-bold transition border ${
                showProblemsView
                  ? 'bg-[#c25e19] text-white border-[#c25e19]'
                  : 'bg-white text-[#526f66] border-[#d6e3dc] hover:bg-[#eef6f2]'
              }`}
            >
              {showProblemsView ? 'Back to upload' : 'Simulate 3 Problems (Page 12)'}
            </button>

            {/* Masters / Transactions Tabs */}
            <div className="flex rounded-2xl bg-white p-1 border border-[#e1e9e3] shadow-xs">
              <button
                type="button"
                onClick={() => setActiveTab('Masters')}
                className={`rounded-xl px-4 py-1.5 text-xs font-bold transition ${
                  activeTab === 'Masters'
                    ? 'bg-[#0e655d] text-white shadow-xs'
                    : 'text-[#5d776f] hover:text-[#0e655d]'
                }`}
              >
                Masters
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('Transactions')}
                className={`rounded-xl px-4 py-1.5 text-xs font-bold transition ${
                  activeTab === 'Transactions'
                    ? 'bg-[#0e655d] text-white shadow-xs'
                    : 'text-[#5d776f] hover:text-[#0e655d]'
                }`}
              >
                Transactions
              </button>
            </div>
          </div>
        </header>

        {/* Success Banner */}
        {importSuccess && (
          <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-[#b6e2d1] bg-[#e6f7f0] p-4 text-xs font-bold text-[#0c6b5e] shadow-xs animate-in fade-in">
            <CheckCircle2 size={18} className="shrink-0" />
            <span>{importSuccess}</span>
          </div>
        )}

        {/* ================= IF PROBLEMS FOUND (PDF Page 12) ================= */}
        {showProblemsView ? (
          <div>
            {/* Warning Banner */}
            <div className="mb-6 rounded-2xl border border-[#fae2db] bg-[#fff5f2] p-4 text-xs text-[#a33725] shadow-xs">
              <strong>Nothing was imported.</strong> Fix or skip these items, then try again. Your owner still sees the last good data (17 Oct, 4:30 PM).
            </div>

            {/* Problems Table */}
            <div className="rounded-3xl border border-[#e1e9e3] bg-white overflow-hidden shadow-xs mb-6">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#e5ece8] bg-[#f8faf8] text-[11px] font-extrabold uppercase tracking-wider text-[#69857d]">
                      <th className="py-3.5 px-5">WHERE</th>
                      <th className="py-3.5 px-5">PROBLEM</th>
                      <th className="py-3.5 px-5">HOW TO FIX</th>
                      <th className="py-3.5 px-5 text-right">ACTION</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#edf3f0]">
                    {problems.map((prob) => (
                      <tr key={prob.id} className={prob.resolved ? 'bg-[#f4f9f6] opacity-60' : ''}>
                        <td className="py-4 px-5 font-bold text-[#11382f] whitespace-nowrap">
                          {prob.where}
                        </td>
                        <td className="py-4 px-5 font-medium text-[#2d4b42]">
                          {prob.problem}
                        </td>
                        <td className="py-4 px-5 text-[#5e7c73]">
                          {prob.howToFix}
                        </td>
                        <td className="py-4 px-5 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => handleResolveProblem(prob.id)}
                            disabled={prob.resolved}
                            className={`rounded-xl border px-3.5 py-1.5 text-xs font-bold transition ${
                              prob.resolved
                                ? 'border-[#b5dcd0] text-[#0e655d] bg-[#eef7f4]'
                                : 'border-[#b4d4ca] bg-white text-[#0e655d] hover:bg-[#0e655d] hover:text-white'
                            }`}
                          >
                            {prob.resolved ? 'Done ✓' : prob.actionLabel}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Error View Action Buttons */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowProblemsView(false)
                  handleImportNow()
                }}
                className="rounded-2xl bg-[#0e655d] px-5 py-2.5 text-xs font-bold text-white shadow-xs hover:bg-[#094f49] transition"
              >
                Retry import
              </button>
              <button
                type="button"
                onClick={handleDownloadErrorReport}
                className="rounded-2xl border border-[#cbe1d7] bg-white px-5 py-2.5 text-xs font-bold text-[#0e655d] hover:bg-[#eef7f3] transition"
              >
                Download error report
              </button>
            </div>
          </div>
        ) : (
          /* ================= NORMAL IMPORT & PREVIEW (PDF Page 4 & 11) ================= */
          <div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
              {/* Left Column: Dropzone & Selected File */}
              <div className="lg:col-span-8 space-y-4">
                {/* Drag and Drop Box */}
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="cursor-pointer rounded-3xl border-2 border-dashed border-[#0e655d] bg-[#f8faf8] p-8 text-center transition hover:bg-[#eef7f3] shadow-xs"
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    accept=".xml,.xlsx,.xls,.csv"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                  <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-[#e3f4ee] text-[#0e655d]">
                    <Upload size={22} strokeWidth={2.5} />
                  </div>
                  <strong className="block text-base font-extrabold text-[#11382f]">
                    Drop Tally files here
                  </strong>
                  <p className="mt-1 text-xs text-[#6e8a81]">
                    XML or Excel · Day Book, ledgers, stock items
                  </p>

                  <div className="mt-4 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        fileInputRef.current?.click()
                      }}
                      className="rounded-xl border border-[#c3ded4] bg-white px-4 py-2 text-xs font-bold text-[#145347] shadow-2xs hover:bg-[#eaf5ef] transition"
                    >
                      Choose files
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDownloadSampleXml()
                      }}
                      className="rounded-xl border border-[#e1e9e3] bg-white px-3 py-2 text-xs font-bold text-[#628077] hover:bg-[#f6f9f7] transition"
                    >
                      <Download size={14} className="inline mr-1" />
                      Download Sample XML
                    </button>
                  </div>
                </div>

                {/* Selected File Card (when a file is chosen or loaded) */}
                {selectedFile && (
                  <div className="flex items-center justify-between rounded-3xl border border-[#0e655d]/20 bg-[#f7faf8] p-5 shadow-xs">
                    <div>
                      <strong className="block text-sm font-extrabold text-[#11382f]">
                        {selectedFile.name}
                      </strong>
                      <span className="mt-0.5 block text-xs text-[#708d83]">
                        {selectedFile.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="rounded-xl bg-[#e3f3ec] px-3.5 py-1.5 text-xs font-extrabold text-[#0d786d]">
                        {selectedFile.voucherCount}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedFile(null)
                          setParsedDataset(null)
                        }}
                        className="rounded-lg p-1.5 text-[#708d83] hover:bg-[#ebf3ef] hover:text-[#c25e19] transition"
                        title="Remove file"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column: Preview & Action (5 cols on Desktop) */}
              <div className="lg:col-span-4 space-y-4">
                <div className="rounded-3xl border border-[#e1e9e3] bg-white p-6 shadow-xs">
                  <h2 className="text-sm font-extrabold text-[#11382f] pb-3 border-b border-[#edf3f0]">
                    Preview
                  </h2>

                  {selectedFile ? (
                    <>
                      <div className="divide-y divide-[#edf3f0] text-xs">
                        <div className="py-3 flex items-center justify-between">
                          <span className="font-semibold text-[#66837b]">New entries</span>
                          <strong className="font-extrabold text-[#11382f]">
                            {selectedFile.newCount || 0}
                          </strong>
                        </div>
                        <div className="py-3 flex items-center justify-between">
                          <span className="font-semibold text-[#66837b]">
                            Already imported (skipped)
                          </span>
                          <strong className="font-extrabold text-[#66837b]">
                            {selectedFile.skippedCount || 0}
                          </strong>
                        </div>
                        <div className="py-3 flex items-center justify-between">
                          <span className="font-semibold text-[#66837b]">Updated</span>
                          <strong className="font-extrabold text-[#11382f]">
                            {selectedFile.updatedCount || 0}
                          </strong>
                        </div>
                        <div className="py-3 flex items-center justify-between">
                          <span className="font-semibold text-[#66837b]">Problems</span>
                          <strong
                            className={`font-extrabold ${
                              (selectedFile.problemsCount || 0) > 0 ? 'text-[#c25e19]' : 'text-[#11382f]'
                            }`}
                          >
                            {selectedFile.problemsCount || 0}
                          </strong>
                        </div>
                      </div>

                      {/* Primary CTA Button matching PDF Page 4 & 11 */}
                      <button
                        type="button"
                        onClick={handleImportNow}
                        disabled={importing}
                        className="mt-6 w-full rounded-2xl bg-[#0e655d] py-3 text-center text-xs font-extrabold text-white shadow-xs hover:bg-[#0a4f49] disabled:opacity-50 transition active:scale-98"
                      >
                        {importing ? (
                          <span className="inline-flex items-center gap-2">
                            <RefreshCw size={14} className="animate-spin" />
                            Importing to Database…
                          </span>
                        ) : (
                          'Import and refresh owner view'
                        )}
                      </button>
                    </>
                  ) : (
                    <div className="py-8 text-center">
                      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-2xl bg-[#f0f6f3] text-[#52776c]">
                        <FileCode size={20} />
                      </div>
                      <strong className="block text-xs font-bold text-[#11382f]">
                        No file selected
                      </strong>
                      <p className="mt-1 text-[11px] text-[#708d83]">
                        Drop a Tally XML or Excel export on the left or click &ldquo;Load Demo Tally XML&rdquo; to preview vouchers and master entries.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Recent Imports Section matching PDF Page 11 */}
            <div className="mt-8">
              <h2 className="mb-3 text-[17px] font-extrabold text-[#11382f]">
                Recent imports
              </h2>

              {recentImports.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[#d6e3dc] bg-white p-6 text-center text-xs text-[#708d83]">
                  No import history yet. Upload your first Tally XML or Excel export above.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {recentImports.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-2xl border border-[#e1e9e3] bg-white p-4 shadow-2xs transition hover:shadow-xs"
                    >
                      <div className="min-w-0 pr-3">
                        <span className="block text-xs text-[#708c83]">{item.date}</span>
                        <strong className="mt-0.5 block truncate text-xs font-bold text-[#11382f]">
                          {item.filename}
                        </strong>
                      </div>

                      <span
                        className={`rounded-xl px-3 py-1 text-xs font-bold shrink-0 ${item.badgeTone}`}
                      >
                        {item.badge}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
