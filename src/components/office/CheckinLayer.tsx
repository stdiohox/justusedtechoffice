import { useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation } from 'react-router-dom'
import { DoorClosed, Loader2 } from 'lucide-react'
import { Button, FieldError, Input } from '@/components/ui/primitives'
import { useOfficeRole, useOfficeSettings } from '@/hooks/useOffice'
import { useAddDayNote, useAnswerCheckin, useMyOfficeState, useRejoinOffice } from '@/hooks/useOfficeActivity'
import { usePresence } from '@/hooks/useOfficePresence'
import { useNow } from '@/hooks/useNow'
import { CHECKIN_COPY, LEFT_REASON, countdown } from '@/lib/activity'
import { findOpenModal, focusFallback, SIGNED_OUT_HEADING } from '@/lib/focus'
import { localParts } from '@/lib/timezones'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'

/**
 * Check-ins and sign-outs (0008), wherever you are in the office. Mounted once in
 * the shell, like knocks.
 *
 *   "Still there?"      only while working elsewhere, and "still
 *                       heads-down?" when do not disturb runs out. The server
 *                       issues them and sets the deadline; this shows them,
 *                       moves focus to them (unless you are typing), and,
 *                       when the office is not the window in front, raises a
 *                       system notification, flashes the tab's title and
 *                       plays a short tone.
 *   "You're signed out" with "I'm back", on any page but the office (the
 *                       office shows it on Your desk).
 *   ReturnPrompt (0010) lives here too but is drawn by the office page: after
 *                       25 minutes or more away, a quiet offer to say where
 *                       you were, as a note on your day.
 */

/** The office is not what the person is looking at: another tab, app or window. */
const inBackground = () => document.visibilityState !== 'visible' || !document.hasFocus()

/** Typing somewhere: a moved focus would swallow the next key as an answer. */
function typing(): boolean {
  const el = document.activeElement
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'submit', 'reset'].includes(el.type)
}

/** A short two-note tone. Best effort: browsers may refuse sound before a click. */
function chime() {
  try {
    const ctx = new AudioContext()
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6)
    g.connect(ctx.destination)
    for (const [freq, at] of [
      [880, 0],
      [660, 0.18],
    ] as const) {
      const o = ctx.createOscillator()
      o.frequency.value = freq
      o.connect(g)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + 0.4)
    }
    setTimeout(() => void ctx.close(), 1000)
  } catch {
    // No audio: the card, the title and the notification still show.
  }
}

/** A system notification while the office is in the background. Returned, to close later. */
function notify(title: string, body: string, tag: string): Notification | null {
  if (!inBackground()) return null
  if (!('Notification' in window) || Notification.permission !== 'granted') return null
  try {
    const n = new Notification(`${title} - JUSTUSED Office`, { body, tag, requireInteraction: true })
    n.onclick = () => {
      window.focus()
      n.close()
    }
    return n
  } catch {
    // Some browsers refuse outside a service worker; the card still shows.
    return null
  }
}

/**
 * The open modal, if any. A modal hides the rest of the page from screen
 * readers and traps focus inside itself, so a check-in drawn outside it could
 * be neither heard nor reached: it is drawn inside it instead. Read during
 * render, so the card mounts in the right place the first time (a move later
 * would drop focus and re-mount the announcement); watched only while a
 * check-in is up, re-rendering only when the answer changes.
 */
function useOpenModal(enabled: boolean): HTMLElement | null {
  const current = enabled ? findOpenModal() : null
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const last = useRef(current)
  useEffect(() => {
    last.current = current
  })
  useEffect(() => {
    if (!enabled) return
    const watch = new MutationObserver(() => {
      if (findOpenModal() !== last.current) rerender()
    })
    watch.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
    return () => watch.disconnect()
  }, [enabled])
  return current
}

/**
 * A polite announcement whose text arrives a moment after it mounts: screen
 * readers often ignore a live region that appears already full.
 */
