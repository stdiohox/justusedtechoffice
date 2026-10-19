import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { DoorOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { useOfficeMembers } from '@/hooks/useOffice'
import { usePresence } from '@/hooks/useOfficePresence'
import { isMissed, isWaiting, useKnocksRealtime, useMyKnocks, useRespondKnock, type KnockStatus } from '@/hooks/useKnocks'
import { useNow } from '@/hooks/useNow'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { TOUCH } from '@/lib/touch'
import { focusFallback } from '@/lib/focus'

/**
 * Knocks, wherever you are in the office (0005). Mounted once in the shell, like
 * presence: someone in Leads still hears the door. Shows knocks waiting on
 * you, and tells you when someone answers yours, with their reply (0010), or
 * that nobody answered before it lapsed.
 */

/** Ready replies for "not now" (0010). Short, and nothing personal. */
const REPLIES = ['On a call', 'Back in 10 minutes', 'Finishing something'] as const
export function KnockLayer() {
  const gate = usePresence((s) => s.gate)
  const enabled = gate === 'in'
  useKnocksRealtime(enabled)
  const { data: knocks } = useMyKnocks(enabled)
  const { data: members } = useOfficeMembers()
  const userId = useAuthStore((s) => s.profile?.id)
  const now = useNow(15_000).getTime()
  const respond = useRespondKnock()
  const navigate = useNavigate()
  const showToast = useToastStore((s) => s.showToast)

  const name = (id: string) => members?.find((m) => m.user_id === id)?.user?.full_name ?? 'Someone'
  const incoming = (knocks ?? []).filter((k) => k.to_user === userId && isWaiting(k, now))

  // Answers to my knocks, as they arrive. The first load only records state,
  // so opening the office does not replay old answers. An answer to a knock we
  // never saw pending (answered before our first refetch) still counts if it
  // came after this layer mounted.
  const known = useRef<Map<string, KnockStatus> | null>(null)
  const mountedAt = useRef(Date.now())
  useEffect(() => {
    if (!knocks || !userId) return
    const nameOf = (id: string) => members?.find((m) => m.user_id === id)?.user?.full_name ?? 'Someone'
    const first = known.current === null
    const before = known.current ?? new Map<string, KnockStatus>()
    for (const k of knocks) {
      if (k.from_user !== userId || first) continue
      const wasPending = before.get(k.id) === 'pending'
      const freshAnswer = !before.has(k.id) && !!k.responded_at && Date.parse(k.responded_at) > mountedAt.current
      if (!wasPending && !freshAnswer) continue
      if (k.status === 'accepted') {
        showToast(`${nameOf(k.to_user)} let you in`, 'success')
        navigate(`/office?chat=${k.id}`)
      } else if (k.status === 'declined') {
        showToast(k.reply ? `${nameOf(k.to_user)} can't talk right now: ${k.reply}` : `${nameOf(k.to_user)} can't talk right now`, 'info')
      }
    }
    known.current = new Map(knocks.map((k) => [k.id, k.status]))
    // Safe to re-run on any dependency: only a status change since the last
    // run fires anything.
  }, [knocks, userId, members, navigate, showToast])

  // My knock lapsed with nobody answering: say so once. A lapse writes
  // nothing (the deadline passes), so this watches the clock, not the rows.
  // Only knocks seen waiting after this layer mounted count.
  const sawWaiting = useRef(new Set<string>())
  const toldLapsed = useRef(new Set<string>())
  useEffect(() => {
    if (!knocks || !userId) return
    for (const k of knocks) {
      if (k.from_user !== userId) continue
      if (isWaiting(k, now)) sawWaiting.current.add(k.id)
      else if (sawWaiting.current.has(k.id) && !toldLapsed.current.has(k.id) && isMissed(k, now)) {
        toldLapsed.current.add(k.id)
        const who = members?.find((m) => m.user_id === k.to_user)?.user?.full_name ?? 'Someone'
        showToast(`${who} didn't answer. They'll see you knocked.`, 'info')
      }
    }
  }, [knocks, now, userId, members, showToast])

  // A browser notification for a new knock while the tab is in the background.
  const announced = useRef(new Set<string>())
  const incomingKey = incoming.map((k) => k.id).join(',')
  useEffect(() => {
    for (const k of incoming) {
      if (announced.current.has(k.id)) continue
      announced.current.add(k.id)
      if (document.visibilityState === 'visible') continue
      if (!('Notification' in window) || Notification.permission !== 'granted') continue
      try {
        const n = new Notification('Knock knock - JUSTUSED Office', { body: `${name(k.from_user)} is at your office door`, tag: `knock-${k.id}` })
        n.onclick = () => window.focus()
      } catch {
        // Some browsers refuse outside a service worker; the card still shows.
      }
    }
    // incoming is rebuilt each render; its ids are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingKey])

  // Who is knocking, announced by a live region that holds text only; the
  // cards with their buttons sit in a labelled region beside it. (A status
  // role around the buttons made screen readers read controls as a message.)
  const announcement = incoming.length
    ? `${incoming.map((k) => name(k.from_user)).join(', ')} ${incoming.length === 1 ? 'is' : 'are'} knocking on your door.`
    : ''
  return (
    <>
    <p role="status" aria-live="polite" className="sr-only">
      {announcement}
    </p>
    <section
      aria-label="Knocks at your door"
      hidden={!incoming.length}
      className="fixed right-4 bottom-20 z-40 flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 md:bottom-6"
    >
      {incoming.slice(0, 3).map((k) => (
        <div
          key={k.id}
          className="knock-in on-dark rounded-[14px] border border-[rgba(246,250,247,0.12)] bg-ink p-4 text-ivory shadow-[var(--shadow-lg)]"
        >
          <div className="flex items-start gap-3">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[rgba(255,217,102,0.14)] text-gold">
              <DoorOpen size={18} strokeWidth={1.75} className="knock-rap" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium text-ivory">{name(k.from_user)} is knocking</p>
              <p className="mt-0.5 text-[13px] text-[rgba(246,250,247,0.68)]">Let them in for a quick chat?</p>
            </div>
          </div>
          <div className="mt-3.5 flex gap-2 pl-[52px]">
            <Button
              className={`bg-gold text-ink hover:bg-ivory hover:text-ink ${TOUCH}`}
              // aria-disabled, not disabled: disabling the pressed button would
              // drop keyboard focus to <body> while the answer is sent.
              aria-disabled={respond.isPending || undefined}
              aria-busy={(respond.isPending && respond.variables?.id === k.id && respond.variables.accept) || undefined}
              icon={respond.isPending && respond.variables?.id === k.id && respond.variables.accept ? <Loader2 size={14} className="animate-spin" aria-hidden /> : undefined}
              onClick={() =>
                !respond.isPending &&
                respond.mutate(
                  { id: k.id, accept: true },
                  {
                    onSuccess: () => navigate(`/office?chat=${k.id}`),
                    onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
                  },
                )
              }
            >
              Let in
            </Button>
            <Button
              variant="ghost"
              className={`border border-[rgba(246,250,247,0.22)] text-ivory hover:bg-[rgba(246,250,247,0.08)] hover:text-ivory ${TOUCH}`}
              aria-disabled={respond.isPending || undefined}
              aria-busy={(respond.isPending && respond.variables?.id === k.id && !respond.variables.accept) || undefined}
              icon={respond.isPending && respond.variables?.id === k.id && !respond.variables.accept ? <Loader2 size={14} className="animate-spin" aria-hidden /> : undefined}
              onClick={() =>
                !respond.isPending &&
                respond.mutate(
                  { id: k.id, accept: false },
                  {
                    onSuccess: () => setTimeout(focusFallback, 0),
                    onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
                  },
                )
              }
            >
              Not now
            </Button>
          </div>
          {/* Only where the database keeps replies (0010: the row has the column). */}
          {'reply' in k ? (
          <div className="mt-2 flex flex-wrap gap-1.5 pl-[52px] max-sm:pl-0" role="group" aria-label={`Not now, with a reply to ${name(k.from_user)}`}>
            {REPLIES.map((r) => (
              <button
                key={r}
                type="button"
                aria-disabled={respond.isPending || undefined}
                onClick={() =>
                  !respond.isPending &&
                  respond.mutate(
                    { id: k.id, accept: false, reply: r },
                    {
                      // The card goes with the answer: put focus somewhere real.
                      onSuccess: () => setTimeout(focusFallback, 0),
                      onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
                    },
                  )
                }
                className={`press rounded-[8px] border border-[rgba(246,250,247,0.16)] px-2 py-0.5 text-[12px] text-[rgba(246,250,247,0.78)] hover:bg-[rgba(246,250,247,0.08)] hover:text-ivory ${TOUCH} max-sm:px-3`}
              >
                {r}
              </button>
            ))}
          </div>
          ) : null}
        </div>
      ))}
    </section>
    </>
  )
}
