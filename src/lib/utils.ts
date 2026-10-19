import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatDistanceToNowStrict, format, parseISO } from 'date-fns'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Normalize a Nigerian-or-international phone number to bare E.164 digits,
 * which is the form wa.me expects (no plus, no spaces).
 *
 *   08067132772        -> 2348067132772
 *   +234 806 713 2772  -> 2348067132772
 *   234-806-713-2772   -> 2348067132772
 *
 * Returns null when there is nothing usable, so callers can disable the
 * WhatsApp affordance instead of producing a broken link.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null

  const digits = raw.replace(/\D/g, '')
  if (!digits) return null

  // Local Nigerian format: leading 0 plus 10 digits.
  if (digits.startsWith('0') && digits.length === 11) return `234${digits.slice(1)}`

  // Already country-coded.
  if (digits.startsWith('234') && digits.length === 13) return digits

  // Bare 10-digit Nigerian subscriber number.
  if (digits.length === 10 && !digits.startsWith('0')) return `234${digits}`

  // Any other international number that is plausibly complete.
  if (digits.length >= 11 && digits.length <= 15) return digits

  return null
}

export function whatsappLink(phone: string | null | undefined, message?: string) {
  const e164 = normalizePhone(phone)
  if (!e164) return null
  const base = `https://wa.me/${e164}`
  return message ? `${base}?text=${encodeURIComponent(message)}` : base
}

export function firstName(fullName: string) {
  return fullName.trim().split(/\s+/)[0] ?? fullName
}

/** "2h ago", "3d ago". Compact, because it lives in a 100px column. */
export function relativeTime(iso: string) {
  try {
    return `${formatDistanceToNowStrict(parseISO(iso))} ago`
  } catch {
    return ''
  }
}

/** The absolute time, shown on hover over a relative one. */
export function absoluteTime(iso: string) {
  try {
    return format(parseISO(iso), "d MMM yyyy 'at' HH:mm")
  } catch {
    return ''
  }
}

export function shortDate(iso: string) {
  try {
    return format(parseISO(iso), 'd MMM yyyy')
  } catch {
    return ''
  }
}

export function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

/**
 * Supabase surfaces auth failures as generic strings. Translate the ones a
 * user can act on: "Login failed" tells them nothing about what to do next.
 */
export function authErrorMessage(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) {
    return 'That email and password do not match an account.'
  }
  if (m.includes('email not confirmed')) {
    return 'This account has not been confirmed yet. Check your inbox for the invite link.'
  }
  if (m.includes('rate limit') || m.includes('too many')) {
    return 'Too many attempts. Wait a minute and try again.'
  }
  if (m.includes('failed to fetch') || m.includes('networkerror')) {
    return 'Cannot reach the server. Check your connection and try again.'
  }
  return message
}
