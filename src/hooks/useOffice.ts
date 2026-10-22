import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { addDays, localParts, wallTimeToInstant } from '@/lib/timezones'
import type { Stretch } from '@/lib/presence'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { REPORT_LABEL } from '@/lib/office'
import { tidyLinks } from '@/lib/links'
import type {
  Role,
  OfficeAbsence,
  OfficeFlag,
  OfficeMember,
  OfficeReport,
  OfficeReportFile,
  OfficeRosterDay,
  OfficeSettings,
  ReportKind,
} from '@/types/database'

/**
 * The office's daily reports (0002). Reads go straight to the tables, which
 * RLS narrows to the caller's own rows or, for Mr Tito, everyone's. The only
 * write a member makes is submit_report(), after uploading proof into their
 * own folder of the private `proof` bucket.
 */

export const officeKeys = {
  all: ['office'] as const,
  settings: () => ['office', 'settings'] as const,
  members: () => ['office', 'members'] as const,
  mine: (date: string) => ['office', 'mine', date] as const,
  range: (from: string, to: string) => ['office', 'range', from, to] as const,
  absences: () => ['office', 'absences'] as const,
  presence: (date: string) => ['office', 'presence', date] as const,
  // 0006
  status: () => ['office', 'status'] as const,
  feed: (since: string) => ['office', 'feed', since] as const,
}

export function useOfficeSettings() {
  return useQuery({
    queryKey: officeKeys.settings(),
    queryFn: async (): Promise<OfficeSettings> => {
      const { data, error } = await supabase.from('office_settings').select('*').eq('id', 1).single()
      if (error) throw error
      return data as OfficeSettings
    },
    staleTime: 10 * 60 * 1000,
  })
}

export interface OfficeMemberWithUser extends OfficeMember {
  user: { full_name: string; email: string; role: Role; deactivated_at: string | null; job_title?: string | null } | null
}

export function useOfficeMembers() {
  return useQuery({
    queryKey: officeKeys.members(),
    queryFn: async (): Promise<OfficeMemberWithUser[]> => {
      const { data, error } = await supabase
        .from('office_members')
        // The whole profile: its job title (0016) comes along once it exists, and nothing breaks before.
        .select('user_id, active, added_at, user:profiles!office_members_user_id_fkey (*)')
      if (error) throw error
      return ((data ?? []) as unknown as OfficeMemberWithUser[]).sort((a, b) =>
        (a.user?.full_name ?? '').localeCompare(b.user?.full_name ?? ''),
      )
    },
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Who the signed-in person is to the office. Display only: RLS and
 * submit_report() are what actually decide.
 */
export function useOfficeRole(): { loading: boolean; isError: boolean; isManager: boolean; isMember: boolean } {
  const profile = useAuthStore((s) => s.profile)
  const settings = useOfficeSettings()
  const members = useOfficeMembers()
  const isManager = !!profile && settings.data?.manager_id === profile.id
  const isMember = !!profile && !!members.data?.some((m) => m.user_id === profile.id && m.active)
  return {
    loading: settings.isLoading || members.isLoading,
    // A failed read must not be mistaken for "not in the office".
    isError: settings.isError || members.isError,
    isManager,
    isMember: isMember || isManager,
  }
}

/** Today on the office's clock, 'YYYY-MM-DD'. */
export function officeDate(settings: OfficeSettings, now: Date): string {
  return localParts(settings.timezone, now).date
}

export interface ReportWithFiles extends OfficeReport {
  files: OfficeReportFile[]
}

const REPORT_COLUMNS = '*, files:office_report_files (*)'

export function useMyReports(date: string | null) {
  const userId = useAuthStore((s) => s.profile?.id)
  return useQuery({
    queryKey: officeKeys.mine(date ?? ''),
    enabled: !!date && !!userId,
    queryFn: async (): Promise<ReportWithFiles[]> => {
      const { data, error } = await supabase
        .from('office_reports')
        .select(REPORT_COLUMNS)
        .eq('user_id', userId!)
        .eq('work_date', date!)
      if (error) throw error
      return (data ?? []) as ReportWithFiles[]
    },
  })
}

/* ------------------------------------------------------------ filing */

export const MAX_FILES = 5
export const MAX_FILE_BYTES = 10 * 1024 * 1024

/** The proof bucket's allowed_mime_types (0002), exactly. */
export const PROOF_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic', 'application/pdf']

/** Same rule as the bucket and submit_report(): those types, 10 MB each. */
export function fileProblem(file: File): string | null {
  if (!PROOF_TYPES.includes(file.type)) return `${file.name} is not a PNG, JPEG, WebP, GIF, HEIC or PDF.`
  if (file.size > MAX_FILE_BYTES) return `${file.name} is over 10 MB.`
  return null
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

function extension(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (/^[a-z0-9]{1,5}$/.test(fromName)) return fromName
  return file.type === 'application/pdf' ? 'pdf' : 'img'
}

export interface SubmitInput {
  kind: ReportKind
  /** The office's date as the browser sees it; the server re-derives its own. */
  date: string
  body: string
  links: string[]
  /** 0016 applied: send the list. Before it, the first link alone. */
  multi: boolean
  files: File[]
}

export function useSubmitReport() {
  const queryClient = useQueryClient()
  const userId = useAuthStore((s) => s.profile?.id)
  const showToast = useToastStore((s) => s.showToast)

  return useMutation({
    mutationFn: async ({ kind, date, body, links, multi, files }: SubmitInput) => {
      if (!userId) throw new Error('Sign in again and retry.')
      const uploaded: { path: string; name: string; sha256: string }[] = []
      // One at a time: on a slow connection, five parallel 10 MB uploads all
      // time out together; in sequence, the first ones at least finish.
      for (const file of files) {
        const path = `${userId}/${date}/${kind}/${crypto.randomUUID()}.${extension(file)}`
        const sha256 = await sha256Hex(file)
        const { error } = await supabase.storage
          .from('proof')
          .upload(path, file, { contentType: file.type, upsert: false })
        if (error) throw new Error(`${file.name} did not upload: ${error.message}`)
        uploaded.push({ path, name: file.name, sha256 })
      }
      const { error } = await supabase.rpc('submit_report', {
        p_kind: kind,
        p_body: body.trim(),
        p_files: uploaded,
        ...(multi ? { p_link: null, p_links: tidyLinks(links) } : { p_link: tidyLinks(links)[0] ?? '' }),
      })
      if (error) throw new Error(error.message)
    },
    // Here, not at the call site: the form unmounts as soon as the refetch
    // shows the filed report, and a call-site callback would go with it.
    onSuccess: (_data, { kind }) => showToast(`${REPORT_LABEL[kind]} filed`, 'success'),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: officeKeys.all })
    },
  })
}

/* -------------------------------------------------- the manager's view */

export interface OfficeRange {
  roster: OfficeRosterDay[]
  reports: ReportWithFiles[]
  flags: OfficeFlag[]
}

export function useOfficeRange(from: string, to: string, enabled: boolean) {
  return useQuery({
    queryKey: officeKeys.range(from, to),
    enabled,
    queryFn: async (): Promise<OfficeRange> => {
      const [roster, reports, flags] = await Promise.all([
        supabase.rpc('office_roster', { p_from: from, p_to: to }),
        supabase.from('office_reports').select(REPORT_COLUMNS).gte('work_date', from).lte('work_date', to),
        supabase.from('office_flags').select('*').gte('work_date', from).lte('work_date', to),
      ])
      if (roster.error) throw roster.error
      if (reports.error) throw reports.error
      if (flags.error) throw flags.error
      return {
        roster: (roster.data ?? []) as OfficeRosterDay[],
        reports: (reports.data ?? []) as ReportWithFiles[],
        flags: (flags.data ?? []) as OfficeFlag[],
      }
    },
  })
}

/** Mr Tito's screens refresh as reports and flags land. */
export function useOfficeRealtime(enabled: boolean) {
  const queryClient = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    const refresh = () => void queryClient.invalidateQueries({ queryKey: officeKeys.all })
    const channel = supabase
      .channel('office-reports')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_reports' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'office_flags' }, refresh)
      .subscribe()
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [enabled, queryClient])
}

