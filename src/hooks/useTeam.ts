import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Invite, Role } from '@/types/database'
import { officeKeys } from '@/hooks/useOffice'
import { useAuthStore } from '@/stores/authStore'

/**
 * The team (0001): everyone with a login, and the invites still waiting for
 * one. Reads go straight to the tables; RLS shows the team to the team and the
 * invites to the office admins (Mr Tito; from 0016 Hazel too). Inviting goes
 * through api/team/invite, which needs the service role to create the login.
 */

export interface TeamMember {
  id: string
  full_name: string
  email: string
  role: Role
  /** 0016: shown as their role ("CEO"); absent before it. */
  job_title?: string | null
  created_at: string
  deactivated_at: string | null
}

export const teamKeys = {
  all: ['profiles'] as const,
  team: () => ['profiles', 'team'] as const,
  invites: () => ['profiles', 'invites'] as const,
}

/** Everyone, active and deactivated. Settings is the one place both belong. */
export function useTeam() {
  return useQuery({
    queryKey: teamKeys.team(),
    queryFn: async (): Promise<TeamMember[]> => {
      const { data, error } = await supabase
        .from('profiles')
        // The whole row: the job title (0016) comes along once it exists.
        .select('*')
        .order('full_name')
      if (error) throw error
      return (data ?? []) as TeamMember[]
    },
  })
}

/**
 * Reversible by design: the button that undoes it sits in the same row. Only
 * the office manager may, and nobody deactivates themselves: the profiles
 * guard (0002) enforces both, not this client.
 */
export function useSetDeactivated() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, deactivated }: { id: string; deactivated: boolean }) => {
      const { error } = await supabase
        .from('profiles')
        .update({ deactivated_at: deactivated ? new Date().toISOString() : null })
        .eq('id', id)
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.all })
    },
  })
}

/** Invites waiting for a login (the office admins only, by RLS). */
export function useInvites(enabled: boolean) {
  return useQuery({
    queryKey: teamKeys.invites(),
    enabled,
    queryFn: async (): Promise<Invite[]> => {
      const { data, error } = await supabase.from('invites').select('*').order('created_at', { ascending: false })
      if (error) throw error
      return (data ?? []) as Invite[]
    },
  })
}

/** Invite someone: the route records the invite and emails them a link to set a password. */
export function useInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ email, fullName, jobTitle }: { email: string; fullName: string; jobTitle?: string }) => {
      const { data: session } = await supabase.auth.getSession()
      const token = session.session?.access_token
      if (!token) throw new Error('Sign in again, then try once more.')
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        // No jobTitle on "Send again": the invite keeps the one it has.
        body: JSON.stringify({ email: email.trim().toLowerCase(), fullName: fullName.trim(), ...(jobTitle?.trim() ? { jobTitle: jobTitle.trim() } : {}) }),
      }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { error?: string } | null
      if (!res?.ok) throw new Error(body?.error ?? 'The invite did not go out. Try again in a moment.')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.all })
    },
  })
}

/** Take back an invite nobody has used yet. */
export function useWithdrawInvite() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (email: string) => {
      // RLS turns a delete it does not allow into "0 rows": say so, not "withdrawn".
      const { data, error } = await supabase.from('invites').delete().eq('email', email).select('email')
      if (error) throw new Error(error.message)
      if (!data?.length) throw new Error('That invite could not be withdrawn. Reload and try again.')
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.invites() })
    },
  })
}

/**
 * Set someone's job title (0016), or clear it with ''. The office admins
 * only: the profiles guard enforces it, not this client.
 */
export function useSetJobTitle() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      const { data, error } = await supabase
        .from('profiles')
        .update({ job_title: title.trim() || null })
        .eq('id', id)
        .select('id')
      if (error) throw new Error(error.message)
      if (!data?.length) throw new Error('That role could not be saved. Reload and try again.')
    },
    // Your own title shows in the header at once, not after a reload.
    onSuccess: (_data, { id, title }) =>
      useAuthStore.setState((st) => (st.profile?.id === id ? { profile: { ...st.profile, job_title: title.trim() || null } } : {})),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.all })
      // The doors read names and titles through the office's member list.
      void queryClient.invalidateQueries({ queryKey: officeKeys.members() })
    },
  })
}
