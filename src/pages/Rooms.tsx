import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { DoorOpen, Lock, Users } from 'lucide-react'
import { Button, EmptyState, FieldError, Input, Label, Select, Skeleton } from '@/components/ui/primitives'
import { Photo } from '@/components/ui/Photo'
import { RoomConversation } from '@/components/office/RoomConversation'
import { ExtrasOff } from '@/components/office/ExtrasOff'
import { useOfficeMembers, useOfficeSettings } from '@/hooks/useOffice'
import { useNow } from '@/hooks/useNow'
import { useToastStore } from '@/stores/toastStore'
import { useBookRoom, useBookings, useCancelBooking, useEnterRoom, useExtrasAvailable, useOccupants, useRooms } from '@/hooks/useExtras'
import { useAuthStore } from '@/stores/authStore'
import { markEnteredRoom } from '@/lib/roomFocus'
import { localParts, wallTimeToInstant } from '@/lib/timezones'
import { firstName, initials } from '@/lib/utils'

/**
 * Meeting rooms (0021). Book a slot, and two bookings never overlap. Step into a
 * room and the team sees you are in it; a room in use needs its code or an
 * invite, and what is said inside is readable only from inside (the database
 * decides both). Rooms are text conversations: there is no video here.
 */
export function Rooms() {
  const id = useId()
  const profile = useAuthStore((s) => s.profile)
  const me = profile?.id ?? ''
  const { data: settings } = useOfficeSettings()
  const zone = settings?.timezone ?? 'Africa/Lagos'
  const clockNow = useNow(15_000)
  const showToast = useToastStore((s) => s.showToast)
  const { date: today, time: nowTime } = localParts(zone, clockNow)
  const startOfDay = wallTimeToInstant(today, '00:00', zone).instant.toISOString()
  const on = useExtrasAvailable()
  const { data: rooms, isLoading } = useRooms()
  const { data: bookings } = useBookings(startOfDay)
  const { data: occupants } = useOccupants()
  const { data: members } = useOfficeMembers()
  const book = useBookRoom()
  const cancel = useCancelBooking()
  const enter = useEnterRoom()
  const [room, setRoom] = useState('')
  const [title, setTitle] = useState('')
  const [day, setDay] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  // The room whose door is asking for a code.
  const [asking, setAsking] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codeProblem, setCodeProblem] = useState<string | null>(null)
  const pending = on === undefined || isLoading

  const names = useMemo(() => new Map((members ?? []).map((m) => [m.user_id, m.user?.full_name ?? 'Someone'])), [members])
  const nameOf = (uid: string) => names.get(uid) ?? 'Someone'
  const time = (iso: string) => localParts(zone, new Date(iso)).time
  const dayLabel = (iso: string) => {
    const d = localParts(zone, new Date(iso)).date
    return d === today ? 'Today' : new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: zone })
  }
  const now = clockNow.getTime()
  const myRoom = occupants?.find((o) => o.user_id === me)?.room_id ?? null
  const isAdmin = profile?.role === 'manager' || profile?.role === 'hr'
  const roomName = (rid: string | null) => rooms?.find((r) => r.id === rid)?.name
  // Per room: the booking on now, and the next one. Once per render, not per card.
  const slots = useMemo(() => {
    const out = new Map<string, { current?: { title: string; ends_at: string }; next?: { title: string; starts_at: string } }>()
    for (const b of bookings ?? []) {
      const s = new Date(b.starts_at).getTime()
      const e = new Date(b.ends_at).getTime()
      const slot = out.get(b.room_id) ?? {}
      if (s <= now && e > now && !slot.current) slot.current = b
      else if (s > now && !slot.next) slot.next = b
      out.set(b.room_id, slot)
    }
    return out
  }, [bookings, now])
  const pageTitle = useRef<HTMLHeadingElement>(null)
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const wasIn = useRef<string | null>(null)
  /** Set when this person pressed Step out, so only their own exit moves focus. */
  const leftByMe = useRef(false)
  const [said, setSaid] = useState('')
  useEffect(() => {
    if (myRoom === wasIn.current) return
    if (myRoom) setSaid(`You are in the ${roomName(myRoom) ?? 'room'}.`)
    else {
      setSaid(`You left the ${roomName(wasIn.current) ?? 'room'}.`)
      // The button that was pressed has gone with the panel. A refetch, or an
      // exit from another device, leaves focus where it is.
      if (leftByMe.current) pageTitle.current?.focus({ preventScroll: true })
    }
    leftByMe.current = false
    wasIn.current = myRoom
    // `rooms` is read for the name only: a refetch of rooms must not re-announce the move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myRoom])

  const tryDoor = (roomId: string, given?: string) => {
    setCodeProblem(null)
    enter.mutate(
      { room: roomId, code: given },
      {
        onSuccess: (answer) => {
          if (answer === 'in') {
            markEnteredRoom()
            setAsking(null)
            setCode('')
          } else {
            setAsking(roomId)
            setCode('')
            if (answer === 'wrong_code') setCodeProblem('That code is not right. Check it and try again.')
            if (answer === 'locked') setCodeProblem('Too many wrong tries. Wait 10 minutes, or ask someone inside to invite you.')
          }
        },
        onError: (e) => setCodeProblem(e.message),
      },
    )
  }
  const stepOut = () => {
    leftByMe.current = true
    enter.mutate({ room: null }, { onError: (e) => showToast(e.message, 'error') })
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const useRoom = room || rooms?.[0]?.id
    const useDay = day || today
    if (!useRoom || !title.trim() || !start || !end) return setProblem('Give it a title, a start and an end.')
    setProblem(null)
    book.mutate(
      { room: useRoom, title: title.trim(), start: wallTimeToInstant(useDay, start, zone).instant.toISOString(), end: wallTimeToInstant(useDay, end, zone).instant.toISOString() },
      {
        onSuccess: () => {
          setTitle('')
          setStart('')
          setEnd('')
          showToast('Booked', 'success')
        },
        onError: (err) => setProblem(err.message),
      },
    )
  }

  if (on === false) return <ExtrasOff icon={<DoorOpen size={22} strokeWidth={1.5} />} what="Rooms" />

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <h1 ref={pageTitle} tabIndex={-1} className="font-display text-[28px] leading-none font-medium text-text-primary outline-none">Rooms</h1>
        <p role="status" className="sr-only">
          {said}
        </p>
        <p className="mt-1.5 text-[13px] text-text-muted">It is {nowTime} at the office. Book a room, or step into one. A room in use needs its code or an invite.</p>
      </div>
      <div className="mx-auto max-w-[1100px] space-y-5 p-4 sm:p-6">
        {pending ? <Skeleton className="h-44" /> : null}
        {!pending && !rooms?.length ? <EmptyState title="No rooms yet" body="Rooms appear here once they are set up." /> : null}
        <div className="grid gap-4 md:grid-cols-3">
          {rooms?.map((r) => {
            const inside = occupants?.filter((o) => o.room_id === r.id) ?? []
            const { current, next } = slots.get(r.id) ?? {}
            const here = myRoom === r.id
            return (
              <section
                key={r.id}
                ref={(el) => {
                  if (el) sectionRefs.current.set(r.id, el)
                  else sectionRefs.current.delete(r.id)
                }}
                tabIndex={-1}
                aria-labelledby={`${id}-room-${r.id}`}
                className="on-dark flex min-w-0 flex-col rounded-[14px] bg-[#08462a] p-4 text-ivory outline-none"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h2 id={`${id}-room-${r.id}`} className="text-[17px] font-extrabold">{r.name}</h2>
                  <span className="tnum inline-flex items-center gap-1 text-[12px] opacity-80">
                    <Users size={12} aria-hidden /> <span aria-hidden>{inside.length}/{r.capacity}</span>
                    <span className="sr-only">{inside.length} of {r.capacity} seats taken</span>
                  </span>
                </div>
                <p className="text-[12px] opacity-75">{r.purpose}</p>
                <p className="mt-3 min-h-10 text-[13px]">
                  {current ? (
                    <>
                      <span className="font-bold text-gold">In use:</span> {current.title}, until {time(current.ends_at)}
                    </>
                  ) : next ? (
                    <>
                      <span className="font-bold">Free.</span> Next: {next.title}, {dayLabel(next.starts_at)} {time(next.starts_at)}
                    </>
                  ) : (
                    <span className="font-bold">Free</span>
                  )}
                </p>
                <ul aria-label={`In the ${r.name}`} className="mt-3 flex min-h-9 items-center gap-1">
                  {inside.map((o) => (
                    <li key={o.user_id} title={nameOf(o.user_id)} className="flex size-8 items-center justify-center rounded-full bg-[var(--on-dark-fill)] text-[11px] font-bold text-white">
                      <span className="sr-only">{nameOf(o.user_id)}</span>
                      <span aria-hidden>
                        <Photo userId={o.user_id} className="size-8">
                          {initials(nameOf(o.user_id))}
                        </Photo>
                      </span>
                    </li>
                  ))}
                  {!inside.length ? <li className="text-[12px] opacity-70">Nobody inside</li> : null}
                </ul>
                {asking === r.id && !here ? (
                  <form
                    className="mt-3"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (code.trim()) tryDoor(r.id, code.trim())
                    }}
                  >
                    <label htmlFor={`${id}-code-${r.id}`} className="text-[12px] font-semibold">
                      Enter the room code
                    </label>
                    <div className="mt-1 flex gap-2">
                      <input
                        id={`${id}-code-${r.id}`}
                        autoFocus
                        value={code}
                        inputMode="numeric"
                        autoComplete="off"
                        maxLength={6}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                        aria-invalid={codeProblem ? true : undefined}
                        aria-describedby={codeProblem ? `${id}-code-err` : undefined}
                        className="tnum h-9 w-0 min-w-0 flex-1 rounded-full border border-[rgba(246,250,247,0.55)] bg-transparent px-3 text-[14px] tracking-[0.2em] text-ivory max-sm:h-11"
                      />
                      <button type="submit" aria-disabled={enter.isPending || undefined} className="press h-9 rounded-full bg-gold px-4 text-[13px] font-bold text-ink max-sm:h-11">
                        Enter
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAsking(null)
                          setCodeProblem(null)
                          // The form goes; focus stays with the room.
                          sectionRefs.current.get(r.id)?.focus({ preventScroll: true })
                        }}
                        className="press h-9 rounded-full border border-[rgba(246,250,247,0.55)] px-3 text-[13px] font-semibold max-sm:h-11"
                      >
                        Cancel
                      </button>
                    </div>
                    {codeProblem ? (
                      <p id={`${id}-code-err`} role="alert" className="mt-1.5 text-[12px] leading-snug text-gold">
                        {codeProblem}
                      </p>
                    ) : null}
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (here) stepOut()
                      else tryDoor(r.id)
                    }}
                    className="press mt-3 inline-flex h-9 items-center justify-center gap-1.5 rounded-full border border-[rgba(246,250,247,0.28)] text-[13px] font-semibold hover:bg-[rgba(246,250,247,0.08)] max-sm:h-11"
                  >
                    {!here && inside.length ? <Lock size={13} aria-hidden /> : null}
                    {here ? 'Step out' : inside.length ? 'Step in with a code' : 'Step in'}
                    <span className="sr-only"> of the {r.name}</span>
                  </button>
                )}
              </section>
            )
          })}
        </div>
        {myRoom && rooms?.find((r) => r.id === myRoom) ? (
          <RoomConversation key={myRoom} room={rooms.find((r) => r.id === myRoom)!} onLeft={() => (leftByMe.current = true)} />
        ) : null}

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
          <section aria-labelledby={`${id}-sched`} className="min-w-0">
            <h2 id={`${id}-sched`} className="mb-2 text-[15px] font-bold text-text-primary">
              Bookings
            </h2>
            {!bookings?.length ? <p className="text-[13px] text-text-muted">{pending ? 'Loading the bookings.' : 'Nothing booked.'}</p> : null}
            <ul className="space-y-2">
              {bookings?.map((b) => (
                <li key={b.id} className="hairline flex flex-wrap items-center gap-3 rounded-[14px] bg-surface-raised p-3">
                  <span className="tnum w-[92px] shrink-0 text-[13px] font-semibold text-text-primary">
                    {time(b.starts_at)} to {time(b.ends_at)}
                  </span>
                  <div className="mr-auto min-w-0">
                    <p className="text-[14px] font-semibold text-text-primary">{b.title}</p>
                    <p className="text-[12px] text-text-muted">
                      {roomName(b.room_id)}, {dayLabel(b.starts_at)}, booked by {firstName(nameOf(b.booked_by))}
                    </p>
                  </div>
                  {b.booked_by === me || isAdmin ? (
                    <Button
                      size="sm"
                      className="max-sm:h-11"
                      variant="ghost"
                      aria-label={`Cancel ${b.title}, ${dayLabel(b.starts_at)} ${time(b.starts_at)}`}
                      onClick={() => cancel.mutate(b.id, { onError: (e) => showToast(e.message, 'error') })}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
          <form onSubmit={submit} className="hairline h-fit space-y-3 rounded-[14px] bg-surface-raised p-4" noValidate>
            <h2 className="text-[15px] font-bold text-text-primary">Book a room</h2>
            <div>
              <Label htmlFor={`${id}-room`}>Room</Label>
              <Select id={`${id}-room`} value={room} onChange={(e) => setRoom(e.target.value)}>
                {rooms?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} (seats {r.capacity})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor={`${id}-title`}>What is it for?</Label>
              <Input id={`${id}-title`} maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <Label htmlFor={`${id}-day`}>Day</Label>
              <Input id={`${id}-day`} type="date" min={today} value={day || today} onChange={(e) => setDay(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor={`${id}-start`}>Starts</Label>
                <Input id={`${id}-start`} type="time" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div>
                <Label htmlFor={`${id}-end`}>Ends</Label>
                <Input id={`${id}-end`} type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <FieldError>{problem}</FieldError>
            <Button type="submit" loading={book.isPending} className="w-full">
              Book it
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