function Announce({ text }: { text: string }) {
  const [said, setSaid] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setSaid(text), 250)
    return () => clearTimeout(t)
  }, [text])
  return (
    <p aria-live="polite" className="sr-only">
      {said}
    </p>
  )
}

/** Ticks every second, only while a check-in is on screen; says so once at a minute left. */
function Countdown({ due }: { due: number }) {
  const now = useNow(1000).getTime()
  const left = due - now
  return (
    <>
      <span className="tnum" aria-hidden>
        {countdown(due, now)} left
      </span>
      <span aria-live="polite" className="sr-only">
        {left > 0 && left <= 60_000 ? 'One minute left to answer.' : ''}
      </span>
    </>
  )
}

/** "You're signed out" and "I'm back". Also used on Your desk. */
export function SignedOutCard({ className }: { className?: string }) {
  const id = useId()
  const userId = useAuthStore((s) => s.profile?.id)
  const { isMember } = useOfficeRole()
  const { data: settings } = useOfficeSettings()
  const { data: state } = useMyOfficeState(userId, isMember)
  const rejoin = useRejoinOffice()
  const showToast = useToastStore((s) => s.showToast)
  const [note, setNote] = useState('')
  if (!state?.available) return null
  const entry = state.entry
  const since = entry?.left_at ? localParts(settings?.timezone ?? 'Africa/Lagos', new Date(entry.left_at)).time : null
  const why = entry?.left_reason ? LEFT_REASON[entry.left_reason] : null

  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn('rounded-[14px] border border-[var(--tint-accent-line)] bg-tint-accent px-4 py-3.5 sm:px-5', className)}
    >
      <div className="flex items-start gap-3.5">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-gold">
          <DoorClosed size={18} strokeWidth={1.75} />
        </span>
        <div className="min-w-0">
          {/* Focusable, so focus has somewhere to land when this replaces what had it. */}
          <h2 id={`${id}-title`} tabIndex={-1} {...{ [SIGNED_OUT_HEADING]: '' }} className="text-[14px] font-medium text-text-primary outline-none">
            You’re signed out of the office
          </h2>
          <p className="text-[13px] text-text-secondary">
            {since ? `Since ${since}` : 'For now'}
            {why ? ` (${why})` : ''}. Until you’re back you show as out.
          </p>
        </div>
      </div>
      <form
        className="mt-3 flex flex-wrap items-end gap-2 pl-[54px] max-sm:pl-0"
        onSubmit={(e) => {
          e.preventDefault()
          if (rejoin.isPending) return
          rejoin.mutate(note, {
            onSuccess: () => {
              setNote('')
              showToast('Welcome back', 'success')
              // This card is gone now; put focus somewhere real.
              setTimeout(focusFallback, 50)
            },
          })
        }}
      >
        <div className="min-w-[200px] flex-1">
          <label htmlFor={`${id}-note`} className="mb-1 block text-[12px] text-text-secondary">
            Where were you? (optional, Mr Tito sees it)
          </label>
          <Input
            id={`${id}-note`}
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="At the bank, on a call…"
            aria-invalid={rejoin.isError || undefined}
            aria-describedby={rejoin.isError ? `${id}-error` : undefined}
            className={cn('h-9', TOUCH)}
          />
        </div>
        <Button type="submit" className={TOUCH} aria-disabled={rejoin.isPending || undefined} icon={rejoin.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : undefined}>
          I’m back
        </Button>
        <div className="basis-full" id={`${id}-error`}>
          <FieldError>{rejoin.error instanceof Error ? rejoin.error.message : null}</FieldError>
        </div>
      </form>
    </section>
  )
}

/**
 * Back after a long spell away: offer a day note for it, prefilled with the
 * times. Declared, shown beside the figures, never added to them (0008's day
 * notes). In the office page's flow, under Your desk, so it covers nothing;
 * it takes no focus, and Escape or "No thanks" puts it away.
 */
