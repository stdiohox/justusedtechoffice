import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { officeKeys } from '@/hooks/useOffice'
import type { OfficeStatus } from '@/types/database'

/**
 * Doors (0006, 0010). They degrade to "not available" when the
 * migration has not been applied yet, so this frontend can ship first: the
 * features stay hidden instead of the office erroring.
 */

/** PostgREST / Postgres codes for "that table or function does not exist". */
const MISSING = new Set(['42P01', '42883', 'PGRST202', 'PGRST205'])
const isMissing = (error: { code?: string } | null) => !!error?.code && MISSING.has(error.code)

export interface Available<T> {
  available: boolean
  rows: T[]
}

/** Postgres: "that column does not exist" (0010's back_reason, before it is applied). */
const NO_COLUMN = '42703'

export function useOfficeStatuses(enabled: boolean) {
  return useQuery({
    queryKey: officeKeys.status(),
    enabled,
    queryFn: async (): Promise<Available<OfficeStatus> & { reasons: boolean }> => {
      const cols = 'user_id, working_on, back_at, out_until, set_on, updated_at'
      let reasons = true
      let { data, error } = await supabase.from('office_status').select(`${cols}, back_reason`)
      // Before 0010 there is no reason to read: doors work as they did.
      if (error?.code === NO_COLUMN) {
        reasons = false
        ;({ data, error } = await supabase.from('office_status').select(cols))
      }
      if (isMissing(error)) return { available: false, rows: [], reasons: false }
      if (error) throw error
      return { available: true, rows: (data ?? []) as OfficeStatus[], reasons }
    },
    staleTime: 60_000,
  })
}

/** Doors change live for everyone in the office (RLS applies to Realtime). */
export function useOfficeStatusRealtime(enabled: boolean) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    // A fresh name per mount: supabase.channel() hands back a same-named
    // channel that is still being removed (StrictMode, a quick remount), and
    // .on() on that one leaves the doors silently not updating.
    const channel = supabase
      .channel(`office-status-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_status' }, () => {
        void queryClient.invalidateQueries({ queryKey: officeKeys.status() })
      })
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, queryClient])
}

export interface DoorInput {
  workingOn: string
  /** 'HH:MM' or '' */
  backAt: string
  /** 'YYYY-MM-DD' or '' */
  outUntil: string
  /** 0010: "Lunch" or ''. Only sent when set, so a database without 0010 takes the call. */
  backReason?: string
}

export function useSetOfficeStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ workingOn, backAt, outUntil, backReason }: DoorInput) => {
      const reason = backReason?.trim()
      const { error } = await supabase.rpc('set_office_status', {
        p_working_on: workingOn.trim() || null,
        p_back_at: backAt || null,
        p_out_until: outUntil || null,
        // Left out when empty: 0010's default (null) clears it, and before
        // 0010 the three-argument function still matches.
        ...(reason ? { p_back_reason: reason } : {}),
      })
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: officeKeys.status() })
      // Writing on your door is a first step (0010).
      void queryClient.invalidateQueries({ queryKey: [...officeKeys.all, 'onboarding'] })
    },
  })
}
