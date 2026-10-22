import { NavLink, Outlet } from 'react-router-dom'
import { Building2, ClipboardCheck, ListChecks, LogOut, Moon, Settings, Sun, Trophy } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useToastStore } from '@/stores/toastStore'
import { useThemeStore } from '@/stores/themeStore'
import { useOfficeRole } from '@/hooks/useOffice'
import { cn, initials } from '@/lib/utils'
import { titleOf } from '@/lib/constants'
import { SCROLLPORT_ID } from '@/lib/scrollport'
import { Toast } from '@/components/ui/Toast'
import { KnockLayer } from '@/components/office/KnockLayer'
import { CheckinLayer } from '@/components/office/CheckinLayer'
import { TaskLayer } from '@/components/office/TaskLayer'
import { OfficePresence } from '@/components/office/OfficePresence'
import { StatusMenu } from '@/components/office/StatusMenu'
import { Photo } from '@/components/ui/Photo'
import { usePhotoRefresh } from '@/hooks/usePhotos'
import { useTasks } from '@/hooks/useTasks'
import { useLeaderboardAvailable } from '@/hooks/useLeaderboard'
import { needsMe } from '@/lib/tasks'

/**
 * The office's frame: a dark sidebar on a computer, a bottom tab bar on a
 * phone, and a top bar with your status. Presence, knocks and check-ins are
 * mounted here, so they reach you on every screen.
 */

const NAV = [
  { to: '/office', label: 'Office', icon: Building2, adminOnly: false },
  { to: '/reports', label: 'Reports', icon: ClipboardCheck, adminOnly: false },
  // Shown once 0011 is applied.
  { to: '/tasks', label: 'Tasks', icon: ListChecks, adminOnly: false },
  // Shown once 0012 is applied.
  { to: '/leaderboard', label: 'Leaderboard', icon: Trophy, adminOnly: false },
  { to: '/settings', label: 'Settings', icon: Settings, adminOnly: true },
]

function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      {/* TODO: swap for final vector/SVG logo when client delivers it */}
      <img src="/jut-icon-mark.png" alt="" width={28} height={28} className="size-7 rounded-[8px] object-contain" />
      <span className="text-[15px] font-extrabold tracking-[0.02em]">
        JUSTUSED <span className="font-semibold opacity-80">Office</span>
      </span>
    </span>
  )
}