/**
 * Proof opens through a five-minute signed URL; the bucket is private. The
 * tab is opened before the await so a popup blocker sees it as the click's.
 */
export async function openProof(path: string): Promise<void> {
  const tab = window.open('', '_blank')
  const { data, error } = await supabase.storage.from('proof').createSignedUrl(path, 300)
  if (error || !data?.signedUrl) {
    tab?.close()
    throw new Error(error?.message ?? 'Could not open that file.')
  }
  if (tab) tab.location.href = data.signedUrl
  else window.location.href = data.signedUrl
}

/* ------------------------------------------- team and absences (manager) */

function useOfficeWrite<T>(fn: (input: T) => PromiseLike<{ error: { message: string } | null }>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (input: T) => {
      const { error } = await fn(input)
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: officeKeys.all })
    },
  })
}

export const useAddOfficeMember = () =>
  useOfficeWrite((user_id: string) => supabase.from('office_members').insert({ user_id }))

export const useUpdateOfficeMember = () =>
  useOfficeWrite(({ user_id, active }: { user_id: string; active: boolean }) =>
    supabase.from('office_members').update({ active }).eq('user_id', user_id),
  )

export const useRemoveOfficeMember = () =>
  useOfficeWrite((user_id: string) => supabase.from('office_members').delete().eq('user_id', user_id))

export function useOfficeAbsences() {
  return useQuery({
    queryKey: officeKeys.absences(),
    queryFn: async (): Promise<OfficeAbsence[]> => {
      const { data, error } = await supabase
        .from('office_absences')
        .select('id, user_id, starts_on, ends_on, reason')
        .order('starts_on', { ascending: false })
        .limit(100)
      if (error) throw error
      return (data ?? []) as OfficeAbsence[]
    },
  })
}

export const useAddAbsence = () =>
  useOfficeWrite((input: Omit<OfficeAbsence, 'id'>) => supabase.from('office_absences').insert(input))

export const useRemoveAbsence = () =>
  useOfficeWrite((id: string) => supabase.from('office_absences').delete().eq('id', id))

/* ------------------------------------------------ presence (0004, manager) */

export interface PresenceDay {
  start: number
  end: number
  stretches: (Stretch & { user_id: string })[]
}

/** Everyone's presence stretches for one office day (Mr Tito only, by RLS). */
export function useOfficePresenceDay(settings: OfficeSettings, date: string) {
  return useQuery({
    queryKey: officeKeys.presence(date),
    queryFn: async (): Promise<PresenceDay> => {
      const start = wallTimeToInstant(date, '00:00', settings.timezone).instant.getTime()
      const end = wallTimeToInstant(addDays(date, 1), '00:00', settings.timezone).instant.getTime()
      const { data, error } = await supabase
        .from('office_presence')
        .select('user_id, status, started_at, last_seen_at')
        .gte('started_at', new Date(start).toISOString())
        .lt('started_at', new Date(end).toISOString())
        .order('started_at')
        .limit(5000)
      if (error) throw error
      return { start, end, stretches: (data ?? []) as PresenceDay['stretches'] }
    },
  })
}
