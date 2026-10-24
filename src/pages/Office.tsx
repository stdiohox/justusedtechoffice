import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Camera, DoorClosed, DoorOpen, Loader2, Users } from 'lucide-react'
import { ChatPanel } from '@/components/office/ChatPanel'
import { isChatOpen, isWaiting, useCancelKnock, useKnock, useMissedKnocks, useMyKnocks, type Knock } from '@/hooks/useKnocks'
import { useToastStore } from '@/stores/toastStore'
import { Button, EmptyState, Skeleton } from '@/components/ui/primitives'
import { useOfficeMembers, useOfficeRole, useOfficeSettings, type OfficeMemberWithUser } from '@/hooks/useOffice'
import { usePresence } from '@/hooks/useOfficePresence'
import { useNow } from '@/hooks/useNow'
import { titleOf } from '@/lib/constants'
import { mapStatus, type MapStatus } from '@/lib/presence'
import { localParts, wallTimeToInstant } from '@/lib/timezones'
import { doorView, steppedOut, EMPTY_DOOR, type DoorView } from '@/lib/door'
import { useOfficeStatusRealtime, useOfficeStatuses } from '@/hooks/useOfficeStatus'
import { DeskEditor, DoorNote } from '@/components/office/Doors'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { Avatar, StatusWord } from '@/components/office/OfficeVisuals'
import { useAuthStore } from '@/stores/authStore'
import { PhotoEditor } from '@/components/PhotoEditor'
import { StatusMenu } from '@/components/office/StatusMenu'
import { ReturnPrompt, SignedOutCard } from '@/components/office/CheckinLayer'
import { useEntries } from '@/hooks/useOfficeActivity'
import { LEFT_SHORT, countdown } from '@/lib/activity'
import type { OfficeEntry } from '@/types/database'
import { usePhotos } from '@/hooks/usePhotos'
import { Onboarding } from '@/components/office/Onboarding'

/**
 * The office map (tito-crm's VIRTUAL-OFFICE-PLAN Phase 2): one private office per
 * person, with who is in, away, on do-not-disturb or out. Presence is live
 * from the Realtime channel (useOfficePresence, mounted in the shell); this
 * page only draws it.
 */

/** Buttons on the dark floor: a quiet fill that lights gold on hover. */
const ON_FLOOR =
  'border border-[rgba(246,250,247,0.22)] bg-[rgba(246,250,247,0.08)] text-ivory hover:bg-gold hover:text-ink hover:border-gold'

function Room({
  member,
  status,
  isManager,
  isYou,
  action,
  index,
  door,
  today,
  signedOut,
}: {
  member: OfficeMemberWithUser
  status: MapStatus
  isManager: boolean
  isYou: boolean
  action: ReactNode
  index: number
  door: DoorView
  today: string
  /** Mr Tito only (0008): "Signed out 11:42 · idle" when they are out after a stay. */
  signedOut?: string | null
}) {
  const name = member.user?.full_name ?? 'Former member'
  const inRoom = status !== 'offline'
  return (
    <li
      data-lit={inRoom}
      className={cn(
        'office-room room-in flex min-h-[176px] flex-col p-4 sm:p-5',
        // The manager's is the corner office: twice the floor space.
        isManager && 'sm:col-span-2',
      )}
      style={{ ['--room-i' as string]: index }}
    >
      <div className="flex items-center gap-2 text-[11px] font-medium tracking-[0.08em] text-[rgba(246,250,247,0.70)] uppercase">
        {inRoom ? <DoorOpen size={13} strokeWidth={1.75} aria-hidden /> : <DoorClosed size={13} strokeWidth={1.75} aria-hidden />}
        {isManager ? 'Manager’s office' : 'Office'}
        {isYou ? <span className="rounded-[8px] bg-[rgba(255,217,102,0.1)] px-1.5 py-px tracking-normal text-gold normal-case">you</span> : null}
      </div>
      <div className={cn('mt-4 flex items-center gap-3.5', isManager && 'sm:mt-5')}>
        <Avatar name={name} userId={member.user_id} status={status} size={isManager ? 'lg' : 'md'} onFloor />
        <div className="min-w-0">
          <p className={cn('truncate font-medium text-ivory', isManager ? 'text-[16px]' : 'text-[15px]')}>{name}</p>
          <p className="truncate text-[12px] text-[rgba(246,250,247,0.70)]">{member.user ? titleOf(member.user) : ''}</p>
        </div>
      </div>
      <DoorNote view={door} today={today} />
      {signedOut && status === 'offline' ? (
        <p className="tnum mt-2 text-[12px] text-[rgba(246,250,247,0.70)]">{signedOut}</p>
      ) : null}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        <span className="mr-auto">
          <StatusWord status={status} onFloor />
        </span>
        {action}
      </div>
      <span aria-hidden className="office-door" />
    </li>
  )
}

