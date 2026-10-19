/**
 * What every office route shares: the environment, a service-role client,
 * the caller's verified identity, and refusals with their HTTP status.
 * Under `api/_lib/`, so Vercel does not make it a route.
 */
import type { VercelRequest } from '@vercel/node'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * Branded with a symbol, not recognised by shape: a parsed request body that
 * happened to carry `status` and `error` keys must not pass for a refusal.
 */
const REFUSED: unique symbol = Symbol('refused')

/** A refusal with the HTTP status the route should answer with. */
export interface Refusal {
  readonly [REFUSED]: true
  status: number
  error: string
}

export const refuse = (status: number, error: string): Refusal => ({ [REFUSED]: true, status, error })

export const isRefusal = (v: unknown): v is Refusal =>
  typeof v === 'object' && v !== null && (v as Partial<Refusal>)[REFUSED] === true

/**
 * Who the office's emails come from: OFFICE_FROM_EMAIL, an address on the
 * domain verified in Resend (for example "JUSTUSED Office <office@justusedtech.org>").
 */
export const fromAddress = (): string | null => {
  const v = process.env.OFFICE_FROM_EMAIL?.trim()
  return v && /^[^<>\r\n]*<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/.test(v) ? v : null
}

/**
 * The office's own address, for the links in its emails. Refused rather than
 * defaulted: a link nobody can open is worse than no email.
 */
export const baseUrl = (): string | null => {
  const v = process.env.OFFICE_BASE_URL?.trim().replace(/\/+$/, '')
  return v && /^https:\/\/[^\s/]+/.test(v) ? v : null
}

/** The values every sending route needs, or the refusal naming what is missing. */
export function officeEnv():
  | { url: string; serviceKey: string; resendKey: string; from: string; base: string }
  | Refusal {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const resendKey = process.env.RESEND_API_KEY
  const from = fromAddress()
  const base = baseUrl()
  if (!url || !serviceKey || !resendKey || !from || !base) {
    return refuse(
      500,
      'Missing env. Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, OFFICE_FROM_EMAIL and OFFICE_BASE_URL (https).',
    )
  }
  return { url, serviceKey, resendKey, from, base }
}

/** Service role, no session: there is no browser on this side. */
export function serviceClient(url: string, serviceKey: string): SupabaseClient {
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
}

/**
 * Until this returns a user id, the request is a stranger's. getUser(jwt)
 * asks Auth about the token it is handed: forged, expired or tampered all come
 * back as an error.
 */
export async function verifiedUserId(req: VercelRequest, db: SupabaseClient): Promise<string | Refusal> {
  const auth = req.headers.authorization
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return refuse(401, 'Sign in again and retry.')
  const token = auth.slice(7).trim()
  if (!token) return refuse(401, 'Sign in again and retry.')
  const { data, error } = await db.auth.getUser(token)
  const id = data?.user?.id
  if (error || !id) return refuse(401, 'Your session has expired. Sign in again.')
  return id
}

/** The JSON body as an object; anything else is the caller's mistake (400). */
export function parseBody<T>(req: VercelRequest): T | Refusal {
  let parsed: unknown
  try {
    parsed = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
  } catch {
    return refuse(400, 'The request body was not valid JSON.')
  }
  return (parsed !== null && typeof parsed === 'object' ? parsed : {}) as T
}

/** Log the real error; tell the browser only that something went wrong. */
export function serverErrorBody(err: unknown): { error: string } {
  console.error(err)
  return { error: 'Something went wrong. Try again.' }
}

/**
 * The link an invite or reset email carries: our own /set-password page with
 * the one-time token_hash, not Supabase's verify URL. The page exchanges it
 * only when the person presses Continue, so a mail scanner that opens links
 * cannot use it up.
 */
export function setPasswordLink(base: string, props: { hashed_token?: string; verification_type?: string } | null | undefined): string | null {
  const token = props?.hashed_token
  const type = props?.verification_type
  if (!token || !type) return null
  return `${base}/set-password?token_hash=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`
}
