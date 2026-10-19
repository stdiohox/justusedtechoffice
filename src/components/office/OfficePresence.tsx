import { useOfficePresence } from '@/hooks/useOfficePresence'

/**
 * Presence, mounted once in the shell (0004, 0008). A component of its own
 * that renders nothing, so the state it reads every minute re-renders only
 * this, not the whole shell.
 */
export function OfficePresence() {
  useOfficePresence()
  return null
}