export function AppShell() {
  const { profile, signOut } = useAuthStore()
  const { isManager, isMember } = useOfficeRole()
  const { resolvedTheme, setTheme } = useThemeStore()
  const toast = useToastStore((s) => s.toast)
  const hideToast = useToastStore((s) => s.hideToast)
  usePhotoRefresh()
  const { data: tasks } = useTasks()
  const { data: boardOn } = useLeaderboardAvailable()

  // Settings: Mr Tito, and anyone labelled manager (Hazel), as AdminRoute.
  const isAdmin = isManager || profile?.role === 'manager'
  const items = NAV.filter(
    (n) => (!n.adminOnly || isAdmin) && (n.to !== '/tasks' || tasks?.available) && (n.to !== '/leaderboard' || boardOn),
  )
  // Tasks waiting on you: given to you and not started, or done and waiting for your check.
  const waiting = profile && tasks?.available ? tasks.rows.filter((t) => needsMe(t, profile.id)).length : 0
  const badge = (to: string) => (to === '/tasks' && waiting ? waiting : 0)
  const name = profile?.full_name ?? ''

  return (
    <div className="grid h-[100dvh] grid-rows-[4rem_minmax(0,1fr)] overflow-hidden md:grid-cols-[220px_minmax(0,1fr)]">
      {/* TOP: who you are and how you are. */}
      <header className="hairline-b col-span-full flex items-center gap-3 bg-surface-raised px-4 md:px-5">
        <Logo className="text-text-primary" />
        <div className="ml-auto flex items-center gap-2">
          {/* Available, working elsewhere, do not disturb, or sign out of the office. */}
          {isMember ? <StatusMenu compact /> : null}
          <button
            type="button"
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            title={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            aria-label={`Switch to ${resolvedTheme === 'dark' ? 'light' : 'dark'} mode`}
            className="press flex size-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-150 hover:bg-hover max-sm:size-11"
          >
            {resolvedTheme === 'dark' ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
          </button>
          <span
            title={`${name} (${profile ? titleOf(profile) : ''})`}
            className="ml-1 hidden size-8 shrink-0 items-center justify-center rounded-full bg-brand text-[12px] font-bold text-surface sm:flex"
          >
            <span className="sr-only">Signed in as {name}</span>
            <Photo userId={profile?.id} className="size-8" eager>
              {initials(name || '?')}
            </Photo>
          </span>
        </div>
      </header>

      {/* LEFT: navigation. Dark in both themes; it is structural chrome. */}
      <div className="on-dark hidden min-h-0 flex-col overflow-y-auto bg-[var(--sidebar-bg)] md:flex">
        <nav aria-label="Main" className="flex flex-1 flex-col gap-1 px-3 pt-4">
          {items.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  'relative flex h-10 items-center gap-2.5 rounded-full px-4 text-sm transition-colors duration-150',
                  isActive
                    ? 'bg-[var(--sidebar-active-bg)] font-bold text-accent'
                    : 'text-[var(--on-dark-muted)] hover:bg-[var(--sidebar-active-bg)] hover:text-white',
                )
              }
            >
              <Icon size={17} strokeWidth={1.75} aria-hidden />
              {label}
              {badge(to) ? (
                <span className="ml-auto rounded-full bg-gold px-1.5 py-px text-[11px] font-bold text-ink tabular-nums">
                  {badge(to)}
                  <span className="sr-only"> waiting on you</span>
                </span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[var(--sidebar-border)] p-3">
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--on-dark-fill)] text-[11px] font-bold text-white">
              <Photo userId={profile?.id} className="size-8" eager>
                {initials(name || '?')}
              </Photo>
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-white">{name}</p>
              <p className="truncate text-[11px] text-[var(--on-dark-faint)]">{profile ? titleOf(profile) : ''}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              aria-label="Sign out"
              title="Sign out"
              className="press rounded-full p-2 text-[var(--on-dark-faint)] transition-colors duration-150 hover:bg-[var(--sidebar-border)] hover:text-white"
            >
              <LogOut size={15} strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>

      {/* CENTRE: the one scrollport. */}
      {/* scroll-padding keeps a focused control clear of the phone's tab bar. */}
      <main id={SCROLLPORT_ID} className="min-h-0 min-w-0 overflow-y-auto bg-surface pb-16 max-md:scroll-pb-20 md:pb-0">
        <Outlet />
      </main>

      {/* Phone: the sidebar becomes a bottom tab bar. */}
      <nav aria-label="Main" className="on-dark hairline-t fixed inset-x-0 bottom-0 z-50 flex h-16 bg-[var(--sidebar-bg)] md:hidden">
        {items.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center justify-center gap-1 text-[11px] transition-colors duration-150',
                isActive ? 'font-bold text-accent' : 'text-[var(--on-dark-muted)]',
              )
            }
          >
            <span className="relative">
              <Icon size={19} strokeWidth={1.75} aria-hidden />
              {badge(to) ? (
                <span aria-hidden className="absolute -top-1.5 -right-2.5 min-w-4 rounded-full bg-gold px-1 text-center text-[10px] leading-4 font-bold text-ink tabular-nums">
                  {badge(to)}
                </span>
              ) : null}
            </span>
            {label}
            {/* After the label, so it reads "Tasks, 3 waiting on you". */}
            {badge(to) ? <span className="sr-only">, {badge(to)} waiting on you</span> : null}
          </NavLink>
        ))}
        <button
          type="button"
          onClick={() => void signOut()}
          className="flex flex-1 flex-col items-center justify-center gap-1 text-[11px] text-[var(--on-dark-muted)]"
        >
          <LogOut size={19} strokeWidth={1.75} aria-hidden />
          Sign out
        </button>
      </nav>

      {/* Presence, knocks and check-ins reach you on every screen. Keyed by
          person: nothing carries over to whoever signs in next on this browser. */}
      <OfficePresence />
      <KnockLayer key={profile?.id ?? 'signed-out'} />
      <CheckinLayer key={`checkin-${profile?.id ?? 'signed-out'}`} />
      <TaskLayer key={`tasks-${profile?.id ?? 'signed-out'}`} />

      {toast ? <Toast key={toast.id} message={toast.message} type={toast.type} onClose={hideToast} /> : null}
    </div>
  )
}