export function ReturnPrompt() {
  const id = useId()
  const spell = usePresence((s) => s.awayReturn)
  const userId = useAuthStore((s) => s.profile?.id)
  const { isMember } = useOfficeRole()
  const { data: state } = useMyOfficeState(userId, isMember)
  const { data: settings } = useOfficeSettings()
  const add = useAddDayNote()
  const showToast = useToastStore((s) => s.showToast)
  const zone = settings?.timezone ?? 'Africa/Lagos'
  const from = spell ? localParts(zone, new Date(spell.from)) : null
  const to = spell ? localParts(zone, new Date(spell.to)) : null
  const prefill = from && to ? `${from.time} to ${to.time}: ` : ''
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [shownFor, setShownFor] = useState<number | null>(null)
  // A new spell starts a fresh note, prefilled with its times.
  if (spell && shownFor !== spell.to) {
    setShownFor(spell.to)
    setNote(prefill)
    setProblem(null)
  }
  // Day notes are 0008's: only where they exist.
  if (!spell || !from || !to || !state?.available) return null
  const dismiss = () => {
    usePresence.setState({ awayReturn: null })
    // Gone with its controls: put focus somewhere real if it was inside.
    setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) focusFallback()
    }, 0)
  }
  return (
    <section
      aria-labelledby={`${id}-h`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          dismiss()
        }
      }}
      className="hairline rounded-[14px] bg-surface-raised px-4 py-3.5 shadow-[var(--shadow-sm)] sm:px-5"
    >
      <Announce text={`Welcome back. You were away from the office ${from.time} to ${to.time}. You can add a note to your day.`} />
      <h2 id={`${id}-h`} className="text-[14px] font-medium text-text-primary">
        Welcome back
      </h2>
      <p className="mt-0.5 text-[13px] text-text-secondary">
        You were away from the office {from.time} to {to.time}. Working somewhere else? Say so on your day. It changes no figure;
        Mr Tito sees it beside them.
      </p>
      <form
        className="mt-2.5 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (add.isPending) return
          const body = note.trim()
          if (!body || body === prefill.trim()) {
            setProblem('Say where you were after the times.')
            return
          }
          setProblem(null)
          add.mutate(
            { date: from.date, body },
            {
              onSuccess: () => {
                dismiss()
                showToast('Note added to your day', 'success')
              },
              onError: (err) => setProblem(err instanceof Error ? err.message : 'That did not go through.'),
            },
          )
        }}
      >
        <label htmlFor={`${id}-note`} className="sr-only">
          Where you were
        </label>
        <Input
          id={`${id}-note`}
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-err` : undefined}
          className={cn('h-9 min-w-[200px] flex-1', TOUCH)}
        />
        <Button type="submit" size="sm" className={TOUCH} aria-disabled={add.isPending || undefined}>
          Add to my day
        </Button>
        <Button type="button" variant="ghost" size="sm" className={TOUCH} onClick={dismiss}>
          No thanks
        </Button>
        <div id={`${id}-err`} className="basis-full">
          <FieldError>{problem}</FieldError>
        </div>
      </form>
    </section>
  )
}

export function CheckinLayer() {
  const userId = useAuthStore((s) => s.profile?.id)
  const { isMember } = useOfficeRole()
  const { data: state } = useMyOfficeState(userId, isMember)
  const gate = usePresence((s) => s.gate)
  const outsideUntil = usePresence((s) => s.modes.outsideUntil)
  const answer = useAnswerCheckin()
  const showToast = useToastStore((s) => s.showToast)
  const { pathname } = useLocation()
  const titleId = useId()
  // Whether focus has been in the card (moved there, or tabbed or clicked in).
  const focusedCard = useRef(false)
  const yesRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const answered = useRef(new Set<string>())

  const checkin = state?.available && gate === 'in' ? state.checkin : null
  const due = checkin && state?.available ? Date.parse(checkin.due_at) - state.skew : 0
  const copy = checkin ? CHECKIN_COPY[checkin.kind] : null
  const answerMinutes = checkin ? Math.round((Date.parse(checkin.due_at) - Date.parse(checkin.issued_at)) / 60_000) : 0
  const enforce = state?.available ? state.enforce : false

  const dialog = useOpenModal(!!checkin)
  const pinRef = useRef<HTMLDivElement>(null)
  const pinnedId = checkin?.id ?? null

  // The card moved (a dialog opened or closed while it was up): if it had
  // focus, React's re-mount dropped it; put it back on the answer.
  useLayoutEffect(() => {
    const dropped = !document.activeElement || document.activeElement === document.body
    if (dropped && focusedCard.current) yesRef.current?.focus()
  }, [dialog])

  // Pinned at the foot of a scrolling dialog, the card must not hide the
  // field being typed in: keep the dialog's scroll clear of it.
  useLayoutEffect(() => {
    const pin = pinRef.current
    if (!dialog || !pin) return
    const before = dialog.style.scrollPaddingBottom
    dialog.style.scrollPaddingBottom = `${pin.offsetHeight + 8}px`
    return () => {
      dialog.style.scrollPaddingBottom = before
    }
  }, [dialog, pinnedId])

  // A new check-in: focus its first answer (when the office is in front and the
  // person is not typing), and otherwise reach them where they are.
  const shownId = checkin?.id ?? null
  useEffect(() => {
    if (!shownId || !copy) return
    if (!inBackground() && !typing()) {
      const active = document.activeElement
      returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null
      // After the card is painted.
      setTimeout(() => yesRef.current?.focus(), 0)
    }
    chime()
    const n = notify(copy.title, `${copy.body} Answer within ${answerMinutes} minutes.`, `checkin-${shownId}`)
    // The title flashes while the office is in the background. Only our own
    // marker is ever undone, so a title set meanwhile survives.
    const mark = `● ${copy.title} · `
    const t = setInterval(() => {
      const flashing = document.title.startsWith(mark)
      if (!inBackground()) {
        if (flashing) document.title = document.title.slice(mark.length)
        return
      }
      document.title = flashing ? document.title.slice(mark.length) : mark + document.title
    }, 1000)
    return () => {
      clearInterval(t)
      if (document.title.startsWith(mark)) document.title = document.title.slice(mark.length)
      n?.close()
      // The card is going (answered, expired, answered in another tab). By
      // now React has removed it; if focus was in it, focus has fallen to
      // <body>: hand it back rather than leave it there. Focus the person
      // moved somewhere else is left alone.
      const dropped = !document.activeElement || document.activeElement === document.body
      if (dropped && focusedCard.current) {
        const back = returnFocus.current
        // Still inside an open dialog: stay in it (focus outside it would be
        // somewhere a screen reader has been told to ignore).
        const openDialog = findOpenModal()
        if (back?.isConnected) back.focus()
        else if (openDialog) openDialog.focus()
        else focusFallback()
      }
      returnFocus.current = null
      focusedCard.current = false
    }
    // copy and answerMinutes follow shownId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownId])

  // One gone without an answer from here: missed (or answered in another tab).
  const lastShown = useRef<{ id: string; due: number } | null>(null)
  useEffect(() => {
    const prev = lastShown.current
    if (prev && prev.id !== shownId && !answered.current.has(prev.id) && Date.now() >= prev.due && enforce) {
      showToast('You missed a check-in, so you show as away. You’re in again as soon as you use the office.', 'error')
    }
    lastShown.current = shownId ? { id: shownId, due } : null
  }, [shownId, due, enforce, showToast])

  // Working elsewhere ends after its box: say so, once.
  useEffect(() => {
    if (!outsideUntil || gate !== 'in') return
    const wait = outsideUntil - Date.now()
    if (wait <= 0) return
    const t = setTimeout(() => {
      const still = usePresence.getState().modes.outsideUntil === outsideUntil
      if (!still) return
      showToast('Your time working elsewhere is up. Choose it again from your status if you’re still working.', 'info')
      notify('Working elsewhere has ended', 'Choose it again from your status if you are still working.', 'outside-ended')
    }, wait)
    return () => clearTimeout(t)
  }, [outsideUntil, gate, showToast])

  const respond = (keepGoing: boolean) => {
    if (!checkin || answer.isPending) return
    answered.current.add(checkin.id)
    answer.mutate(
      { id: checkin.id, keepGoing },
      {
        onError: (err) => {
          answered.current.delete(checkin.id)
          showToast(err instanceof Error ? err.message : 'That did not go through.', 'error')
        },
      },
    )
  }

  const showSignedOut = gate === 'signed_out' && !pathname.startsWith('/office')

  // Text only, so a screen reader hears the question, not the buttons.
  // Polite: when focus moves into the card, the card itself is read.
  const announcement = (
    <Announce
      text={`${copy ? `${copy.title} ${copy.body} You have ${answerMinutes} minutes to answer.` : ''}${gate === 'signed_out' ? ' You are signed out of the office.' : ''}`}
    />
  )

  const card =
    checkin && copy ? (
      <div
        onFocus={() => {
          focusedCard.current = true
        }}
        onBlur={(e) => {
          // Left for somewhere else on the page (not removed: that has no target).
          if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node)) focusedCard.current = false
        }}
        role="alertdialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-body`}
        className="knock-in on-dark pointer-events-auto rounded-[14px] border border-[rgba(246,250,247,0.12)] bg-ink p-4 text-ivory shadow-[var(--shadow-lg)]"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={titleId} className="text-[15px] font-medium text-ivory">
            {copy.title}
          </h2>
          <span className="text-[12px] text-[rgba(246,250,247,0.68)]">
            <Countdown due={due} />
          </span>
        </div>
        <p id={`${titleId}-body`} className="mt-1 text-[13px] text-[rgba(246,250,247,0.78)]">
          {copy.body} You have {answerMinutes} minutes.
        </p>
        <div className="mt-3.5 flex flex-wrap gap-2">
          <Button
            ref={yesRef}
            className={cn('bg-gold text-ink hover:bg-ivory hover:text-ink', TOUCH)}
            aria-disabled={answer.isPending || undefined}
            aria-busy={(answer.isPending && answer.variables?.keepGoing) || undefined}
            icon={answer.isPending && answer.variables?.keepGoing ? <Loader2 size={14} className="animate-spin" aria-hidden /> : undefined}
            onClick={() => respond(true)}
          >
            {copy.yes}
          </Button>
          <Button
            variant="ghost"
            className={cn('border border-[rgba(246,250,247,0.22)] text-ivory hover:bg-[rgba(246,250,247,0.08)] hover:text-ivory', TOUCH)}
            aria-disabled={answer.isPending || undefined}
            aria-busy={(answer.isPending && answer.variables?.keepGoing === false) || undefined}
            onClick={() => respond(false)}
          >
            {copy.no}
          </Button>
        </div>
      </div>
    ) : null

  return (
    <>
      {/* With a dialog open, the check-in and its announcement go inside it,
          pinned to its foot, where the keyboard and a screen reader can
          reach them. Otherwise they sit in the corner below. */}
      {dialog && card
        ? createPortal(
            <div ref={pinRef} className="sticky bottom-0 z-10 px-5 pt-2 pb-4">
              {announcement}
              {card}
            </div>,
            dialog,
          )
        : announcement}
      {/* Just under the 64px top bar, clear of the knocks; scrollable if two
          cards outgrow a short screen. */}
      <div className="pointer-events-none fixed top-[76px] right-4 z-[60] flex max-h-[calc(100dvh-92px)] w-[min(380px,calc(100vw-32px))] flex-col gap-2 overflow-y-auto">
        {dialog ? null : card}
        {/* Opaque here: it floats over the page. */}
        {showSignedOut ? <SignedOutCard className="pointer-events-auto bg-surface-raised shadow-[var(--shadow-lg)]" /> : null}

      </div>
    </>
  )
}
