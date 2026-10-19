import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { officeKeys } from '@/hooks/useOffice'
import type { OfficeOnboardingRow } from '@/types/database'
import { NOTICE_VERSION } from '@/lib/officeNotice'

/**
 * A new member's first steps and the staff notice (0010). Like the other
 * office reads, everything degrades to "not available" until the migration is
 * in, so the checklist simply does not show.
 */

/** PostgREST / Postgres codes for "that function does not exist". */
const MISSING = new Set(['42883', 'PGRST202'])

export const onboardingKeys = {
  status: () => [...officeKeys.all, 'onboarding'] as const,
}

export interface OnboardingStatus {
  available: boolean
  /** Mr Tito: every member who files reports; anyone else: only their own row. */
  rows: OfficeOnboardingRow[]
}

export function useOnboardingStatus(enabled: boolean) {
  return useQuery({
    queryKey: onboardingKeys.status(),
    enabled,
    queryFn: async (): Promise<OnboardingStatus> => {
      // Asked about the version on screen: an acknowledgement of any other never counts.
      const { data, error } = await supabase.rpc('office_onboarding_status', { p_notice_version: NOTICE_VERSION })
      if (error?.code && MISSING.has(error.code)) return { available: false, rows: [] }
      if (error) throw error
      return { available: true, rows: (data ?? []) as OfficeOnboardingRow[] }
    },
    staleTime: 60_000,
  })
}

function useOnboardingWrite<T>(call: (input: T) => PromiseLike<{ error: { message: string } | null }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => {
      const { error } = await call(input)
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: onboardingKeys.status() })
    },
  })
}

/** "I've read how the office records my time", for one notice version. */
export const useAckNotice = () => useOnboardingWrite((version: number) => supabase.rpc('ack_office_notice', { p_version: version }))

/** The browser asked about notifications and the person answered, either way. */
export const useNotificationsAnswered = () =>
  useOnboardingWrite((_: void) => supabase.rpc('complete_onboarding_task', { p_task: 'notifications' }))
