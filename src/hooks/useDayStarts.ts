import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/**
 * Work started before sign-in (0014). The office records nothing before the
 * sign-in report; someone who began earlier says when, and Mr Tito sees it
 * beside the evidence the office already has (their first task step, knock or
 * chat message that day). "Not available" before 0014.
 */

const MISSING = new Set(['42883', 'PGRST202'])

export interface DayStart {
  user_id: string
  work_date: string
  /** What they said, or null if they said nothing. */
  started_at: string | null
  note: string | null
  /** Their first task step, knock or chat message that day, or null. */
  first_work_at: string | null
}

export const dayStartKeys = {
  all: ['day-starts'] as const,
  range: (userId: string, from: string, to: string) => ['day-starts', userId, from, to] as const,
}

export function useDayStarts(from: string, to: string, enabled = true) {
  const userId = useAuthStore((s) => s.profile?.id) ?? ''
  return useQuery({
    queryKey: dayStartKeys.range(userId, from, to),
    enabled: enabled && !!userId,
    queryFn: async (): Promise<{ available: boolean; rows: DayStart[] }> => {
      const { data, error } = await supabase.rpc('office_day_starts_range', { p_from: from, p_to: to })
      if (error?.code && MISSING.has(error.code)) return { available: false, rows: [] }
      if (error) throw error
      return { available: true, rows: (data ?? []) as DayStart[] }
    },
    staleTime: 60_000,
  })
}

/** Say when today's work began (a time before the official start), or clear it with null. */
export function useDeclareStart() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ time, note }: { time: string | null; note: string }) => {
      const { error } = await supabase.rpc('declare_day_start', { p_time: time, p_note: note.trim() || null })
      if (error) throw new Error(error.message)
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: dayStartKeys.all }),
  })
}
