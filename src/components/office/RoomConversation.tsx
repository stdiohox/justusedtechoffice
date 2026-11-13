import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Lock, Send, UserPlus } from 'lucide-react'
import { Button, FieldError, Skeleton } from '@/components/ui/primitives'
import { Photo } from '@/components/ui/Photo'
import { useOfficeMembers, useOfficeSettings } from '@/hooks/useOffice'
import { useNow } from '@/hooks/useNow'
import { useEnterRoom, useInviteToRoom, useOccupants, usePostRoomMessage, useRoomCode, useRoomInvites, useRoomMessages, useTouchRoom, type Room } from '@/hooks/useExtras'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { consumeEnteredRoom } from '@/lib/roomFocus'
import { localParts } from '@/lib/timezones'
import { firstName, initials } from '@/lib/utils'

/** "Still here" every two minutes; the server sweeps anyone unseen for ten. */
const TOUCH_EVERY_MS = 2 * 60_000

/**
 * Being in a room (0021): the conversation so far, who else is here, and asking
 * someone in. Readable only from inside, by RLS, not by this component.
 */
export function RoomConversation({ room, onLeft }: { room: Room; onLeft?: () => void }) {
  const id = useId()
  const me = useAuthStore((s) => s.profile?.id) ?? ''
  const { data: messages, isLoading, isError } = useRoomMessages(room.id)
  const { data: members } = useOfficeMembers()
  const { data: occupants } = useOccupants()
  const { data: invites } = useRoomInvites()
  const { data: settings } = useOfficeSettings()
  const post = usePostRoomMessage()
  const invite = useInviteToRoom()
  const leave = useEnterRoom()
  const touch = useTouchRoom()
  const { data: door } = useRoomCode(room.id)
  const showToast = useToastStore((s) => s.showToast)
  const now = useNow(15_000).getTime()
  const zone = settings?.timezone ?? 'Africa/Lagos'
  const [body, setBody] = useState('')
  const [picking, setPicking] = useState(false)
  const log = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const atBottom = useRef(true)

  const names = useMemo(() => new Map((members ?? []).map((m) => [m.user_id, m.user?.full_name ?? 'Someone'])), [members])
  const nameOf = (uid: string) => names.get(uid) ?? 'Someone'
  const inside = (occupants ?? []).filter((o) => o.room_id === room.id).map((o) => o.user_id)
  const others = (members ?? []).filter((m) => m.active && !inside.includes(m.user_id))
  const sent = (invites ?? []).filter((i) => i.from_user === me && i.room_id === room.id)
  /** The latest answer from this person, while it still means something. */
  const answer = (uid: string) => {
    const latest = sent.find((i) => i.to_user === uid)
    if (!latest) return null
    if (new Date(latest.expires_at).getTime() <= now) return null
    return latest.status === 'declined' ? 'Said not now' : latest.status === 'pending' ? 'Invited' : null
  }

  const newest = messages?.at(-1)?.id
  useEffect(() => {
    // Only the log moves: scrolling into view would also move the page under someone reading.
    if (atBottom.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [newest])

  // Just stepped in, or joined from an invite: focus lands here, not back at the
  // top. Reloading while already inside leaves focus and scroll where they were.
  useEffect(() => {
    if (consumeEnteredRoom()) heading.current?.focus({ preventScroll: true })
  }, [])

  // "Still here" while the room is on screen.
  const touchNow = touch.mutate
  useEffect(() => {
    const t = setInterval(() => touchNow(undefined), TOUCH_EVERY_MS)
    return () => clearInterval(t)
  }, [touchNow])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    if (!text) return
    setBody('')
    atBottom.current = true
    post.mutate({ room_id: room.id, body: text, sender: me }, { onError: () => setBody((typed) => typed || text) })
  }

  return (
    <section aria-labelledby={`${id}-h`} className="hairline grid min-w-0 overflow-hidden rounded-[14px] bg-surface-raised lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex h-[min(440px,70dvh)] min-h-[280px] min-w-0 flex-col">
        <div className="hairline-b flex flex-wrap items-center gap-x-3 gap-y-1 bg-surface-sunken/60 px-4 py-3">
          <h2 ref={heading} tabIndex={-1} id={`${id}-h`} className="mr-auto text-[15px] font-bold text-text-primary outline-none">
            You are in the {room.name}
          </h2>
          <p className="inline-flex items-center gap-1 text-[12px] text-text-muted">
            <Lock size={12} aria-hidden /> Only people in this room can read this. Deleted when the last person leaves.
          </p>
        </div>
        <div
          ref={log}
          role="log"
          tabIndex={0}
          aria-label={`Conversation in the ${room.name}`}
          aria-busy={isLoading}
          onScroll={(e) => {
            const el = e.currentTarget
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
          className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
        >
          {isLoading ? <Skeleton className="h-24" /> : null}
          {isError ? <p className="text-[13px] text-state-danger">Could not load the conversation.</p> : null}
          {!isLoading && !isError && !messages?.length ? <p className="text-[13px] text-text-muted">Nothing said yet. Say hello, or invite someone in.</p> : null}
          {messages?.map((m) => (
            <div key={m.id} className="row-in flex gap-2.5">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-surface">
                <Photo userId={m.sender} className="size-8">
                  {initials(nameOf(m.sender))}
                </Photo>
              </span>
              <div className="min-w-0">
                <p className="text-[13px]">
                  <span className="font-bold text-text-primary">{m.sender === me ? 'You' : firstName(nameOf(m.sender))}</span>{' '}
                  <span className="tnum text-[12px] text-text-muted">{localParts(zone, new Date(m.created_at)).time}</span>
                </p>
                <p className="text-[14px] leading-snug break-words whitespace-pre-wrap text-text-secondary">{m.body}</p>
              </div>
            </div>
          ))}
        </div>
        <form onSubmit={submit} className="hairline-t p-3">
          <div className="flex gap-2">
            <label htmlFor={`${id}-msg`} className="sr-only">
              Message the room
            </label>
            <input
              id={`${id}-msg`}
              value={body}
              maxLength={1000}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Say something to the room"
              className="hairline h-10 min-w-0 flex-1 rounded-full bg-surface px-4 text-[14px] text-text-primary max-sm:h-11"
            />
            <Button type="submit" icon={<Send size={15} aria-hidden />} className="h-10 max-sm:h-11">
              Send
            </Button>
          </div>
          {post.error ? <FieldError>{post.error.message}</FieldError> : null}
        </form>
      </div>

      <aside aria-label="People" className="hairline-t flex max-h-[min(440px,70dvh)] min-w-0 flex-col lg:border-l lg:border-t-0 lg:border-line">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mb-4 rounded-[10px] bg-surface-sunken p-3">
            <p className="text-[12px] font-semibold text-text-secondary">Room code</p>
            {door?.code ? (
              <p className="tnum mt-0.5 text-[22px] leading-none font-extrabold tracking-[0.15em] text-text-primary">{door.code}</p>
            ) : (
              <p className="mt-0.5 text-[13px] text-text-muted">Loading the code</p>
            )}
            <p className="mt-1.5 text-[12px] leading-snug text-text-muted">Anyone else needs this or an invite to come in. It changes when the room empties.</p>
          </div>
          <h3 className="text-[13px] font-bold text-text-primary">In the room ({inside.length})</h3>
          <ul className="mt-2 space-y-1.5">
            {inside.map((uid) => (
              <li key={uid} className="flex items-center gap-2 text-[13px] text-text-secondary">
                <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-[9px] font-bold text-surface">
                  <Photo userId={uid} className="size-6">
                    {initials(nameOf(uid))}
                  </Photo>
                </span>
                <span className="truncate">{uid === me ? 'You' : nameOf(uid)}</span>
              </li>
            ))}
          </ul>
          <Button variant="secondary" size="sm" className="mt-3 max-sm:h-11" aria-expanded={picking} icon={<UserPlus size={14} aria-hidden />} onClick={() => setPicking((v) => !v)}>
            Invite someone
          </Button>
          {picking ? (
            <ul className="mt-2 space-y-1">
              <li className="text-[12px] text-text-muted">They get a pop-up in the office and an email, and need no code.</li>
              {others.map((m) => {
                const said = answer(m.user_id)
                const who = m.user?.full_name ?? 'Someone'
                return (
                  <li key={m.user_id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{who}</span>
                    {said && said !== 'Invited' ? <span className="text-[12px] text-text-muted">{said}</span> : null}
                    {/* Stays a button once pressed, so focus is not dropped. */}
                    <button
                      type="button"
                      aria-label={said === 'Invited' ? `${who} invited` : `Invite ${who}`}
                      aria-disabled={said === 'Invited' || undefined}
                      onClick={() => {
                        if (said === 'Invited') return
                        invite.mutate(m.user_id, {
                          onSuccess: () => showToast(`Invite sent to ${firstName(who)}`, 'success'),
                          onError: (e) => showToast(e.message, 'error'),
                        })
                      }}
                      className={
                        said === 'Invited'
                          ? 'rounded-full px-2.5 py-1 text-[12px] font-semibold text-state-success max-sm:min-h-11'
                          : 'press hairline rounded-full bg-surface px-2.5 py-1 text-[12px] font-semibold text-text-primary hover:bg-surface-sunken max-sm:min-h-11'
                      }
                    >
                      {said === 'Invited' ? 'Invited' : 'Invite'}
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
        <div className="hairline-t p-3">
          <Button
            variant="secondary"
            className="w-full max-sm:h-11"
            loading={leave.isPending}
            onClick={() => {
              onLeft?.()
              leave.mutate({ room: null }, { onError: (e) => showToast(e.message, 'error') })
            }}
          >
            Step out
          </Button>
        </div>
      </aside>
    </section>
  )
}
