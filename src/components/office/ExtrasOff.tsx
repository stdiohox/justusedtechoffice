import type { ReactNode } from 'react'
import { EmptyState } from '@/components/ui/primitives'

/** A page from 0021 opened before the migration is applied: say so, never a blank screen. */
export function ExtrasOff({ icon, what }: { icon: ReactNode; what: string }) {
  return (
    <EmptyState
      icon={icon}
      title={`${what} is not switched on yet`}
      body="Ask Mr Tito: the office's database needs one more update (migration 0021)."
    />
  )
}
