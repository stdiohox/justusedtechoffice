import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Invite, Role } from '@/types/database'

/**
 * The team (0001): everyone with a login, and the invites still waiting for
 * one. Reads go straight to the tables; RLS shows the team to the team and the
 * invites to the office manager only. Inviting goes through api/team/invite,
 * which needs the service role to create the login.
 */

export interface TeamMember {
  id: string
  full_name: string
  email: string
  role: Role
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
        .select('id, full_name, email, role, created_at, deactivated_at')
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

/** Invites waiting for a login (the office manager only, by RLS). */
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
    mutationFn: async ({ email, fullName }: { email: string; fullName: string }) => {
      const { data: session } = await supabase.auth.getSession()
      const token = session.session?.access_token
      if (!token) throw new Error('Sign in again, then try once more.')
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: email.trim().toLowerCase(), fullName: fullName.trim() }),
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
      const { error } = await supabase.from('invites').delete().eq('email', email)
      if (error) throw new Error(error.message)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: teamKeys.invites() })
    },
  })
}
