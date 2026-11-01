import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { isAuthenticated, isAdmin, loading } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 bg-[#f4f7f4] text-[#11382f]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#0e655d] border-t-transparent" />
        <span className="text-xs font-bold text-[#56736a]">Loading books…</span>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (adminOnly && !isAdmin) {
    return <Navigate to="/" replace />
  }

  return children
}
