import { useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check } from 'lucide-react'
import { Button } from '@/components/ui/primitives'
import { Modal } from '@/components/ui/Modal'
import { useAckNotice, useNotificationsAnswered, useOnboardingStatus } from '@/hooks/useOfficeOnboarding'
import { usePhotos } from '@/hooks/usePhotos'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { NOTICE, NOTICE_TITLE, NOTICE_VERSION } from '@/lib/officeNotice'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { focusFallback } from '@/lib/focus'
import type { OfficeOnboardingRow } from '@/types/database'

/**
 * A new member's first steps (0010), on the office page until they are done:
 * read the staff notice, add a photo, file a first sign-in, write on your
 * door, answer the notifications question, knock on a door. Most are worked
 * out by the database from what already happened; nothing new is tracked.
 * Mr Tito sees everyone's progress in Reports > Team.
 */

/** Per person per day, so "hide for today" does not hide it for the next login. */
const hiddenKey = (userId: string) => `tito-office-onboarding-hidden:${userId}:${new Date().toDateString()}`

function readHidden(userId: string): boolean {
  try {
    return localStorage.getItem(hiddenKey(userId)) === '1'
  } catch {
    return false
  }
}

export interface Step {
  id: string
  label: string
  done: boolean
}

/** The steps for one member, in the order they make sense. */
export function onboardingSteps(row: OfficeOnboardingRow, photos: boolean): Step[] {
  return [
    { id: 'notice', label: 'Read how the office records your time', done: !!row.notice_acked_at },
    ...(photos ? [{ id: 'photo', label: 'Add a photo', done: row.photo }] : []),
    { id: 'signin', label: 'File your first sign-in', done: row.signin },
    { id: 'door', label: 'Write on your door', done: row.door },
    { id: 'notifications', label: 'Choose whether to get notifications', done: row.notifications },
    { id: 'knock', label: 'Knock on a colleague’s door', done: row.knock },
  ]
}

/** The staff notice, with "I've read this" while this version is not yet acknowledged. */
export function NoticeDialog({
  open,
  onOpenChange,
  acked,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  acked: boolean
  /** Where focus goes when the button that opened it is gone ("Read it", once read). */
  onCloseAutoFocus?: (event: Event) => void
}) {
  const ack = useAckNotice()
  const showToast = useToastStore((s) => s.showToast)
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={NOTICE_TITLE}
      description="What the office records about you, who sees it and for how long."
      onCloseAutoFocus={onCloseAutoFocus}
      footer={
        acked ? (
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => !ack.isPending && onOpenChange(false)}>
              Later
            </Button>
            {/* aria-disabled, not disabled: disabling the focused button would drop focus. */}
            <Button
              aria-disabled={ack.isPending || undefined}
              aria-busy={ack.isPending || undefined}
              onClick={() =>
                !ack.isPending &&
                ack.mutate(NOTICE_VERSION, {
                  onSuccess: () => {
                    onOpenChange(false)
                    showToast('Thanks. You can read it again under My reports.', 'success')
                  },
                  onError: (err) => showToast(err instanceof Error ? err.message : 'That did not go through.', 'error'),
                })
              }
            >
              I’ve read this
            </Button>
          </>
        )
      }
    >
      <div className="max-h-[55vh] space-y-4 overflow-y-auto text-[13px] text-text-secondary">
        {NOTICE.map((s) => (
          <section key={s.heading}>
            <h3 className="text-[13px] font-medium text-text-primary">{s.heading}</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {s.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </section>
        ))}
        {!acked ? (
          <p className="text-[12px] text-text-muted">“I’ve read this” records that you were told. It is not consent, and it changes nothing about what is recorded.</p>
        ) : null}
      </div>
    </Modal>
  )
}

/** "How the office records your time", for anyone in the office to reread. */
export function NoticeLink({ className }: { className?: string }) {
  const userId = useAuthStore((s) => s.profile?.id)
  const { data } = useOnboardingStatus(!!userId)
  const [open, setOpen] = useState(false)
  if (!data?.available) return null
  const mine = data.rows.find((r) => r.user_id === userId)
  const acked = !!mine?.notice_acked_at
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn('press text-[12px] text-text-secondary underline underline-offset-2 hover:text-text-primary', TOUCH, className)}
      >
        {NOTICE_TITLE}
      </button>
      <NoticeDialog open={open} onOpenChange={setOpen} acked={acked} />
    </>
  )
}

