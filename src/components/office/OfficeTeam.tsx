import { useState } from 'react'
import { Button, FieldError, Input, Label, Select } from '@/components/ui/primitives'
import {
  useAddAbsence,
  useAddOfficeMember,
  useOfficeAbsences,
  useRemoveAbsence,
  useRemoveOfficeMember,
  useOfficeRole,
  useUpdateOfficeMember,
  type OfficeMemberWithUser,
} from '@/hooks/useOffice'
import { useTeam } from '@/hooks/useTeam'
import { useAuthStore } from '@/stores/authStore'
import { titleOf } from '@/lib/constants'
import type { OfficeSettings } from '@/types/database'
import { Avatar } from '@/components/office/OfficeVisuals'
import { TOUCH } from '@/lib/touch'
import { useOnboardingStatus } from '@/hooks/useOfficeOnboarding'
import { usePhotos } from '@/hooks/usePhotos'
import { onboardingSteps } from '@/components/office/Onboarding'

/**
 * Who is in the office and the days nobody should be flagged for. Alerts
 * and reminders go to each person's login email (api/cron/office-alerts).
 * Mr Tito only: RLS on office_members and
 * office_absences refuses these writes from anyone else.
 */

function AddMember({ members }: { members: OfficeMemberWithUser[] }) {
  const { data: team } = useTeam()
  const add = useAddOfficeMember()
  const [userId, setUserId] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const candidates = (team ?? []).filter((u) => !u.deactivated_at && !members.some((m) => m.user_id === u.id))

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        if (!userId) return setProblem('Pick someone.')
        setProblem(null)
        add.mutate(userId, {
          onSuccess: () => setUserId(''),
          onError: (err) => setProblem(err instanceof Error ? err.message : 'Not added.'),
        })
      }}
    >
      <div className="w-[220px]">
        <Label htmlFor="office-add-user">Add to the office</Label>
        <Select id="office-add-user" className={TOUCH} value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose a team member</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.full_name} ({titleOf(u)})
            </option>
          ))}
        </Select>
      </div>
      <Button type="submit" className={TOUCH} loading={add.isPending}>
        Add
      </Button>
      <div className="basis-full">
        <FieldError>{problem}</FieldError>
        <p className="text-[12px] text-text-muted">
          Not listed? Invite them in Settings first (role Staff for anyone outside sales). Reminders and alerts go
          to their login email.
        </p>
      </div>
    </form>
  )
}

