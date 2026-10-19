import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/**
 * Profile photos (0007). Each person's file sits in the private `avatars`
 * bucket and its path on profiles.avatar_path. The browser can only show
 * one through a signed link, so one query reads every path the team has and
 * signs them all in a single request.
 *
 * Until 0007 is applied the column does not exist: the query answers
 * `available: false` instead of failing, the screens keep their initials, and
 * the photo controls stay hidden.
 */

export const photoKeys = { all: ['photos'] as const }

/**
 * Signed links last 15 minutes, so one copied out of the page stops working
 * soon. The list goes stale after 10, and is re-signed then: on a timer while
 * the app is open (one timer, see usePhotoRefresh) and on return to the tab.
 */
const LINK_SECONDS = 15 * 60
const REFRESH_MS = 10 * 60_000

/** Postgres "undefined column": 0007 is not applied yet. */
const NO_COLUMN = '42703'

export interface Photos {
  available: boolean
  /** user id -> signed URL */
  urls: Record<string, string>
  /** user id -> storage path */
  paths: Record<string, string>
}

async function fetchPhotos(): Promise<Photos> {
  const { data, error } = await supabase.from('profiles').select('id, avatar_path').not('avatar_path', 'is', null)
  if (error) {
    if (error.code === NO_COLUMN) return { available: false, urls: {}, paths: {} }
    throw error
  }
  const rows = (data ?? []) as { id: string; avatar_path: string }[]
  const paths = Object.fromEntries(rows.map((r) => [r.id, r.avatar_path]))
  if (!rows.length) return { available: true, urls: {}, paths }
  const { data: signed, error: signErr } = await supabase.storage
    .from('avatars')
    .createSignedUrls(rows.map((r) => r.avatar_path), LINK_SECONDS)
  if (signErr) throw signErr
  const urlOf = new Map((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]))
  const urls: Record<string, string> = {}
  for (const r of rows) {
    const url = urlOf.get(r.avatar_path)
    if (url) urls[r.id] = url
  }
  return { available: true, urls, paths }
}

/**
 * Every photo the team has. `refresh` adds the re-signing timer; only
 * usePhotoRefresh asks for it, so there is one timer however many faces are
 * on screen.
 */
export function usePhotos(refresh = false) {
  const signedIn = useAuthStore((s) => !!s.profile)
  return useQuery({
    queryKey: photoKeys.all,
    enabled: signedIn,
    staleTime: REFRESH_MS,
    refetchInterval: refresh ? REFRESH_MS : false,
    // Links signed before the tab was hidden may have run out by now.
    refetchOnWindowFocus: true,
    queryFn: fetchPhotos,
  })
}

/** Mount once, in the app shell: keeps the signed links fresh. */
export function usePhotoRefresh() {
  usePhotos(true)
}

/** One person's photo link, or undefined (no photo, not loaded, or 0007 not in). */
export function usePhotoUrl(userId: string | null | undefined): string | undefined {
  const { data } = usePhotos()
  return userId ? data?.urls[userId] : undefined
}

/**
 * Remove every file in a person's folder but `keep`. 0007 allows five files a
 * folder, so leftovers from failed saves are cleared before an upload as well
 * as after one: they can never lock anyone out.
 */
async function clearFolder(userId: string, keep: string | null | undefined) {
  const bucket = supabase.storage.from('avatars')
  const { data: files } = await bucket.list(userId, { limit: 100 })
  const stale = (files ?? []).map((f) => `${userId}/${f.name}`).filter((p) => p !== keep)
  if (stale.length) await bucket.remove(stale)
}

/**
 * Set or remove someone's photo: your own, or anyone's if you are Mr Tito
 * (enforced by 0007, not here). Upload a new file, point the profile at it,
 * then clear the rest of that person's folder. A new file every time means a
 * link handed out for the old photo can never show the new one.
 *
 * Resolves once the new photo is in the cache, so it is on screen when the
 * caller says "saved".
 */
export function useSetPhoto() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ userId, image }: { userId: string; image: Blob | null }) => {
      const bucket = supabase.storage.from('avatars')
      let path: string | null = null
      if (image) {
        const { data: me } = await supabase.from('profiles').select('avatar_path').eq('id', userId).maybeSingle()
        await clearFolder(userId, (me as { avatar_path: string | null } | null)?.avatar_path)
        const ext = image.type === 'image/webp' ? 'webp' : image.type === 'image/png' ? 'png' : 'jpg'
        path = `${userId}/${crypto.randomUUID()}.${ext}`
        const { error } = await bucket.upload(path, image, { contentType: image.type, upsert: false, cacheControl: '31536000' })
        if (error) throw new Error(`The photo did not upload: ${error.message}`)
      }
      // .select() so a row the rules quietly skipped counts as a failure, not
      // a success that then deletes the photo still in use.
      const { data, error } = await supabase.from('profiles').update({ avatar_path: path }).eq('id', userId).select('id')
      if (error || !data?.length) {
        // Do not leave an orphan behind a refusal.
        if (path) await bucket.remove([path])
        throw new Error(error?.message ?? 'You cannot change this photo.')
      }
      // Best effort: anything left behind is invisible and is cleared next time.
      await clearFolder(userId, path)
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: photoKeys.all })
      // A photo is a first step (0010).
      void queryClient.invalidateQueries({ queryKey: ['office', 'onboarding'] })
    },
  })
}
