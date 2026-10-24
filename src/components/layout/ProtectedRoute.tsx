import type { ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useOfficeRole } from '@/hooks/useOffice'
import { EmptyState, Button } from '@/components/ui/primitives'

/** Held until initialize() has resolved, so a signed-in person is never
 *  bounced to /login for the moment it takes to read the stored session. */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { session, initialized } = useAuthStore()
  const location = useLocation()
  if (!initialized) return <div className="min-h-[100dvh] bg-surface" />
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

/**
 * Settings is for the office admins: Mr Tito, HR (0017), and anyone labelled
 * manager (Hazel), who invite people and set roles there. Anyone else sees why,
 * and a way back; never a blank screen. Display only: RLS and the routes decide.
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  const { loading, isError, seesTeam } = useOfficeRole()
  const role = useAuthStore((s) => s.profile?.role)
  const isAdmin = seesTeam || role === 'manager'
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  if (loading) return <div className="min-h-[50dvh] bg-surface" />
  // A failed read is not "you are not the manager": offer to try again.
  if (isError) {
    return (
      <EmptyState
        title="Could not load the office"
        body="Check your connection and try again."
        action={
          <Button variant="secondary" onClick={() => void queryClient.invalidateQueries({ queryKey: ['office'] })}>
            Try again
          </Button>
        }
      />
    )
  }
  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldAlert size={22} strokeWidth={1.5} />}
        title="This area is for the office admins"
        body="Ask Mr Tito if you need something changed here."
        action={
          <Button variant="secondary" onClick={() => navigate('/office')}>
            Go to the office
          </Button>
        }
      />
    )
  }
  return <>{children}</>
}
