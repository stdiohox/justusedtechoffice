import { useId, useRef } from 'react'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, LogOut } from 'lucide-react'
import { useOfficeRole, useOfficeSettings } from '@/hooks/useOffice'
import { useLeaveOffice, useMyOfficeState } from '@/hooks/useOfficeActivity'
import { useOfficeModes, usePresence } from '@/hooks/useOfficePresence'
import { useNow } from '@/hooks/useNow'
import { BUSY_CHOICES, STATUS_LABEL, type MapStatus } from '@/lib/presence'
import { localParts } from '@/lib/timezones'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { focusFallback } from '@/lib/focus'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { StatusWord } from '@/components/office/OfficeVisuals'

/**
 * Your status in one control (tito-crm's OFFICE-ACTIVITY-PLAN 4.1, option 2): available,
 * working elsewhere, do not disturb for 30, 60 or 90 minutes, or sign
 * out of the office. In the top bar and on Your desk. Each mode is boxed by
 * the server (0008): it ends by itself, and a check-in comes when it does.
 */

const ITEM =
  'flex min-h-9 cursor-default items-center gap-2 rounded-[8px] px-2.5 text-[13px] text-text-primary outline-none select-none data-[highlighted]:bg-[var(--hover)] max-sm:min-h-11'

const busyLabel = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m} minutes`)

export function StatusMenu({ compact = false }: { compact?: boolean }) {
  const userId = useAuthStore((s) => s.profile?.id)
  const { isMember } = useOfficeRole()
  const { data: settings } = useOfficeSettings()
  const { data: state } = useMyOfficeState(userId, isMember)
  const gate = usePresence((s) => s.gate)
  const mine = usePresence((s) => s.mine)
  const { modes, outsideAvailable, setBusy, setOutside, clear, pending } = useOfficeModes()
  const leave = useLeaveOffice()
  const showToast = useToastStore((s) => s.showToast)
  const now = useNow(15_000).getTime()
  const dndId = useId()
  // Signing out removes this control: Radix must not try to focus it again.
  const leaving = useRef(false)

  if (gate !== 'in') return null
  const zone = settings?.timezone ?? 'Africa/Lagos'
  const at = (ms: number) => localParts(zone, new Date(ms)).time
  const busyOn = modes.busyUntil !== null && modes.busyUntil > now
  const outsideOn = !busyOn && modes.outsideUntil !== null && modes.outsideUntil > now
  // The chosen mode names the control; otherwise what this tab reports.
  const status: MapStatus = busyOn ? 'busy' : outsideOn ? 'outside' : (mine ?? 'online')
  const until = busyOn ? modes.busyUntil : outsideOn ? modes.outsideUntil : null
  const maxBusy = settings?.busy_max_minutes ?? 90
  const outsideHours = (settings?.outside_max_minutes ?? 120) / 60
  const canLeave = state?.available === true && state.expects

  const run = (p: Promise<unknown>, done?: string) =>
    p.then(
      () => done && showToast(done, 'success'),
      (err: unknown) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
    )

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          'press flex shrink-0 items-center gap-1.5 rounded-[14px] text-left transition-colors duration-150 hover:bg-hover',
          compact ? 'h-9 px-2' : 'hairline h-8 bg-surface-raised px-2.5',
          TOUCH,
          pending && 'cursor-progress',
        )}
        aria-label={`Your status: ${STATUS_LABEL[status]}${until ? ` until ${at(until)}` : ''}. Change it`}
      >
        <StatusWord status={status} />
        {until && !compact ? <span className="tnum text-[12px] text-text-muted">until {at(until)}</span> : null}
        <ChevronDown size={13} strokeWidth={1.75} aria-hidden className="text-text-muted" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="end"
          sideOffset={6}
          onCloseAutoFocus={(e) => {
            if (leaving.current) e.preventDefault()
          }}
          className="z-50 w-[248px] rounded-[14px] border border-line bg-surface-raised p-1 shadow-[var(--shadow-md)]"
        >
          <Menu.Item className={ITEM} onSelect={() => void run(clear())}>
            <span className="flex w-4 justify-center">{!busyOn && !outsideOn ? <Check size={14} aria-hidden /> : null}</span>
            Available
            {!busyOn && !outsideOn ? <span className="sr-only"> (current)</span> : null}
          </Menu.Item>
          {outsideAvailable ? (
            <Menu.Item
              className={ITEM}
              onSelect={() => {
                // Check-ins reach a background tab by notification: ask now,
                // while there is a click to ask on.
                if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
                void run(setOutside(), `Working elsewhere for ${outsideHours} hours. Answer "Still there?" when it asks.`)
              }}
            >
              <span className="flex w-4 justify-center">{outsideOn ? <Check size={14} aria-hidden /> : null}</span>
              <span className="min-w-0">
                Working elsewhere
                {outsideOn ? <span className="sr-only"> (current)</span> : null}
                <span className="block text-[12px] text-text-muted">WhatsApp, Canva, calls. Check-ins about every 30 min.</span>
              </span>
            </Menu.Item>
          ) : null}
          <Menu.Separator className="my-1 h-px bg-[var(--line)]" />
          {/* The group is named by its label, so "30 minutes" is heard as do not disturb. */}
          <Menu.Group aria-labelledby={dndId}>
            <Menu.Label id={dndId} className="px-2.5 pt-1 pb-0.5 text-[11px] font-medium tracking-[0.08em] text-text-muted uppercase">
              Do not disturb{busyOn && modes.busyUntil ? ` · on until ${at(modes.busyUntil)}` : ''}
            </Menu.Label>
            {BUSY_CHOICES.filter((m) => m <= maxBusy).map((m) => (
              <Menu.Item
                key={m}
                className={ITEM}
                onSelect={() => void run(setBusy(m), `Do not disturb until ${at(Date.now() + m * 60_000)}`)}
              >
                <span className="w-4" />
                {busyLabel(m)}
                <span className="sr-only">{busyOn ? ', starting now' : ''}</span>
              </Menu.Item>
            ))}
          </Menu.Group>
          {canLeave ? (
            <>
              <Menu.Separator className="my-1 h-px bg-[var(--line)]" />
              <Menu.Item
                className={cn(ITEM, 'text-state-danger')}
                onSelect={() => {
                  leaving.current = true
                  void leave.mutateAsync().then(
                    () => {
                      showToast('Signed out of the office', 'success')
                      // The "You're signed out" card has replaced this control.
                      setTimeout(focusFallback, 50)
                    },
                    (err: unknown) => {
                      leaving.current = false
                      showToast(err instanceof Error ? err.message : 'That did not work.', 'error')
                    },
                  )
                }}
              >
                <LogOut size={14} strokeWidth={1.75} aria-hidden className="w-4" />
                Sign out of the office
              </Menu.Item>
            </>
          ) : null}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  )
}
