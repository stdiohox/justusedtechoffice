import { useId, useRef, useState } from 'react'
import { Camera, Mail, Pencil, UserPlus } from 'lucide-react'
import { Button, EmptyState, FieldError, Input, Label, Skeleton } from '@/components/ui/primitives'
import { useInvite, useInvites, useSetDeactivated, useSetJobTitle, useTeam, useWithdrawInvite, type TeamMember } from '@/hooks/useTeam'
import { useOfficeRole } from '@/hooks/useOffice'
import { useHasColumn } from '@/hooks/useHasColumn'
import { usePhotos } from '@/hooks/usePhotos'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { roleLabel } from '@/lib/constants'
import { TOUCH } from '@/lib/touch'
import { Avatar } from '@/components/office/OfficeVisuals'
import { PhotoEditor } from '@/components/PhotoEditor'
import { ActivitySettings } from '@/components/office/ActivitySettings'

/**
 * Settings (AdminRoute): who is on the team, inviting someone new, their
 * roles (job titles, 0016), and how the office records time. The office
 * admins, Mr Tito and Hazel, invite people and set roles; switching people
 * off, photos and the time settings are Mr Tito's alone. Who files reports,
 * pauses and days away live in Reports > Team.
 */

const NAME_PROBLEM = 'Give their name.'
const EMAIL_PROBLEM = 'Give an email address they read.'
const TITLE_MAX = 80
const TITLE_HINT = 'What they do, such as CEO or Operations Manager. Optional.'

function InviteForm({ titles }: { titles: boolean }) {
  const id = useId()
  const invite = useInvite()
  const showToast = useToastStore((s) => s.showToast)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [title, setTitle] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (invite.isPending) return
        if (!name.trim()) return setProblem(NAME_PROBLEM)
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setProblem(EMAIL_PROBLEM)
        setProblem(null)
        invite.mutate(
          { email, fullName: name, jobTitle: titles ? title : undefined },
          {
            onSuccess: () => {
              showToast(`Invite sent to ${email.trim()}`, 'success')
              setName('')
              setEmail('')
              setTitle('')
            },
            onError: (err) => setProblem(err instanceof Error ? err.message : 'The invite did not go out.'),
          },
        )
      }}
    >
      <div className="w-[220px] max-sm:w-full">
        <Label htmlFor={`${id}-name`}>Name</Label>
        <Input
          id={`${id}-name`}
          maxLength={120}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setProblem(null)
          }}
          invalid={problem === NAME_PROBLEM}
          aria-describedby={problem ? `${id}-err` : undefined}
          className={TOUCH}
        />
      </div>
      <div className="w-[260px] max-sm:w-full">
        <Label htmlFor={`${id}-email`}>Email</Label>
        <Input
          id={`${id}-email`}
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setProblem(null)
          }}
          invalid={problem === EMAIL_PROBLEM}
          aria-describedby={problem ? `${id}-err` : undefined}
          className={TOUCH}
        />
      </div>
      {titles ? (
        <div className="w-[220px] max-sm:w-full">
          <Label htmlFor={`${id}-title`}>Role (optional)</Label>
          <Input
            id={`${id}-title`}
            maxLength={TITLE_MAX}
            placeholder="Such as Operations Manager"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-describedby={`${id}-title-hint`}
            className={TOUCH}
          />
        </div>
      ) : null}
      <Button type="submit" icon={<UserPlus size={15} strokeWidth={1.75} />} aria-disabled={invite.isPending || undefined} aria-busy={invite.isPending || undefined} className={TOUCH}>
        Send invite
      </Button>
      <div className="basis-full">
        <div id={`${id}-err`}>
          <FieldError>{problem}</FieldError>
        </div>
        <p className="text-[12px] text-text-muted">
          They get an email with a link to choose a password. Once they have, they are in the office and file reports from their first workday.
        </p>
        {titles ? (
          <p id={`${id}-title-hint`} className="text-[12px] text-text-muted">
            Role: {TITLE_HINT} It shows on their door and beside their name. It gives no extra access.
          </p>
        ) : null}
      </div>
    </form>
  )
}

