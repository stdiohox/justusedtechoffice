import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { MessagesSquare, Send } from 'lucide-react'
import { Button, EmptyState, FieldError, Skeleton } from '@/components/ui/primitives'
import { Photo } from '@/components/ui/Photo'
import { ExtrasOff } from '@/components/office/ExtrasOff'
import { useOfficeMembers, useOfficeSettings } from '@/hooks/useOffice'
import { useNow } from '@/hooks/useNow'
import { useChannel, useExtrasAvailable, usePostMessage, type Channel } from '@/hooks/useExtras'
import { useAuthStore } from '@/stores/authStore'
import { localParts } from '@/lib/timezones'
import { cn, firstName, initials } from '@/lib/utils'

/** Team chat (0021): open channels everyone reads. A knock's chat stays between two people. */
const CHANNELS: { id: Channel; label: string; about: string }[] = [
  { id: 'general', label: 'General', about: 'Day-to-day news for everyone.' },
  { id: 'wins', label: 'Wins', about: 'Good news worth sharing.' },
  { id: 'help', label: 'Ask for help', about: 'Stuck? Someone here knows.' },
]

export function TeamChat() {
  const id = useId()
  const me = useAuthStore((s) => s.profile?.id) ?? ''
  const [channel, setChannel] = useState<Channel>('general')
  const on = useExtrasAvailable()
  const { data, isLoading, isError } = useChannel(channel)
  const { data: members } = useOfficeMembers()
  const { data: settings } = useOfficeSettings()
  const post = usePostMessage()
  const [body, setBody] = useState('')
  const log = useRef<HTMLDivElement>(null)
  /** Reading older messages: a new one must not pull you away. */
  const atBottom = useRef(true)
  const zone = settings?.timezone ?? 'Africa/Lagos'
  const messages = useMemo(() => [...(data ?? [])].reverse(), [data])
  const names = useMemo(() => new Map((members ?? []).map((m) => [m.user_id, m.user?.full_name ?? 'Someone'])), [members])
  const nameOf = (uid: string) => names.get(uid) ?? 'Someone'
  const today = localParts(zone, useNow()).date
  const when = (iso: string) => {
    const p = localParts(zone, new Date(iso))
    return p.date === today ? p.time : `${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: zone })}, ${p.time}`
  }
  // Unknown whether 0021 is in, or the first rows are on their way: not yet "nothing here".
  const pending = on === undefined || isLoading
  const current = CHANNELS.find((c) => c.id === channel)

  const newest = data?.[0]?.id
  useEffect(() => {
    // Only the log moves: scrolling into view would also move the page under someone reading.
    if (atBottom.current && log.current) log.current.scrollTop = log.current.scrollHeight
  }, [newest, channel])

  const pickChannel = (next: Channel) => {
    // A draft belongs to the channel it was typed for.
    setBody('')
    atBottom.current = true
    setChannel(next)
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = body.trim()
    if (!text) return
    setBody('')
    atBottom.current = true
    const sentIn = channel
    post.mutate({ channel: sentIn, body: text, sender: me }, { onError: () => setBody((typed) => (channel === sentIn ? typed || text : typed)) })
  }

  if (on === false) return <ExtrasOff icon={<MessagesSquare size={22} strokeWidth={1.5} />} what="Team chat" />

  return (
    <div className="office-page flex h-full min-h-0 flex-col">
      <div className="hairline-b flex flex-wrap items-end gap-3 px-4 pt-4 pb-3 sm:px-6">
        <div className="mr-auto">
          <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">Team chat</h1>
          <p className="mt-1.5 text-[13px] text-text-muted">{current?.about}</p>
        </div>
        <div role="group" aria-label="Channel" className="flex flex-wrap gap-1">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={channel === c.id}
              onClick={() => pickChannel(c.id)}
              className={cn(
                'press rounded-full px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 max-sm:py-2.5',
                channel === c.id ? 'bg-forest text-ivory' : 'hairline bg-surface-raised text-text-secondary hover:bg-surface-sunken',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div
        // A new element per channel, so switching does not read the whole channel aloud.
        key={channel}
        ref={log}
        role="log"
        tabIndex={0}
        aria-label={`Messages in ${current?.label}`}
        aria-busy={pending}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6"
      >
        <div className="mx-auto max-w-[760px] space-y-3">
          {pending ? <Skeleton className="h-40" /> : null}
          {isError ? <EmptyState title="Could not load the chat" body="Try again in a moment." /> : null}
          {!pending && !isError && !messages.length ? <EmptyState icon={<MessagesSquare size={22} strokeWidth={1.5} />} title="Nothing here yet" body="Say something to the team." /> : null}
          {messages.map((m) => (
            <div key={m.id} className="row-in flex gap-2.5">
              <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-surface">
                <Photo userId={m.sender} className="size-8">
                  {initials(nameOf(m.sender))}
                </Photo>
              </span>
              <div className="min-w-0">
                <p className="text-[13px]">
                  <span className="font-bold text-text-primary">{m.sender === me ? 'You' : firstName(nameOf(m.sender))}</span>{' '}
                  <span className="tnum text-[12px] text-text-muted">{when(m.created_at)}</span>
                </p>
                <p className="text-[14px] leading-snug break-words whitespace-pre-wrap text-text-secondary">{m.body}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
      <form onSubmit={submit} className="hairline-t bg-surface-raised px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[760px] gap-2">
          <label htmlFor={`${id}-msg`} className="sr-only">
            Message
          </label>
          <input
            id={`${id}-msg`}
            value={body}
            maxLength={1000}
            onChange={(e) => setBody(e.target.value)}
            placeholder={`Message ${current?.label}`}
            className="hairline h-10 min-w-0 flex-1 rounded-full bg-surface px-4 text-[14px] text-text-primary max-sm:h-11"
          />
          <Button type="submit" loading={post.isPending} icon={<Send size={15} aria-hidden />} className="h-10 max-sm:h-11">
            Send
          </Button>
        </div>
        {post.error ? <FieldError>{post.error.message}</FieldError> : null}
      </form>
    </div>
  )
}