export function Onboarding() {
  const id = useId()
  const userId = useAuthStore((s) => s.profile?.id)
  const { data } = useOnboardingStatus(!!userId)
  const { data: photos } = usePhotos()
  const answered = useNotificationsAnswered()
  const showToast = useToastStore((s) => s.showToast)
  const [noticeOpen, setNoticeOpen] = useState(false)
  const [hidden, setHidden] = useState(() => (userId ? readHidden(userId) : false))
  // Steps' buttons go away once done; focus lands on the heading instead of <body>.
  const headingRef = useRef<HTMLHeadingElement>(null)

  if (!data?.available || !userId || hidden) return null
  const mine = data.rows.find((r) => r.user_id === userId)
  if (!mine) return null
  const steps = onboardingSteps(mine, !!photos?.available)
  const done = steps.filter((s) => s.done).length
  if (done === steps.length) return null

  const askNotifications = async () => {
    if (answered.isPending) return
    try {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission()
    } catch {
      // Some browsers refuse outside a click or a service worker: the choice still counts as made.
    }
    const allowed = 'Notification' in window && Notification.permission === 'granted'
    answered.mutate(undefined, {
      onSuccess: () => {
        headingRef.current?.focus()
        showToast(allowed ? 'Notifications are on for knocks and check-ins' : 'No notifications: you will see knocks and check-ins while the office is open', 'info')
      },
      onError: (err) => showToast(err instanceof Error ? err.message : 'That did not go through.', 'error'),
    })
  }

  const action = (step: Step) => {
    if (step.done) return null
    const btn = 'press text-[12px] text-brand underline underline-offset-2 hover:text-text-primary'
    switch (step.id) {
      case 'notice':
        return (
          <button type="button" className={cn(btn, TOUCH)} onClick={() => setNoticeOpen(true)}>
            Read it
          </button>
        )
      case 'signin':
        return (
          <Link to="/reports" className={cn(btn, TOUCH, 'max-sm:inline-flex max-sm:items-center')}>
            Go to My reports
          </Link>
        )
      case 'notifications':
        return (
          <button type="button" className={cn(btn, TOUCH)} aria-disabled={answered.isPending || undefined} onClick={() => void askNotifications()}>
            Choose
          </button>
        )
      case 'photo':
        return <span className="text-[12px] text-text-muted">“Add photo” on Your desk</span>
      case 'door':
        return <span className="text-[12px] text-text-muted">“Say what you’re on” on Your desk</span>
      case 'knock':
        return <span className="text-[12px] text-text-muted">Knock on any office below</span>
      default:
        return null
    }
  }

  return (
    <section aria-labelledby={`${id}-h`} className="hairline rounded-[14px] bg-surface-raised px-4 py-3.5 shadow-[var(--shadow-sm)] sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-h`} ref={headingRef} tabIndex={-1} className="mr-auto text-[14px] font-medium text-text-primary outline-none">
          Getting started in the office
        </h2>
        <span className="tnum text-[12px] text-text-muted">
          {done} of {steps.length} done
        </span>
        <button
          type="button"
          className={cn('press text-[12px] text-text-muted hover:text-text-primary', TOUCH)}
          onClick={() => {
            try {
              localStorage.setItem(hiddenKey(userId), '1')
            } catch {
              // Private mode: hidden for this visit only.
            }
            setHidden(true)
            // The whole card goes: put focus somewhere real.
            setTimeout(focusFallback, 0)
          }}
        >
          Hide for today
        </button>
      </div>
      <ol className="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {steps.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            <span
              aria-hidden
              className={cn(
                'flex size-[18px] shrink-0 items-center justify-center rounded-full',
                s.done ? 'bg-brand text-surface-raised' : 'shadow-[inset_0_0_0_1.5px_var(--line-strong-role)]',
              )}
            >
              {s.done ? <Check size={11} strokeWidth={3} /> : null}
            </span>
            <span className={s.done ? 'text-text-muted line-through' : 'text-text-primary'}>
              {s.label}
              <span className="sr-only">{s.done ? ' (done)' : ' (to do)'}</span>
            </span>
            {action(s)}
          </li>
        ))}
      </ol>
      <NoticeDialog
        open={noticeOpen}
        onOpenChange={setNoticeOpen}
        acked={steps[0].done}
        onCloseAutoFocus={(e) => {
          // "Read it" goes once the notice is read (after the refetch, not at
          // close): land on the card's heading, which stays, either way.
          e.preventDefault()
          headingRef.current?.focus()
        }}
      />
    </section>
  )
}
