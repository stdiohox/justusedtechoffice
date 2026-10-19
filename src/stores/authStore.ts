import { create } from 'zustand'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { queryClient } from '@/lib/queryClient'
import { authErrorMessage } from '@/lib/utils'
import type { Profile } from '@/types/database'

/**
 * Zustand holds only session identity, which every screen needs and which no
 * server query owns. Everything that lives in a table belongs to TanStack
 * Query.
 *
 * Who is let in: a session whose profile exists and is not switched off
 * (0001). RLS shows a profile only to an active team member, so a switched-off
 * login reads none. Only a read that WORKED and found nothing signs anyone
 * out; a failed read (offline) never does. Signing out here is local: the
 * person's other devices are left alone.
 */
interface AuthState {
  user: User | null
  session: Session | null
  profile: Profile | null
  loading: boolean
  initialized: boolean
  signIn: (email: string, password: string) => Promise<{ error: string | null }>
  signOut: () => Promise<void>
  initialize: () => Promise<void>
}

/** `known` is false when the read itself failed: then nobody is signed out for it. */
async function readProfile(userId: string): Promise<{ profile: Profile | null; known: boolean }> {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
  if (error) return { profile: null, known: false }
  const profile = (data as Profile | null) ?? null
  return { profile: profile && !profile.deactivated_at ? profile : null, known: true }
}

const signOutHere = () => supabase.auth.signOut({ scope: 'local' })

let initializing: Promise<void> | null = null

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  profile: null,
  loading: false,
  initialized: false,

  // Once per page load (StrictMode calls effects twice in development).
  initialize: () => {
    if (initializing) return initializing
    initializing = (async () => {
      const { data } = await supabase.auth.getSession()
      let session = data.session
      let profile: Profile | null = null
      if (session?.user) {
        const read = await readProfile(session.user.id)
        profile = read.profile
        if (read.known && !profile) {
          await signOutHere()
          session = null
        }
      }
      set({ session, user: session?.user ?? null, profile, initialized: true })

      // Keeps every tab in step. The callback stays synchronous: awaiting a
      // Supabase call inside it can deadlock on the auth lock, so the profile
      // is read just after, and only applied if the same person is still in.
      supabase.auth.onAuthStateChange((_event, nextSession) => {
        const nextUser = nextSession?.user ?? null
        const previousId = get().user?.id
        if (nextUser?.id !== previousId) queryClient.clear()
        set({ session: nextSession, user: nextUser, ...(nextUser ? {} : { profile: null }) })
        if (!nextUser || nextUser.id === previousId) return
        setTimeout(() => {
          void readProfile(nextUser.id).then(async (read) => {
            if (get().user?.id !== nextUser.id) return
            if (read.known && !read.profile) {
              await signOutHere()
              return
            }
            if (read.known) set({ profile: read.profile })
          })
        }, 0)
      })
    })()
    return initializing
  },

  signIn: async (email, password) => {
    set({ loading: true })
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) {
      set({ loading: false })
      return { error: authErrorMessage(error.message) }
    }
    const read = data.user ? await readProfile(data.user.id) : { profile: null, known: true }
    if (!read.known) {
      // Signed in, but the office could not be read: keep the session, say so.
      set({ loading: false })
      return { error: 'Signed in, but the office could not be reached. Check your connection and try again.' }
    }
    // No profile: never invited (0001), or switched off by Mr Tito.
    if (!read.profile) {
      await signOutHere()
      set({ loading: false })
      return { error: 'This account is not on the team, or has been switched off. Ask Mr Tito.' }
    }
    set({ session: data.session, user: data.user, profile: read.profile, loading: false })
    return { error: null }
  },

  signOut: async () => {
    await signOutHere()
    queryClient.clear()
    set({ user: null, session: null, profile: null })
  },
}))