function PendingInvites() {
  const { data: invites, isError, refetch } = useInvites(true)
  const withdraw = useWithdrawInvite()
  const resend = useInvite()
  const showToast = useToastStore((s) => s.showToast)
  if (isError) {
    return (
      <p className="mt-5 text-[13px] text-text-secondary">
        The invites waiting to join could not be loaded.{' '}
        <button type="button" onClick={() => void refetch()} className={`press underline underline-offset-2 ${TOUCH}`}>
          Try again
        </button>
      </p>
    )
  }
  if (!invites?.length) return null
  return (
    <div className="mt-5">
      <h3 className="text-[12px] font-bold tracking-[0.06em] text-text-secondary uppercase">Waiting to join</h3>
      <ul className="mt-2 space-y-1.5">
        {invites.map((i) => (
          <li key={i.email} className="hairline-b flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
            <Mail size={14} strokeWidth={1.75} aria-hidden className="text-text-muted" />
            <span className="font-semibold text-text-primary">{i.full_name}</span>
            {i.job_title ? <span className="text-text-secondary">{i.job_title}</span> : null}
            <span className="text-text-secondary">{i.email}</span>
            <span className="tnum text-text-muted">invited {new Date(i.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
            <span className="ml-auto flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className={TOUCH}
                aria-label={`Send again: ${i.full_name}'s invite`}
                onClick={() =>
                  !resend.isPending &&
                  resend.mutate(
                    { email: i.email, fullName: i.full_name },
                    {
                      onSuccess: () => showToast(`Invite sent again to ${i.email}`, 'success'),
                      onError: (err) => showToast(err instanceof Error ? err.message : 'That did not go out.', 'error'),
                    },
                  )
                }
              >
                Send again
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={TOUCH}
                aria-label={`Withdraw ${i.full_name}'s invite`}
                onClick={() =>
                  withdraw.mutate(i.email, {
                    onSuccess: () => showToast('Invite withdrawn', 'success'),
                    onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
                  })
                }
              >
                Withdraw
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Someone's role (job title, 0016) in the team table. An admin edits it in
 * place: Enter or Save keeps it, Escape or Cancel leaves it as it was, and an
 * empty box clears it.
 */
function TitleCell({ member, editable }: { member: TeamMember; editable: boolean }) {
  const id = useId()
  const setTitle = useSetJobTitle()
  const showToast = useToastStore((s) => s.showToast)
  const [draft, setDraft] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const current = member.job_title ?? ''
  const close = () => {
    setDraft(null)
    setProblem(null)
    requestAnimationFrame(() => editButton.current?.focus())
  }
  const save = () => {
    if (draft === null || setTitle.isPending) return
    if (draft.trim() === current) return close()
    setTitle.mutate(
      { id: member.id, title: draft },
      {
        onSuccess: () => {
          showToast(draft.trim() ? `${member.full_name} is now ${draft.trim()}` : `${member.full_name}'s role is cleared`, 'success')
          close()
        },
        onError: (err) => setProblem(err instanceof Error ? err.message : 'That did not save.'),
      },
    )
  }

  if (draft === null) {
    return (
      <span className="flex items-center gap-1">
        <span className={current ? 'text-text-primary' : 'text-text-muted'}>{current || 'No role set'}</span>
        {editable ? (
          <button
            ref={editButton}
            type="button"
            aria-label={`Change ${member.full_name}'s role`}
            onClick={() => setDraft(current)}
            className={`press flex size-8 shrink-0 items-center justify-center rounded-[8px] text-text-muted hover:bg-hover hover:text-text-primary ${TOUCH}`}
          >
            <Pencil size={13} strokeWidth={1.75} aria-hidden />
          </button>
        ) : null}
      </span>
    )
  }
  return (
    <form
      className="flex flex-wrap items-center gap-1.5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <Input
        autoFocus
        aria-label={`${member.full_name}'s role`}
        aria-describedby={problem ? `${id}-err` : undefined}
        invalid={!!problem}
        maxLength={TITLE_MAX}
        placeholder="Such as Operations Manager"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          setProblem(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            close()
          }
        }}
        className={`w-[180px] ${TOUCH}`}
      />
      <Button type="submit" size="sm" loading={setTitle.isPending} className={TOUCH}>
        Save
      </Button>
      <Button type="button" variant="ghost" size="sm" className={TOUCH} disabled={setTitle.isPending} onClick={close}>
        Cancel
      </Button>
      <div id={`${id}-err`} className="basis-full">
        <FieldError>{problem}</FieldError>
      </div>
    </form>
  )
}

function TeamTable({ titles }: { titles: boolean }) {
  const me = useAuthStore((s) => s.profile?.id)
  // Switching off and photos stay Mr Tito's (the database enforces it too).
  const { isManager } = useOfficeRole()
  const { data: team, isLoading, isError, error } = useTeam()
  const { data: photos } = usePhotos()
  const setDeactivated = useSetDeactivated()
  const showToast = useToastStore((s) => s.showToast)
  const [photoFor, setPhotoFor] = useState<{ id: string; name: string } | null>(null)

  if (isLoading) return <Skeleton className="h-[160px]" />
  if (isError) return <EmptyState title="Could not load the team" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
  return (
    <div className="overflow-x-auto" role="region" aria-label="Team table (scrolls sideways)" tabIndex={0}>
      <table className="w-full min-w-[720px] text-left text-[13px]">
        <thead>
          <tr className="hairline-b text-[11px] tracking-[0.08em] text-text-muted uppercase">
            <th scope="col" className="py-2 pr-4 font-semibold">Name</th>
            <th scope="col" className="py-2 pr-4 font-semibold">Email</th>
            {titles ? <th scope="col" className="py-2 pr-4 font-semibold">Role</th> : null}
            <th scope="col" className="py-2 pr-4 font-semibold">Access</th>
            {isManager ? (
              <th scope="col" className="py-2 font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {(team ?? []).map((m) => (
            <tr key={m.id} className="hairline-b align-middle">
              <td className="py-2.5 pr-4 text-text-primary">
                <span className="flex items-center gap-2.5">
                  <Avatar name={m.full_name} userId={m.id} size="sm" />
                  {m.full_name}
                  {m.deactivated_at ? <span className="text-text-muted">(switched off)</span> : null}
                </span>
              </td>
              <td className="py-2 pr-4 text-text-secondary">{m.email}</td>
              {titles ? (
                <td className="py-2 pr-4">
                  <TitleCell member={m} editable={!m.deactivated_at} />
                </td>
              ) : null}
              <td className="py-2 pr-4 text-text-secondary">{roleLabel(m.role)}</td>
              {isManager ? (
                <td className="py-2 text-right whitespace-nowrap">
                  {photos?.available ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Camera size={14} strokeWidth={1.75} />}
                      className={TOUCH}
                      aria-label={`${m.full_name}'s photo`}
                      onClick={() => setPhotoFor({ id: m.id, name: m.full_name })}
                    >
                      Photo
                    </Button>
                  ) : null}
                  {m.id !== me ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={TOUCH}
                      aria-label={`${m.deactivated_at ? 'Switch on' : 'Switch off'} ${m.full_name}`}
                      onClick={() =>
                        setDeactivated.mutate(
                          { id: m.id, deactivated: !m.deactivated_at },
                          {
                            onSuccess: () => showToast(m.deactivated_at ? `${m.full_name} can sign in again` : `${m.full_name} is switched off`, 'success'),
                            onError: (err) => showToast(err instanceof Error ? err.message : 'That did not work.', 'error'),
                          },
                        )
                      }
                    >
                      {m.deactivated_at ? 'Switch on' : 'Switch off'}
                    </Button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {photoFor ? (
        <PhotoEditor userId={photoFor.id} name={photoFor.name} open={!!photoFor} onOpenChange={(o) => !o && setPhotoFor(null)} />
      ) : null}
    </div>
  )
}

export function Settings() {
  const { isManager } = useOfficeRole()
  // Roles (job titles) once 0016 is in.
  const titles = useHasColumn('profiles', 'job_title')
  return (
    <div className="mx-auto max-w-[960px] space-y-6 p-4 sm:p-6">
      <h1 className="font-display text-[28px] leading-none text-text-primary">Settings</h1>
      <section aria-labelledby="invite-h" className="hairline rounded-[14px] bg-surface-raised p-4 shadow-[var(--shadow-sm)] sm:p-5">
        <h2 id="invite-h" className="mb-3 text-[15px] font-bold text-text-primary">
          Invite someone
        </h2>
        <InviteForm titles={titles} />
        <PendingInvites />
      </section>
      <section aria-labelledby="team-h" className="hairline rounded-[14px] bg-surface-raised p-4 shadow-[var(--shadow-sm)] sm:p-5">
        <h2 id="team-h" className="mb-1 text-[15px] font-bold text-text-primary">
          The team
        </h2>
        <p className="mb-3 text-[12px] text-text-muted">
          {titles ? 'Role is what someone does; it shows on their door. Access is what they can see: Manager is an admin. ' : ''}
          {isManager
            ? 'Switching someone off shuts them out of the office at once and keeps their reports. Who files reports, pauses and days away are in Reports > Team.'
            : 'Switching someone off, photos and the office’s settings are Mr Tito’s.'}
        </p>
        <TeamTable titles={titles} />
      </section>
      <ActivitySettings />
    </div>
  )
}