/** "7:42" left on my knock, ticking each second only while it shows. Decoration: the status says "Knocking". */
function KnockClock({ expiresAt }: { expiresAt: string }) {
  const now = useNow(1000).getTime()
  return (
    <span className="tnum" aria-hidden>
      {' '}
      · {countdown(Date.parse(expiresAt), now)}
    </span>
  )
}

/** Knocks on my door today that nobody answered (0005's own rows, read for today). */
function MissedKnocks({ since, zone, nameOf }: { since: string; zone: string; nameOf: (id: string) => string }) {
  const { data: missed } = useMissedKnocks(since, true)
  if (!missed?.length) return null
  return (
    <div className="basis-full text-[13px]">
      <p className="text-text-secondary">
        <span className="font-medium text-text-primary">Missed knocks today ({missed.length})</span>
        <span className="text-text-muted">: </span>
        {missed
          .slice(0, 5)
          .map((k) => `${nameOf(k.from_user)} at ${localParts(zone, new Date(k.created_at)).time}`)
          .join(', ')}
        {missed.length > 5 ? ', …' : ''}
      </p>
    </div>
  )
}

/**
 * What you can do at someone else's door (0005).
 *
 * Focus: the Knock button is replaced by "Knocking" + Cancel when the knock
 * lands, and Cancel by Knock when it is withdrawn. Whichever control the
 * keyboard was on hands focus to its replacement instead of dropping it on
 * <body>. While a knock is being sent the button stays focusable
 * (aria-disabled) rather than disabled, which would also drop focus.
 */
