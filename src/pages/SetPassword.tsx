import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import type { EmailOtpType } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, FieldError, Input, Label } from '@/components/ui/primitives'
import { AuthFrame } from '@/pages/Login'

/**
 * Where an invite or a reset email lands (api/team/invite, api/auth/recover):
 * /set-password?token_hash=...&type=invite|magiclink|recovery.
 *
 *   1. "Continue" exchanges the one-time token (verifyOtp). Only on a click: a
 *      mail scanner that opens the link cannot use it up. Any other session on
 *      this browser is signed out first, so the password can never be set on
 *      the wrong account.
 *   2. Signed in as the person the link was for, they choose a password and
 *      go to the office.
 * A link that has run out, or was used already, says so and points to
 * "Forgot your password?" or to Mr Tito.
 */

const MIN_LENGTH = 8
const TYPES = new Set(['invite', 'magiclink', 'recovery', 'signup', 'email'])

type Step = 'continue' | 'checking' | 'expired' | 'password'

export function SetPassword() {
  const id = useId()
  const navigate = useNavigate()
  const profile = useAuthStore((s) => s.profile)
  const session = useAuthStore((s) => s.session)
  const params = new URLSearchParams(window.location.search)
  const tokenHash = params.get('token_hash')
  const type = params.get('type')
  const usable = !!tokenHash && !!type && TYPES.has(type)
  const [step, setStep] = useState<Step>(usable ? 'continue' : 'expired')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  // After the exchange, the store learns the session and reads the profile a
  // moment later; only after that may "not on the team" be concluded.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    if (step !== 'password') return
    const t = setTimeout(() => setSettled(true), 2500)
    return () => clearTimeout(t)
  }, [step])

  // Each step's heading takes focus, so a keyboard or screen reader follows along.
  useEffect(() => {
    headingRef.current?.focus()
  }, [step])

  const onContinue = async () => {
    if (!usable || step === 'checking') return
    setStep('checking')
    if (session) await supabase.auth.signOut({ scope: 'local' })
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash!, type: type as EmailOtpType })
    // The token is spent (or dead) either way: keep it out of the address bar and history.
    window.history.replaceState(null, '', '/set-password')
    setStep(error ? 'expired' : 'password')
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (saving) return
    if (password.length < MIN_LENGTH) return setProblem(`Use at least ${MIN_LENGTH} characters.`)
    if (password !== again) return setProblem('The two passwords are not the same.')
    setProblem(null)
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (error) {
      return setProblem(
        /should be different/i.test(error.message)
          ? 'Choose a password you have not used here before.'
          : /weak|short|characters/i.test(error.message)
            ? 'Choose a longer password, with letters and numbers.'
            : 'The password was not saved. Try again in a moment.',
      )
    }
    navigate('/office', { replace: true })
  }

  const heading = (text: string) => (
    <span ref={headingRef} tabIndex={-1} className="outline-none">
      {text}
    </span>
  )

  if (step === 'expired') {
    return (
      <AuthFrame title="This link has run out" subtitle="Each link works once, for one hour.">
        <div className="space-y-4">
          <p className="text-[14px] text-text-secondary">
            {heading('Ask for a new one with “Forgot your password?” on the sign-in page, or ask Mr Tito to send your invite again.')}
          </p>
          <Button onClick={() => navigate('/login', { replace: true })}>Go to sign in</Button>
        </div>
      </AuthFrame>
    )
  }

  if (step === 'continue' || step === 'checking') {
    return (
      <AuthFrame title="Welcome to the office" subtitle="Your link is ready.">
        <div className="space-y-4">
          <p className="text-[14px] text-text-secondary">{heading('Press Continue to choose your password.')}</p>
          <Button
            onClick={() => void onContinue()}
            aria-disabled={step === 'checking' || undefined}
            aria-busy={step === 'checking' || undefined}
            className="h-12 w-full text-[15px]"
          >
            {step === 'checking' ? 'Checking your link…' : 'Continue'}
          </Button>
          <p role="status" className="sr-only">
            {step === 'checking' ? 'Checking your link.' : ''}
          </p>
        </div>
      </AuthFrame>
    )
  }

  // The link worked, but the login has no profile (the invite was withdrawn,
  // or the person was switched off): the auth store has signed it out.
  if (!session && !settled) {
    return (
      <AuthFrame title="Welcome to the office" subtitle="Your link is ready.">
        <p role="status" className="text-[14px] text-text-secondary">
          Checking your link…
        </p>
      </AuthFrame>
    )
  }
  if (!session) {
    return (
      <AuthFrame title="You are not on the team" subtitle="This login has no place in the office.">
        <div className="space-y-4">
          <p className="text-[14px] text-text-secondary">{heading('Ask Mr Tito to invite you again.')}</p>
          <Button onClick={() => navigate('/login', { replace: true })}>Go to sign in</Button>
        </div>
      </AuthFrame>
    )
  }

  return (
    <AuthFrame
      title={profile ? `Hello, ${profile.full_name.split(' ')[0]}` : 'Choose a password'}
      subtitle="Choose the password you will sign in with."
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="sr-only">{heading('Choose a password')}</p>
        <div>
          <Label htmlFor={`${id}-pw`}>New password</Label>
          <Input
            id={`${id}-pw`}
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={!!problem}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${id}-hint${problem ? ` ${id}-err` : ''}`}
            className="h-11"
          />
          <p id={`${id}-hint`} className="mt-1 text-[12px] text-text-muted">
            At least {MIN_LENGTH} characters.
          </p>
        </div>
        <div>
          <Label htmlFor={`${id}-again`}>The same password again</Label>
          <Input
            id={`${id}-again`}
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            invalid={!!problem}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-err` : undefined}
            className="h-11"
          />
        </div>
        <div id={`${id}-err`}>
          <FieldError>{problem}</FieldError>
        </div>
        <Button type="submit" aria-disabled={saving || undefined} aria-busy={saving || undefined} className="h-12 w-full text-[15px]">
          {saving ? 'Saving…' : 'Save and go to the office'}
        </Button>
      </form>
    </AuthFrame>
  )
}
