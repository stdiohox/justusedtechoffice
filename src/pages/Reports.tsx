import { useState } from 'react'
import { ClipboardCheck, Users } from 'lucide-react'
import { EmptyState, Select, Skeleton } from '@/components/ui/primitives'
import { AttendanceMonth } from '@/components/office/AttendanceMonth'
import type { OfficeMemberWithUser } from '@/hooks/useOffice'
import { MyDay } from '@/components/office/MyDay'
import { MemberWeek, TeamDay } from '@/components/office/TeamReports'
import { OfficeTeam } from '@/components/office/OfficeTeam'
import { officeDate, useOfficeMembers, useOfficeRealtime, useOfficeRole, useOfficeSettings } from '@/hooks/useOffice'
import { cn } from '@/lib/utils'
import type { OfficeSettings } from '@/types/database'

/**
 * Daily reports (tito-crm's VIRTUAL-OFFICE-PLAN Phase 1). One route, two screens:
 * a member files their own day; Mr Tito (office_settings.manager_id) and HR
 * (0017) read everyone's and run the team, and HR files her own day under
 * Mine. Which one renders is a convenience; what each person can read and
 * write is decided by RLS and submit_report().
 */

type Tab = 'day' | 'week' | 'month' | 'team' | 'mine'
const TEAM_TABS: { id: Tab; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
  { id: 'team', label: 'Team' },
]
const HR_TABS: { id: Tab; label: string }[] = [...TEAM_TABS, { id: 'mine', label: 'Mine' }]

/** One person's month (0010), picked from everyone who files reports. */
function MemberMonth({ settings, members }: { settings: OfficeSettings; members: OfficeMemberWithUser[] }) {
  const reporters = members.filter((m) => m.user_id !== settings.manager_id)
  const [picked, setPicked] = useState(reporters[0]?.user_id ?? '')
  // The roster refreshes live; if the picked person leaves it, fall back.
  const userId = reporters.some((m) => m.user_id === picked) ? picked : (reporters[0]?.user_id ?? '')
  if (!reporters.length) {
    return <EmptyState icon={<Users size={22} strokeWidth={1.5} />} title="Nobody is in the office yet" body="Add the team in the Team tab." />
  }
  const name = reporters.find((m) => m.user_id === userId)?.user?.full_name ?? 'Former member'
  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="w-[200px]">
        <label htmlFor="office-month-member" className="sr-only">
          Team member
        </label>
        <Select id="office-month-member" value={userId} onChange={(e) => setPicked(e.target.value)} className="h-8 text-[13px] max-sm:h-11">
          {reporters.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.user?.full_name ?? 'Former member'}
            </option>
          ))}
        </Select>
      </div>
      <AttendanceMonth key={userId} settings={settings} userId={userId} name={name} />
    </div>
  )
}

/** `mine`: HR, who also files her own day (0017). */
function Manager({ settings, mine }: { settings: OfficeSettings; mine: boolean }) {
  const TABS = mine ? HR_TABS : TEAM_TABS
  // Five tabs are narrower, so the row still fits a phone.
  const w = TABS.length > 4 ? 64 : 72
  const [tab, setTab] = useState<Tab>('day')
  const [date, setDate] = useState(() => officeDate(settings, new Date()))
  const { data: members } = useOfficeMembers()
  useOfficeRealtime(true)

  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 flex flex-wrap items-end gap-3 bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <h1 className="mr-auto font-display text-[28px] leading-none font-medium text-text-primary">Team reports</h1>
        <div
          role="tablist"
          aria-label="Report views"
          className="relative flex h-9 rounded-[14px] border border-line bg-surface-sunken p-[3px] max-sm:h-[52px]"
          onKeyDown={(e) => {
            // The ARIA tab pattern: arrows move between tabs, Home/End jump.
            const i = TABS.findIndex((t) => t.id === tab)
            const next =
              e.key === 'ArrowRight' ? (i + 1) % TABS.length
              : e.key === 'ArrowLeft' ? (i - 1 + TABS.length) % TABS.length
              : e.key === 'Home' ? 0
              : e.key === 'End' ? TABS.length - 1
              : -1
            if (next < 0) return
            e.preventDefault()
            setTab(TABS[next].id)
            document.getElementById(`reports-tab-${TABS[next].id}`)?.focus()
          }}
        >
          {/* The thumb slides under the selected tab; the buttons sit on top. */}
          <span
            aria-hidden
            className="seg-thumb absolute top-[3px] bottom-[3px] left-[3px] rounded-[10px] bg-surface-raised shadow-[var(--shadow-sm)]"
            style={{ width: w, transform: `translateX(${TABS.findIndex((t) => t.id === tab) * w}px)` }}
          />
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`reports-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="reports-panel"
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              style={{ width: w }}
              className={cn(
                'relative rounded-[10px] text-[13px] font-medium transition-colors duration-150',
                tab === t.id ? 'font-semibold text-text-primary' : 'text-text-muted hover:text-text-primary',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div id="reports-panel" role="tabpanel" tabIndex={0} aria-labelledby={`reports-tab-${tab}`}>
        {!members ? (
          <div className="p-5">
            <Skeleton className="h-[160px]" />
          </div>
        ) : tab === 'day' ? (
          <TeamDay settings={settings} members={members} date={date} onDate={setDate} />
        ) : tab === 'week' ? (
          <MemberWeek
            settings={settings}
            members={members}
            onOpenDay={(d) => {
              setDate(d)
              setTab('day')
            }}
          />
        ) : tab === 'month' ? (
          <MemberMonth settings={settings} members={members} />
        ) : tab === 'mine' ? (
          <MyDay settings={settings} />
        ) : (
          <OfficeTeam settings={settings} members={members} />
        )}
      </div>
    </div>
  )
}

export function Reports() {
  const { data: settings, isLoading, isError, error } = useOfficeSettings()
  const role = useOfficeRole()

  if (isLoading || role.loading) {
    return (
      <div className="mx-auto max-w-[720px] space-y-3 p-5">
        <Skeleton className="h-[88px]" />
        <Skeleton className="h-[88px]" />
      </div>
    )
  }
  if (isError || role.isError || !settings) {
    return <EmptyState title="Could not load the office" body={error instanceof Error ? error.message : 'Try again in a moment.'} />
  }
  if (role.seesTeam) return <Manager settings={settings} mine={role.isHr} />
  if (!role.isMember) {
    return (
      <EmptyState
        icon={<ClipboardCheck size={22} strokeWidth={1.5} />}
        title="You are not in the office"
        body={
          settings.manager_id
            ? 'Daily reports are for the office team. Ask Mr Tito to add you.'
            : 'The office has no manager yet. Set office_settings.manager_id (see migration 0002).'
        }
      />
    )
  }
  return (
    <div className="office-page">
      <div className="hairline-b sticky top-[var(--app-sticky-top)] z-10 flex items-end bg-surface/95 px-4 pt-4 pb-3 backdrop-blur-sm sm:px-6">
        <h1 className="font-display text-[28px] leading-none font-medium text-text-primary">My reports</h1>
      </div>
      <MyDay settings={settings} />
    </div>
  )
}