function DoorAction({
  name,
  status,
  away,
  waiting,
  chat,
  onKnock,
  onCancel,
  onOpenChat,
  busy,
}: {
  name: string
  status: MapStatus
  /** They set "back at" or "out until": a knock reaches them by email. */
  away: boolean
  waiting: Knock | undefined
  chat: Knock | undefined
  onKnock: () => void
  onCancel: () => void
  onOpenChat: () => void
  busy: boolean
}) {
  const knockRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const focusNext = useRef<'cancel' | 'knock' | null>(null)
  useEffect(() => {
    const wanted = focusNext.current
    focusNext.current = null
    // Only rescue focus the swap dropped on <body>; if the person has moved on
    // (or the knock failed and they are elsewhere), leave it where it is.
    const dropped = !document.activeElement || document.activeElement === document.body
    if (!dropped) return
    if (waiting && wanted === 'cancel') cancelRef.current?.focus()
    else if (!waiting && wanted === 'knock') knockRef.current?.focus()
  }, [waiting])

  if (chat) {
    return (
      <Button size="sm" variant="ghost" className={cn('bg-gold text-ink hover:bg-ivory hover:text-ink', TOUCH)} onClick={onOpenChat}>
        Open chat
      </Button>
    )
  }
  if (waiting) {
    return (
      <span className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-[12px] text-gold" role="status">
          <span aria-hidden className="size-1.5 rounded-full bg-gold" />
          Knocking{waiting.pinged_at ? ', emailed' : ''}
          <KnockClock expiresAt={waiting.expires_at} />
        </span>
        <Button
          ref={cancelRef}
          size="sm"
          variant="ghost"
          className={cn('text-[rgba(246,250,247,0.82)] hover:bg-[rgba(246,250,247,0.08)] hover:text-ivory', TOUCH)}
          aria-label={`Cancel, stop knocking on ${name}'s door`}
          onClick={() => {
            if (document.activeElement === cancelRef.current) focusNext.current = 'knock'
            onCancel()
          }}
        >
          Cancel
        </Button>
      </span>
    )
  }
  if (status === 'busy') {
    // Focusable, so a keyboard user can reach it and hear why.
    return (
      <Button size="sm" variant="ghost" aria-disabled className={cn(ON_FLOOR, TOUCH, 'cursor-not-allowed opacity-45 hover:border-[rgba(246,250,247,0.22)] hover:bg-[rgba(246,250,247,0.08)] hover:text-ivory')} aria-label={`Knock: ${name} is on do not disturb`}>
        Knock
      </Button>
    )
  }
  const emailed = status === 'offline' || away
  return (
    <Button
      ref={knockRef}
      size="sm"
      variant="ghost"
      className={cn(ON_FLOOR, TOUCH, busy && 'cursor-progress')}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      icon={busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : undefined}
      onClick={() => {
        if (busy) return
        if (document.activeElement === knockRef.current) focusNext.current = 'cancel'
        onKnock()
      }}
      aria-label={emailed ? `Knock on ${name}'s door (they are out; they get an email)` : `Knock on ${name}'s door`}
      title={emailed ? 'They are out. They get an email.' : undefined}
    >
      Knock
    </Button>
  )
}

function YourStatus({
  name,
  door,
  today,
  nowTime,
  doorsReady,
  reasons,
  dayStart,
  zone,
  nameOf,
}: {
  name: string
  door: DoorView
  today: string
  nowTime: string
  doorsReady: boolean
  /** 0010: reasons beside "back at". */
  reasons: boolean
  /** The office day's first instant, for today's missed knocks. */
  dayStart: string
  zone: string
  nameOf: (id: string) => string
}) {
  const gate = usePresence((s) => s.gate)
  const mine = usePresence((s) => s.mine)
  const userId = useAuthStore((s) => s.profile?.id)
  const { data: photos } = usePhotos()
  const [photoOpen, setPhotoOpen] = useState(false)

  if (gate === 'needs_signin') {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-[14px] border border-[var(--tint-accent-line)] bg-tint-accent px-4 py-3.5 sm:px-5">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-gold">
          <DoorClosed size={18} strokeWidth={1.75} />
        </span>
        <div className="mr-auto min-w-0">
          <p className="text-[14px] font-medium text-text-primary">Your door is shut</p>
          <p className="text-[13px] text-text-secondary">File your sign-in to enter the office. Until then you show as out.</p>
        </div>
        <Link to="/reports" tabIndex={-1}>
          <Button size="sm" className={TOUCH}>
            File sign-in
          </Button>
        </Link>
      </div>
    )
  }
  if (gate === 'signed_out') return <SignedOutCard />
  if (gate !== 'in') return null
  return (
    <div className="hairline flex flex-wrap items-center gap-3 rounded-[14px] bg-surface-raised px-4 py-3 shadow-[var(--shadow-sm)] sm:px-5">
      <Avatar name={name} userId={userId} status={mine ?? undefined} size="sm" />
      <div className="mr-auto flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium text-text-primary">Your desk</span>
      </div>
      {/* Available, working elsewhere, do not disturb (boxed), or sign out. */}
      <StatusMenu />
      {/* Only once 0007 is in: until then there is nowhere to keep a photo. */}
      {photos?.available && userId ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            icon={<Camera size={14} strokeWidth={1.75} />}
            className={TOUCH}
            onClick={() => setPhotoOpen(true)}
          >
            {photos.paths[userId] ? 'Photo' : 'Add photo'}
          </Button>
          <PhotoEditor userId={userId} name={name} open={photoOpen} onOpenChange={setPhotoOpen} />
        </>
      ) : null}
      {doorsReady ? <DeskEditor view={door} today={today} nowTime={nowTime} reasons={reasons} /> : null}
      <MissedKnocks since={dayStart} zone={zone} nameOf={nameOf} />
    </div>
  )
}

