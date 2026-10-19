import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Fail loudly at startup rather than producing "fetch failed" at the first
// query. A missing env var is the most common first-run problem.
if (!url || !anonKey) {
  throw new Error(
    'Missing Supabase credentials. Copy .env.example to .env.local and fill in ' +
      'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY from the Supabase dashboard ' +
      '(Project settings, API).',
  )
}

export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // Off on purpose: invite and reset emails link to /set-password with a
    // token_hash, which the page exchanges (verifyOtp) only when the person
    // presses Continue. A link that signs in by itself would be used up by
    // the mail scanners that open links before people do.
    detectSessionInUrl: false,
  },
})

/**
 * PostgREST's server-side max-rows ceiling. Supabase ships it at 1000 and it
 * applies to EVERY request, including one that asks for more with .limit() or
 * .range(): a select over 1,400 leads comes back with exactly 1,000 and no
 * error, so `rows.length` reads as a total that has stopped moving.
 *
 * Page size here must not exceed the project's setting (Project settings,
 * API, Max rows). It is 1000 rather than something smaller so that tables
 * under the cap still cost the single round trip they always did.
 */
const MAX_ROWS = 1000

interface Pageable<T> {
  range(from: number, to: number): PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

/**
 * Every row a query matches, not just the first thousand.
 *
 * Walks the query in MAX_ROWS pages until a page comes back short. The
 * builder must already carry a deterministic order (an .order() ending in a
 * unique column), otherwise Postgres is free to hand the same row to two
 * pages and neither to a third.
 *
 * `max` is a total ceiling for callers that want a known truncation point
 * instead of an unbounded read; the result is trimmed to it exactly.
 */
export async function fetchAll<T>(query: Pageable<T>, max = Infinity): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; from < max; from += MAX_ROWS) {
    const to = Math.min(from + MAX_ROWS, max) - 1
    const { data, error } = await query.range(from, to)
    if (error) throw error
    const page = data ?? []
    rows.push(...page)
    if (page.length < to - from + 1) break
  }
  return rows
}
