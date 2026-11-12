import { useId, useState, type FormEvent } from 'react'
import { Megaphone, Pin, Trash2 } from 'lucide-react'
import { Button, EmptyState, FieldError, Input, Label, Skeleton, Textarea } from '@/components/ui/primitives'
import { useOfficeMembers, useOfficeRole } from '@/hooks/useOffice'
import { useExtrasAvailable, useNotices, usePostNotice, useReadNotice, useRemoveNotice, type Notice } from '@/hooks/useExtras'
import { ExtrasOff } from '@/components/office/ExtrasOff'
import { useToastStore } from '@/stores/toastStore'
import { useAuthStore } from '@/stores/authStore'
import { absoluteTime, firstName } from '@/lib/utils'

/**
 * The notice board (0021). Admins post; a notice that must be read shows who has
 * pressed "I have read this", so nobody has to chase it by hand.
 */
function NoticeCard({ n, canManage }: { n: Notice; canManage: boolean }) {
  const me = useAuthStore((s) => s.profile?.id) ?? ''
  const { data: members } = useOfficeMembers()
  const read = useReadNotice()
  const remove = useRemoveNotice()
  const showToast = useToastStore((s) => s.showToast)
  const fail = (e: Error) => showToast(e.message, 'error')
  const team = (members ?? []).filter((m) => m.active)
  const author = team.find((m) => m.user_id === n.author)?.user?.full_name ?? 'Someone'
  const readers = new Set(n.reads.map((r) => r.user_id))
  const waiting = team.filter((m) => !readers.has(m.user_id))
  const iHaveRead = readers.has(me)

  return (
    <article className="hairline rounded-[14px] bg-surface-raised p-4 sm:p-5">
      <div className="flex items-start gap-2">
        <h2 className="mr-auto text-[16px] font-bold text-text-primary">{n.title}</h2>
        {n.pinned ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-[var(--tint-brand)] px-2 py-0.5 text-[12px] font-semibold text-brand">
            <Pin size={12} aria-hidden /> Pinned
          </span>
        ) : null}
        {canManage ? (
          <button
            type="button"
            onClick={() => remove.mutate(n.id, { onError: fail })}
            aria-label={`Remove the notice: ${n.title}`}
            className="press rounded-full p-1.5 text-text-muted hover:bg-[var(--hover)] hover:text-state-danger max-sm:p-3"
          >
            <Trash2 size={15} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </div>
      <p className="mt-0.5 text-[12px] text-text-muted">
        {author}, {absoluteTime(n.created_at)}
      </p>
      <p className="mt-3 text-[14px] leading-relaxed whitespace-pre-wrap text-text-secondary">{n.body}</p>
      {n.needs_read ? (
        <div className="hairline-t mt-4 flex flex-wrap items-center gap-3 pt-3">
          <p className="mr-auto text-[13px] text-text-secondary">
            <span className="tnum font-semibold text-text-primary">
              {team.length - waiting.length} of {team.length}
            </span>{' '}
            have read this
            {canManage && waiting.length ? `. Still to read: ${waiting.map((m) => firstName(m.user?.full_name ?? '')).join(', ')}` : ''}
          </p>
          {iHaveRead ? (
            <span className="text-[13px] font-semibold text-state-success">You have read this</span>
          ) : (
            <Button size="sm" className="max-sm:h-11" loading={read.isPending} onClick={() => read.mutate({ notice_id: n.id, user_id: me }, { onError: fail })}>
              I have read this
            </Button>
          )}
        </div>
      ) : null}
    </article>
  )
}

export function Notices() {
  const id = useId()
  const profile = useAuthStore((s) => s.profile)
  const { seesTeam } = useOfficeRole()
  const canManage = seesTeam || profile?.role === 'manager'
  const on = useExtrasAvailable()
  const { data, isLoading, isError } = useNotices()
  const post = usePostNotice()
  const showToast = useToastStore((s) => s.showToast)
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [pinned, setPinned] = useState(false)
  const [needsRead, setNeedsRead] = useState(true)
  const [problem, setProblem] = useState<string | null>(null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) return setProblem('Give the notice a title and some words.')
    setProblem(null)
    post.mutate(
      { title: title.trim(), body: body.trim(), pinned, needs_read: needsRead, author: profile?.id ?? '' },
      {
        onSuccess: () => {
          setTitle('')
          setBody('')
          setPinned(false)
          setOpen(false)
          showToast('Posted to the team', 'success')
        },
        onError: (err) => setProblem(err.message),
      },
    )
  }

  if (on === false) return <ExtrasOff icon={<Megaphone size={22} strokeWidth={1.5} />} what="The notice board" />

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 flex flex-wrap items-end gap-3 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <div className="mr-auto">
          <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">Notices</h1>
          <p className="mt-1.5 text-[13px] text-text-muted">What the whole team needs to know, and who has read it.</p>
        </div>
        {canManage ? (
          <Button variant={open ? 'secondary' : 'primary'} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'Close' : 'Post a notice'}
          </Button>
        ) : null}
      </div>
      <div className="mx-auto max-w-[760px] space-y-4 p-4 sm:p-6">
        {open ? (
          <form onSubmit={submit} className="hairline space-y-3 rounded-[14px] bg-surface-raised p-4 sm:p-5" noValidate>
            <div>
              <Label htmlFor={`${id}-title`}>Title</Label>
              <Input id={`${id}-title`} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div>
              <Label htmlFor={`${id}-body`}>Message</Label>
              <Textarea id={`${id}-body`} rows={4} value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
            </div>
            <div className="flex flex-wrap gap-4 text-[13px] text-text-secondary">
              <label className="flex min-h-11 cursor-pointer items-center gap-2 sm:min-h-0">
                <input type="checkbox" checked={needsRead} onChange={(e) => setNeedsRead(e.target.checked)} /> Everyone must confirm they have read it
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2 sm:min-h-0">
                <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} /> Pin to the top
              </label>
            </div>
            <FieldError>{problem}</FieldError>
            <Button type="submit" loading={post.isPending}>
              Post to the team
            </Button>
          </form>
        ) : null}
        {isLoading ? (
          <Skeleton className="h-[220px]" />
        ) : isError ? (
          <EmptyState title="Could not load the notices" body="Try again in a moment." />
        ) : !data?.length ? (
          <EmptyState icon={<Megaphone size={22} strokeWidth={1.5} />} title="No notices yet" body="Anything posted here reaches the whole team." />
        ) : (
          data.map((n) => <NoticeCard key={n.id} n={n} canManage={canManage} />)
        )}
      </div>
    </div>
  )
}
