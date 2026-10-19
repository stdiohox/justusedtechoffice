import { useEffect, useState } from 'react'

/**
 * The current time, refreshed on an interval. For a clock shown in a lead's
 * own zone, which would otherwise read "4:12pm there now" for as long as the
 * page stays open. Thirty seconds keeps the minute at most half a minute stale
 * without re-rendering the page every second for a value shown to the minute.
 */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
