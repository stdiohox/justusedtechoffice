import { Fragment, useId, useState } from 'react'
import { Button, Select } from '@/components/ui/primitives'
import { Modal } from '@/components/ui/Modal'
import { useOfficeRole, useOfficeSettings } from '@/hooks/useOffice'
import { useSetEnforcement, useSetShortDay } from '@/hooks/useOfficeActivity'
import { useToastStore } from '@/stores/toastStore'
import { cn } from '@/lib/utils'

/**
 * Trial or enforced (0008), Mr Tito only. In trial everything is recorded
 * and nothing acts on it; enforced, a sign-out shuts the office until "I'm
 * back", a missed "still there?" ends working elsewhere, and each
 * person's day goes into his 18:30 summary email. No flag, no other email.
 */
export function ActivitySettings() {
  const { data: settings } = useOfficeSettings()
  const { isManager } = useOfficeRole()
  const set = useSetEnforcement()
  const showToast = useToastStore((s) => s.showToast)
  const [confirm, setConfirm] = useState(false)
  const headingId = useId()

  // Until 0008 is applied the column is not there, and there is nothing to switch.
  if (!isManager || settings?.enforce_activity === undefined) return null
  const on = settings.enforce_activity
  const timings = [
    ['Away', 'after 10 minutes with no key, click or scroll in the office'],
    ['Signed out', `after ${settings.away_signout_minutes ?? 30} more minutes away, or ${settings.away_signout_minutes ?? 30} minutes with no sign of the office`],
    ['Do not disturb', `30, 60 or 90 minutes at a time (at most ${settings.busy_max_minutes ?? 90})`],
    ['Working elsewhere', `up to ${(settings.outside_max_minutes ?? 120) / 60} hours, with "Still there?" about every ${settings.checkin_every_minutes ?? 30} minutes`],
    ['Check-ins', `answered within ${settings.checkin_answer_minutes ?? 5} minutes`],
  ] as const

  return (
    <section aria-labelledby={headingId} className="hairline mt-8 rounded-[14px] bg-surface-raised px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id={headingId} className="mr-auto text-[15px] font-medium text-text-primary">
          Office activity
        </h2>
        <span
          className={cn(
            'rounded-[8px] px-2 py-0.5 text-[12px] font-medium',
            on ? 'bg-tint-danger text-state-danger' : 'bg-tint-accent text-text-primary',
          )}
        >
          {on ? 'Enforced' : 'Trial: recording only'}
        </span>
      </div>
      <p className="mt-1.5 max-w-[68ch] text-[13px] text-text-secondary">
        {on
          ? 'Someone signed out after inactivity must press "I’m back" before they show as in again, and a missed "Still there?" ends their time working elsewhere. Your 18:30 summary email shows each person’s active time, sign-outs and missed check-ins. No other email or flag.'
          : 'Sign-outs and missed check-ins are recorded and shown in Reports, but nothing acts on them: people come back in by themselves. Turn enforcement on after the trial week, once the timings look right.'}
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]">
        {timings.map(([k, v]) => (
          <Fragment key={k}>
            <dt className="text-text-muted">{k}</dt>
            <dd className="text-text-primary">{v}</dd>
          </Fragment>
        ))}
      </dl>
      <p className="mt-2 text-[12px] text-text-muted">The timings are changed in the database (office_settings); see the README, “Changing the timings”.</p>
      <ShortDay />
      <Button variant={on ? 'secondary' : 'primary'} className="mt-4 max-sm:min-h-11" onClick={() => setConfirm(true)}>
        {on ? 'Back to trial' : 'Turn enforcement on'}
      </Button>
      <Modal
        open={confirm}
        onOpenChange={setConfirm}
        title={on ? 'Back to trial?' : 'Turn enforcement on?'}
        description={
          on
            ? 'Sign-outs and missed check-ins will be recorded only. Nobody has to press "I’m back".'
            : 'From now on, anyone signed out after inactivity, or by their end-of-day report, has to press "I’m back" to show as in, and your 18:30 summary email adds each person’s active time, sign-outs and missed check-ins. Tell the team first.'
        }
        footer={
          <>
            <Button variant="ghost" disabled={set.isPending} onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              loading={set.isPending}
              onClick={() =>
                set.mutate(!on, {
                  onSuccess: () => {
                    setConfirm(false)
                    showToast(on ? 'Back to trial: recording only' : 'Enforcement is on', 'success')
                  },
                  onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
                })
              }
            >
              {on ? 'Back to trial' : 'Turn it on'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-text-secondary">You can switch back at any time. Nothing recorded so far changes.</p>
      </Modal>
    </section>
  )
}

/** Hours offered for a short day. */
const SHORT_DAY_CHOICES = [4, 5, 6, 7] as const

/**
 * Short day (0010): a signed-in day with less working time than this reads
 * "short" on the month view and, once enforced, in the 18:30 summary. Only
 * once 0010 is applied (the setting is there).
 */
function ShortDay() {
  const { data: settings } = useOfficeSettings()
  const set = useSetShortDay()
  const showToast = useToastStore((s) => s.showToast)
  const id = useId()
  if (settings?.short_day_minutes === undefined) return null
  const value = settings.short_day_minutes === null ? '' : String(settings.short_day_minutes)
  return (
    <div className="hairline-t mt-4 flex flex-wrap items-end gap-3 pt-4">
      <div className="w-[200px]">
        <label htmlFor={`${id}-short`} className="mb-1 block text-[12px] font-medium text-text-secondary">
          Short day
        </label>
        <Select
          id={`${id}-short`}
          value={value}
          aria-busy={set.isPending || undefined}
          aria-describedby={`${id}-short-hint`}
          onChange={(e) => {
            // Read now: once saved, the controlled value has already moved on.
            const v = e.target.value
            set.mutate(v ? Number(v) : null, {
              onSuccess: () => showToast(v ? 'Short day saved' : 'Short day turned off', 'success'),
              onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
            })
          }}
          className="h-9 text-[13px] max-sm:h-11"
        >
          <option value="">Off</option>
          {/* A value set in the database that is not one of the choices still shows. */}
          {value && !SHORT_DAY_CHOICES.some((h) => String(h * 60) === value) ? (
            <option value={value}>Under {Number(value) / 60} hours working</option>
          ) : null}
          {SHORT_DAY_CHOICES.map((h) => (
            <option key={h} value={String(h * 60)}>
              Under {h} hours working
            </option>
          ))}
        </Select>
      </div>
      <p id={`${id}-short-hint`} className="min-w-[220px] flex-1 text-[12px] text-text-muted">
        Marks a day with a sign-in but less working time than this, on the month view and (once enforced) in your 18:30 summary.
        A prompt for a conversation: no flag and no email to them.
      </p>
    </div>
  )
}
