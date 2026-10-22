import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

/** Postgres / PostgREST codes for "no such column" (or table). */
const MISSING = new Set(['42703', 'PGRST204', '42P01', 'PGRST205'])

/**
 * Whether a migration's column exists yet, so a screen can ship before it is
 * applied and show the new control only after (0016: links, job titles).
 * True only once seen; while loading, or if the read fails, callers fall back
 * to what worked before.
 */
export function useHasColumn(table: string, column: string): boolean {
  const { data } = useQuery({
    queryKey: ['has-column', table, column],
    queryFn: async (): Promise<boolean> => {
      const { error } = await supabase.from(table).select(column).limit(0)
      if (error?.code && MISSING.has(error.code)) return false
      if (error) throw error
      return true
    },
    staleTime: 30 * 60_000,
  })
  return data === true
}
