import { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import Login from './pages/Login'

// Route-level code splitting matching PDF specification
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const DebtorsPage = lazy(() => import('./pages/DebtorsPage'))
const CreditorsPage = lazy(() => import('./pages/CreditorsPage'))
const SalesPage = lazy(() => import('./pages/SalesPage'))
const InventoryPage = lazy(() => import('./pages/InventoryPage'))
const ExpensesPage = lazy(() => import('./pages/ExpensesPage'))
const LoansPage = lazy(() => import('./pages/LoansPage'))
const TallyIntegrationPage = lazy(() => import('./pages/TallyIntegrationPage'))
const SettingsControlPage = lazy(() => import('./pages/SettingsControlPage'))

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Suspense
          fallback={
            <div className="min-h-screen bg-[#f4f7f4] flex items-center justify-center text-[#11382f]">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-[#0e655d] border-t-transparent rounded-full animate-spin" />
                <span className="text-xs font-bold text-[#55736a]">Loading books...</span>
              </div>
            </div>
          }
        >
          <Routes>
            <Route path="/login" element={<Login />} />

            {/* Dashboard routes */}
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <DashboardPage />
                </ProtectedRoute>
              }
            />

            {/* Debtors / Parties */}
            <Route
              path="/debtors"
              element={
                <ProtectedRoute>
                  <DebtorsPage />
                </ProtectedRoute>
              }
            />
            <Route path="/parties" element={<Navigate to="/debtors" replace />} />

            {/* Creditors */}
            <Route
              path="/creditors"
              element={
                <ProtectedRoute>
                  <CreditorsPage />
                </ProtectedRoute>
              }
            />

            {/* Sales */}
            <Route
              path="/sales"
              element={
                <ProtectedRoute>
                  <SalesPage />
                </ProtectedRoute>
              }
            />

            {/* Inventory / Stock */}
            <Route
              path="/inventory"
              element={
                <ProtectedRoute>
                  <InventoryPage />
                </ProtectedRoute>
              }
            />
            <Route path="/stock" element={<Navigate to="/inventory" replace />} />
            <Route path="/materials" element={<Navigate to="/inventory" replace />} />

            {/* Expenses */}
            <Route
              path="/expenses"
              element={
                <ProtectedRoute>
                  <ExpensesPage />
                </ProtectedRoute>
              }
            />

            {/* Loans & Advances */}
            <Route
              path="/loans"
              element={
                <ProtectedRoute>
                  <LoansPage />
                </ProtectedRoute>
              }
            />
            <Route path="/banking" element={<Navigate to="/loans" replace />} />

            {/* Tally Import */}
            <Route
              path="/tally"
              element={
                <ProtectedRoute adminOnly>
                  <TallyIntegrationPage />
                </ProtectedRoute>
              }
            />
            <Route path="/imports" element={<Navigate to="/tally" replace />} />

            {/* App Settings & Admin Control */}
            <Route
              path="/settings"
              element={
                <ProtectedRoute adminOnly>
                  <SettingsControlPage />
                </ProtectedRoute>
              }
            />
            <Route
              path="/control"
              element={
                <ProtectedRoute adminOnly>
                  <SettingsControlPage />
                </ProtectedRoute>
              }
            />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </BrowserRouter>
  )
}