function Absences({ members }: { members: OfficeMemberWithUser[] }) {
  const { data: absences } = useOfficeAbsences()
  const add = useAddAbsence()
  const remove = useRemoveAbsence()
  const [who, setWho] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const name = (id: string | null) =>
    id === null ? 'Everyone' : (members.find((m) => m.user_id === id)?.user?.full_name ?? 'Former member')

  return (
    <section aria-labelledby="absences-h" className="hairline space-y-3 rounded-[14px] bg-surface-raised p-4 shadow-[var(--shadow-sm)] sm:p-5">
      <h2 id="absences-h" className="text-[15px] font-medium text-text-primary">
        Days away
      </h2>
      <p className="text-[13px] text-text-muted">Leave, sick days and public holidays. Nobody is flagged on these days.</p>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!from || !reason.trim()) return setProblem('Give a start date and a reason.')
          const end = to || from
          if (end < from) return setProblem('The end date is before the start date.')
          setProblem(null)
          add.mutate(
            { user_id: who || null, starts_on: from, ends_on: end, reason: reason.trim() },
            {
              onSuccess: () => {
                setFrom('')
                setTo('')
                setReason('')
              },
              onError: (err) => setProblem(err instanceof Error ? err.message : 'Not saved.'),
            },
          )
        }}
      >
        <div className="w-[180px]">
          <Label htmlFor="abs-who">Who</Label>
          <Select id="abs-who" className={TOUCH} value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone (holiday)</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.user?.full_name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="abs-from">From</Label>
          <Input id="abs-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`w-[160px] ${TOUCH}`} />
        </div>
        <div>
          <Label htmlFor="abs-to">To</Label>
          <Input id="abs-to" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className={`w-[160px] ${TOUCH}`} />
        </div>
        <div className="w-[220px]">
          <Label htmlFor="abs-reason">Reason</Label>
          <Input id="abs-reason" className={TOUCH} maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <Button type="submit" className={TOUCH} loading={add.isPending}>
          Add
        </Button>
        <div className="basis-full">
          <FieldError>{problem}</FieldError>
        </div>
      </form>

      {absences?.length ? (
        <ul className="space-y-1.5">
          {absences.map((a) => (
            <li key={a.id} className="hairline-b flex flex-wrap items-center gap-3 py-1.5 text-[13px]">
              <span className="w-[140px] text-text-primary">{name(a.user_id)}</span>
              <span className="tnum text-text-secondary">
                {a.starts_on === a.ends_on ? a.starts_on : `${a.starts_on} to ${a.ends_on}`}
              </span>
              <span className="text-text-muted">{a.reason}</span>
              <Button
                variant="ghost"
                size="sm"
                className={`ml-auto ${TOUCH}`}
                aria-label={`Remove ${name(a.user_id)}, ${a.starts_on}`}
                loading={remove.isPending && remove.variables === a.id}
                onClick={() => remove.mutate(a.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/** "4 of 6 · notice read 16 Oct", or "Notice not read". Null before 0010, or for Mr Tito. */
function SetupCell({ userId, zone }: { userId: string; zone: string }) {
  const { data } = useOnboardingStatus(true)
  const { data: photos } = usePhotos()
  if (!data?.available) return null
  const row = data.rows.find((r) => r.user_id === userId)
  if (!row) return <span className="text-text-muted">-</span>
  const steps = onboardingSteps(row, !!photos?.available)
  const done = steps.filter((s) => s.done).length
  const read = !!row.notice_acked_at
  const when = row.notice_acked_at
    ? new Date(row.notice_acked_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: zone })
    : null
  return (
    <span className="tnum text-text-secondary">
      {done === steps.length ? 'All done' : `${done} of ${steps.length}`}
      <span className="text-text-muted"> · </span>
      {read ? (
        <span>notice read{when ? ` ${when}` : ''}</span>
      ) : (
        <span className="text-[var(--color-state-warning)]">{row.notice_version ? 'new notice not read' : 'notice not read'}</span>
      )}
    </span>
  )
}

export function OfficeTeam({ settings, members }: { settings: OfficeSettings; members: OfficeMemberWithUser[] }) {
  const update = useUpdateOfficeMember()
  const remove = useRemoveOfficeMember()
  const me = useAuthStore((s) => s.profile?.id)
  const { isManager } = useOfficeRole()
  // HR (0017) pauses and removes people, but not Mr Tito, and not herself (she
  // would lock herself out). The database refuses both too.
  const canChange = (userId: string) => isManager || (userId !== settings.manager_id && userId !== me)
  const { data: onboarding } = useOnboardingStatus(true)
  const setup = !!onboarding?.available

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <section aria-labelledby="members-h" className="hairline space-y-4 rounded-[14px] bg-surface-raised p-4 shadow-[var(--shadow-sm)] sm:p-5">
        <h2 id="members-h" className="text-[15px] font-medium text-text-primary">
          In the office
        </h2>
        {members.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13px]">
              <thead>
                <tr className="hairline-b text-[11px] tracking-[0.08em] text-text-muted uppercase">
                  <th scope="col" className="py-2 pr-4 font-medium">Name</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Email</th>
                  <th scope="col" className="py-2 pr-4 font-medium">Reports</th>
                  {setup ? <th scope="col" className="py-2 pr-4 font-medium">Getting started</th> : null}
                  <th scope="col" className="py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.user_id} className="hairline-b align-middle">
                    <td className="py-2.5 pr-4 text-text-primary">
                      <span className="flex items-center gap-2.5">
                        <Avatar name={m.user?.full_name ?? 'Former member'} userId={m.user_id} size="sm" />
                        {m.user?.full_name ?? 'Former member'}
                        {m.user?.deactivated_at ? <span className="text-text-muted">(deactivated)</span> : null}
                      </span>
                    </td>
                    <td className="py-2 pr-4">
                      <span className="text-text-secondary">{m.user?.email ?? ''}</span>
                    </td>
                    <td className="py-2 pr-4 text-text-secondary">
                      {m.user_id === settings.manager_id ? 'Receives them' : m.active ? 'Files daily' : 'Paused'}
                    </td>
                    {setup ? (
                      <td className="py-2 pr-4">{m.user_id === settings.manager_id ? null : <SetupCell userId={m.user_id} zone={settings.timezone} />}</td>
                    ) : null}
                    <td className="py-2 text-right whitespace-nowrap">
                      {m.user_id !== settings.manager_id && canChange(m.user_id) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={TOUCH}
                          aria-label={`${m.active ? 'Pause' : 'Resume'} ${m.user?.full_name ?? 'this person'}`}
                          onClick={() => update.mutate({ user_id: m.user_id, active: !m.active })}
                        >
                          {m.active ? 'Pause' : 'Resume'}
                        </Button>
                      ) : null}
                      {canChange(m.user_id) ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className={TOUCH}
                          aria-label={`Remove ${m.user?.full_name ?? 'this person'} from the office`}
                          loading={remove.isPending && remove.variables === m.user_id}
                          onClick={() => {
                            if (window.confirm(`Remove ${m.user?.full_name ?? 'this person'} from the office? Their past reports are kept.`))
                              remove.mutate(m.user_id)
                          }}
                        >
                          Remove
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[13px] text-text-muted">Nobody yet. Add the team below; reminders go to each person's login email.</p>
        )}
        <AddMember members={members} />
      </section>

      <Absences members={members.filter((m) => m.user_id !== settings.manager_id)} />
    </div>
  )
}
