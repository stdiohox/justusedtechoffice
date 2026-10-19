import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/authStore'
import { Button, FieldError, Input, Label } from '@/components/ui/primitives'

/**
 * Sign in with email and password. Nobody signs up here: Mr Tito invites each
 * person, and the invite email carries the link to set a password. "Forgot
 * your password?" sends a fresh link to an email on the team (api/auth/recover),
 * and says the same thing whether or not the email is known.
 */

/** The brand panel beside the form: JustUsedTech green, the mark and a line. */
export function AuthFrame({ title, subtitle, children, headingId }: { title: string; subtitle: string; children: ReactNode; headingId?: string }) {
  return (
    <div className="grid min-h-[100dvh] bg-surface md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div aria-label="About JUSTUSED Office" role="region" className="relative hidden overflow-hidden bg-[var(--sidebar-bg)] p-10 text-white md:flex md:flex-col">
        <span className="flex items-center gap-2.5">
          {/* TODO: swap for final vector/SVG logo when client delivers it */}
          <img src="/jut-icon-mark.png" alt="" width={36} height={36} className="size-9 rounded-[10px] object-contain" />
          <span className="text-[17px] font-extrabold tracking-[0.02em]">
            JUSTUSED <span className="font-semibold opacity-80">Office</span>
          </span>
        </span>
        <div className="mt-auto max-w-[420px]">
          <p className="text-[34px] leading-tight font-extrabold tracking-[-0.01em]">The team, in one office.</p>
          <p className="mt-3 text-[15px] leading-relaxed text-[var(--on-dark-muted)]">
            See who is in, knock on a door, and file the day’s three reports.
          </p>
        </div>
        <span aria-hidden className="pointer-events-none absolute -right-24 -bottom-24 size-[360px] rounded-full bg-[rgba(0,166,82,0.22)] blur-[90px]" />
        <span aria-hidden className="pointer-events-none absolute top-24 -right-10 size-[200px] rounded-full bg-[rgba(0,173,239,0.16)] blur-[80px]" />
      </div>
      <main className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-[380px]">
          <span className="mb-8 flex items-center gap-2 md:hidden">
            {/* TODO: swap for final vector/SVG logo when client delivers it */}
            <img src="/jut-icon-mark.png" alt="" width={32} height={32} className="size-8 rounded-[8px] object-contain" />
            <span className="text-[16px] font-extrabold text-text-primary">
              JUSTUSED <span className="font-semibold text-text-secondary">Office</span>
            </span>
          </span>
          <h1 id={headingId} tabIndex={-1} className="font-display text-[28px] leading-tight text-text-primary outline-none">
            {title}
          </h1>
          <p className="mt-1 text-[14px] text-text-secondary">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
      </main>
    </div>
  )
}