export function Office() {
  const profile = useAuthStore((s) => s.profile)
  const { data: settings } = useOfficeSettings()
  const { data: members, isLoading, isError, error } = useOfficeMembers()
  const role = useOfficeRole()
  const present = usePresence((s) => s.present)
  const seen = usePresence((s) => s.seen)
  const mine = usePresence((s) => s.mine)
  const gate = usePresence((s) => s.gate)
  const { data: knocks } = useMyKnocks(gate === 'in')
  const knock = useKnock()
  const cancel = useCancelKnock()
  const showToast = useToastStore((s) => s.showToast)
  const [params, setParams] = useSearchParams()
  const chatId = params.get('chat')
  // A ?chat= that is not one of your accepted knocks goes away once known.
  useEffect(() => {
    if (chatId && knocks && !knocks.some((k) => k.id === chatId && k.status === 'accepted')) {
      setParams({}, { replace: true })
    }
  }, [chatId, knocks, setParams])
  // Re-draws for the offline grace period, which is time-based.
  const now = useNow(15_000).getTime()
  const zone = settings?.timezone ?? 'Africa/Lagos'
  const clock = localParts(zone, new Date(now))
  const weekday = new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: zone })
  // 0006: doors. Hidden until the migration is in.
  const inOffice = gate === 'in' && role.isMember
  const { data: statuses } = useOfficeStatuses(inOffice)
  useOfficeStatusRealtime(inOffice && !!statuses?.available)
  const dayStart = wallTimeToInstant(clock.date, '00:00', zone).instant.toISOString()
  // 0008: who has signed out today, for Mr Tito's and HR's doors (RLS gives others only their own).
  const { data: entries } = useEntries(clock.date, inOffice && role.seesTeam)

  if (isLoading || role.loading) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <Skeleton className="h-[52px]" />
        <div className="grid gap-px sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className={cn('h-[176px]', i === 0 && 'sm:col-span-2')} />
          ))}
        </div>
      </div>
    )
  }
  if (isError || role.isError) {
    return <EmptyState title="Could not load the office" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
  }
  if (!role.isMember) {
    return (
      <EmptyState
        icon={<Users size={22} strokeWidth={1.5} />}
        title="You are not in the office"
        body="The office is for Mr Tito's team. Ask him to add you."
      />
    )
  }

  const active = (members ?? []).filter((m) => m.active && !m.user?.deactivated_at)
  // The manager's office first, then everyone else by name.
  const rooms = [...active].sort((a, b) =>
    a.user_id === settings?.manager_id ? -1 : b.user_id === settings?.manager_id ? 1 : 0,
  )
  const statusOf = (id: string): MapStatus =>
    // Your own room reads from this tab, which knows before the channel echoes.
    id === profile?.id && mine ? mine : mapStatus(present[id] ?? null, seen[id], now)
  const inCount = rooms.filter((m) => statusOf(m.user_id) !== 'offline').length
  const me = profile?.id
  const between = (k: Knock, other: string) =>
    (k.from_user === me && k.to_user === other) || (k.to_user === me && k.from_user === other)
  // Only a knock that was let in has a chat; anything else in ?chat= is dropped.
  const chatKnock = knocks?.find((k) => k.id === chatId && k.status === 'accepted')
  const chatWith = chatKnock ? (chatKnock.from_user === me ? chatKnock.to_user : chatKnock.from_user) : null
  const nameOf = (id: string) => rooms.find((m) => m.user_id === id)?.user?.full_name ?? 'Someone'
  const today = { date: clock.date, time: clock.time }
  const doorOf = (id: string): DoorView =>
    statuses?.available ? doorView(statuses.rows.find((r) => r.user_id === id), today) : EMPTY_DOOR
  const signedOutOf = (id: string): string | null => {
    const last: OfficeEntry | undefined = (entries?.rows ?? []).filter((e) => e.user_id === id).at(-1)
    if (!last?.left_at || !last.left_reason) return null
    return `Signed out ${localParts(zone, new Date(last.left_at)).time} · ${LEFT_SHORT[last.left_reason]}`
  }
  const doorFor = (m: OfficeMemberWithUser) => {
    if (m.user_id === me) return null
    const status = statusOf(m.user_id)
    const name = m.user?.full_name ?? 'this person'
    const away = steppedOut(doorOf(m.user_id))
    return (
      <DoorAction
        name={name}
        status={status}
        away={away}
        waiting={knocks?.find((k) => k.from_user === me && k.to_user === m.user_id && isWaiting(k, now))}
        chat={knocks?.find((k) => between(k, m.user_id) && isChatOpen(k, now))}
        busy={knock.isPending && knock.variables?.to === m.user_id}
        onKnock={() =>
          knock.mutate(
            { to: m.user_id, offline: status === 'offline' || away },
            { onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error') },
          )
        }
        onCancel={() => {
          const k = knocks?.find((x) => x.from_user === me && x.to_user === m.user_id && isWaiting(x, now))
          if (k) cancel.mutate(k.id)
        }}
        onOpenChat={() => {
          const k = knocks?.find((x) => between(x, m.user_id) && isChatOpen(x, now))
          if (k) setParams({ chat: k.id })
        }}
      />
    )
  }

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 flex flex-wrap items-end gap-x-4 gap-y-1 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <div className="mr-auto min-w-0">
          <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">The office</h1>
          <p className="tnum mt-1.5 text-[12px] text-text-muted">
            {weekday} · {clock.time} office time
          </p>
        </div>
        {gate === 'in' ? (
          <p className="flex items-center gap-2 pb-0.5 text-[13px] text-text-secondary" role="status">
            <span aria-hidden className="size-2 rounded-full bg-state-success" />
            <span className="tnum">
              {inCount} of {rooms.length} in
            </span>
          </p>
        ) : null}
      </div>
      <div className="space-y-4 p-4 sm:p-6">
        <YourStatus
          name={profile?.full_name ?? 'You'}
          door={me ? doorOf(me) : EMPTY_DOOR}
          today={clock.date}
          nowTime={clock.time}
          doorsReady={!!statuses?.available}
          reasons={!!statuses?.reasons}
          dayStart={dayStart}
          zone={zone}
          nameOf={nameOf}
        />
        {gate === 'in' ? <ReturnPrompt /> : null}
        {gate === 'in' && !role.isManager ? <Onboarding /> : null}
        {/* Outside the office you are not on the channel, so you cannot
            know who is in; showing everyone as out would be false. */}
        {gate === 'in' ? (
          <div className={cn('grid items-start gap-4', chatKnock && 'lg:grid-cols-[minmax(0,1fr)_380px]')}>
            <ul
              aria-label="Offices"
              className={cn('office-floor grid min-w-0 gap-px sm:grid-cols-2', chatKnock ? 'xl:grid-cols-3' : 'xl:grid-cols-4')}
            >
              {rooms.map((m, i) => (
                <Room
                  key={m.user_id}
                  index={i}
                  member={m}
                  status={statusOf(m.user_id)}
                  isManager={m.user_id === settings?.manager_id}
                  isYou={m.user_id === profile?.id}
                  action={doorFor(m)}
                  door={doorOf(m.user_id)}
                  today={clock.date}
                  signedOut={role.seesTeam ? signedOutOf(m.user_id) : null}
                />
              ))}
            </ul>
            {chatKnock && chatWith ? (
              <ChatPanel
                knock={chatKnock}
                otherName={nameOf(chatWith)}
                zone={settings?.timezone ?? 'Africa/Lagos'}
                onClose={() => setParams({})}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
