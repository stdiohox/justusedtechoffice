import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { LeaderboardRow } from '@/types/database'

/**
 * The weekly leaderboard (0012, scored on tasks and reports):
 * Friday to Friday at the end-of-day deadline, office time.
 * weeksAgo 0 is the week so far, 1 the week that last closed. The database
 * does the counting (office_leaderboard) and decides who may read it: the
 * whole team, the whole table. "Not available" until 0012 is applied, so the
 * screen and its menu item stay hidden.
 */

/** PostgREST / Postgres: "no function with those arguments". */
const MISSING = new Set(['42883', 'PGRST202'])

export const leaderboardKeys = {
  all: ['leaderboard'] as const,
  week: (weeksAgo: number) => ['leaderboard', weeksAgo] as const,
  available: () => ['leaderboard-available'] as const,
}

/**
 * Whether 0012 is applied, for the menu: asks for the week's dates (cheap),
 * not the whole board, and once per session.
 */
export function useLeaderboardAvailable() {
  return useQuery({
    queryKey: leaderboardKeys.available(),
    queryFn: async (): Promise<boolean> => {
      const { error } = await supabase.rpc('office_week_window', { p_weeks_ago: 0 })
      if (error?.code && MISSING.has(error.code)) return false
      if (error) throw error
      return true
    },
    staleTime: Infinity,
  })
}

export function useLeaderboard(weeksAgo: number) {
  return useQuery({
    queryKey: leaderboardKeys.week(weeksAgo),
    queryFn: async (): Promise<{ available: boolean; rows: LeaderboardRow[] }> => {
      const { data, error } = await supabase.rpc('office_leaderboard', { p_weeks_ago: weeksAgo })
      if (error?.code && MISSING.has(error.code)) return { available: false, rows: [] }
      if (error) throw error
      return {
        available: true,
        rows: ((data ?? []) as LeaderboardRow[]).map((r) => ({
          ...r,
          avg_rating: r.avg_rating == null ? null : Number(r.avg_rating),
        })),
      }
    },
    // The week so far moves; a closed one changes only if someone leaves.
    // Approving or rating a task invalidates both.
    staleTime: weeksAgo === 0 ? 60_000 : 10 * 60_000,
  })
}