export function Login() {
  const id = useId()
  const navigate = useNavigate()
  const location = useLocation()
  const { signIn, loading, session, profile, initialized } = useAuthStore()
  // Back to where they were going, if a guard sent them here.
  const from = (location.state as { from?: string } | null)?.from
  const target = from && from.startsWith('/') && !from.startsWith('//') && from !== '/login' ? from : '/office'
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [sending, setSending] = useState(false)

  // Each view's heading takes focus when the view changes: the button that
  // was pressed is gone, and focus must not fall to <body>.
  const headingId = `${id}-h`
  const [moved, setMoved] = useState(false)
  useEffect(() => {
    if (moved) document.getElementById(headingId)?.focus()
  }, [mode, sent, moved, headingId])
  const go = (next: 'signin' | 'forgot') => {
    setMoved(true)
    setMode(next)
    setSent(false)
    setProblem(null)
  }

  // Only with a profile: signIn() is still checking one while the session lands.
  if (initialized && session && profile) return <Navigate to={target} replace />

  const onSignIn = async (e: FormEvent) => {
    e.preventDefault()
    if (loading) return
    if (!email.trim() || !password) return setProblem('Enter your email and password.')
    setProblem(null)
    // signIn resolves with { error }; it does not throw.
    const { error } = await signIn(email, password)
    if (error) return setProblem(error)
    navigate(target, { replace: true })
  }

  const onForgot = async (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setProblem('Enter the email you sign in with.')
    setProblem(null)
    setSending(true)
    const res = await fetch('/api/auth/recover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    }).catch(() => null)
    setSending(false)
    if (!res) return setProblem('Cannot reach the server. Check your connection and try again.')
    if (res.status === 429) return setProblem('A link went out a moment ago. Check your inbox, or try again in an hour.')
    if (!res.ok) return setProblem('That did not go through. Try again in a moment.')
    setMoved(true)
    setSent(true)
  }

  // Always mounted, so screen readers announce the change when it is filled.
  const status = (
    <p role="status" aria-live="polite" className="sr-only">
      {sent ? `If ${email.trim()} is on the team, a link to set a new password is on its way.` : ''}
    </p>
  )

  if (mode === 'forgot') {
    return (
      <AuthFrame headingId={headingId} title={sent ? 'Check your inbox' : 'Set a new password'} subtitle="We email a link to the address you sign in with.">
        {status}
        {sent ? (
          <div className="space-y-4">
            <p className="rounded-[14px] bg-tint-brand px-4 py-3 text-[14px] text-text-primary">
              If {email.trim()} is on the team, a link to set a new password is on its way. It works for one hour.
            </p>
            <Button variant="secondary" onClick={() => go('signin')}>
              Back to sign in
            </Button>
          </div>
        ) : (
          <form onSubmit={onForgot} className="space-y-4" noValidate>
            <div>
              <Label htmlFor={`${id}-email`}>Email</Label>
              <Input
                id={`${id}-email`}
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                invalid={!!problem}
                aria-describedby={problem ? `${id}-err` : undefined}
                className="h-11"
              />
            </div>
            <div id={`${id}-err`}>
              <FieldError>{problem}</FieldError>
            </div>
            <Button type="submit" aria-disabled={sending || undefined} aria-busy={sending || undefined} className="h-11 w-full">
              {sending ? 'Sending…' : 'Email me a link'}
            </Button>
            <button
              type="button"
              onClick={() => go('signin')}
              className="press block min-h-11 w-full text-center text-[13px] text-text-secondary underline underline-offset-2 hover:text-text-primary"
            >
              Back to sign in
            </button>
          </form>
        )}
      </AuthFrame>
    )
  }

  return (
    <AuthFrame headingId={headingId} title="Welcome back" subtitle="Sign in to the JustUsedTech office.">
      <form onSubmit={onSignIn} className="space-y-4" noValidate>
        <div>
          <Label htmlFor={`${id}-email`}>Email</Label>
          <Input
            id={`${id}-email`}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            invalid={!!problem}
            aria-describedby={problem ? `${id}-err` : undefined}
            className="h-11"
          />
        </div>
        <div>
          <Label htmlFor={`${id}-password`}>Password</Label>
          <Input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            invalid={!!problem}
            aria-describedby={problem ? `${id}-err` : undefined}
            className="h-11"
          />
        </div>
        <div id={`${id}-err`}>
          <FieldError>{problem}</FieldError>
        </div>
        <Button type="submit" aria-disabled={loading || undefined} aria-busy={loading || undefined} className="h-11 w-full">
          {loading ? 'Signing in…' : 'Sign in'}
        </Button>
        <button
          type="button"
          onClick={() => go('forgot')}
          className="press block min-h-11 w-full text-center text-[13px] text-text-secondary underline underline-offset-2 hover:text-text-primary"
        >
          Forgot your password?
        </button>
        <p className="text-center text-[12px] text-text-muted">New to the team? Mr Tito sends you an invite by email.</p>
      </form>
    </AuthFrame>
  )
}
