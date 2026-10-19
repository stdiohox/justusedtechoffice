import type { MapStatus } from '@/lib/presence'
import { STATUS_LABEL } from '@/lib/presence'
import { cn, initials } from '@/lib/utils'
import { Photo } from '@/components/ui/Photo'

/**
 * Shared look for the office and reports screens. Presentation only: every
 * value here comes from data the screens already had.
 *
 * Status colours come in two sets. The office floor is a dark region in both
 * themes (like the sidebar), so it uses the lifted values; light surfaces use
 * the theme's state tokens.
 */

/** On the dark floor. Each clears 3:1 against the room fill as an indicator. */
const FLOOR_STATUS: Record<MapStatus, string> = {
  online: '#74be67',
  away: '#d0a83f',
  busy: '#e0806f',
  outside: '#6fa3c4',
  offline: 'rgba(246, 250, 247, 0.42)',
}

/** On theme surfaces (reports, chat, knock cards). */
const SURFACE_STATUS: Record<MapStatus, string> = {
  online: 'var(--color-state-success)',
  away: 'var(--color-state-warning)',
  busy: 'var(--color-state-danger)',
  outside: 'var(--color-state-info)',
  offline: 'var(--line-strong-role)',
}

const SIZES = { sm: 'size-8 text-[11px]', md: 'size-10 text-[13px]', lg: 'size-12 text-[14px]' } as const

/**
 * A person's photo (0007), or their initials, in a circle, with an optional
 * status ring. The ring is decoration; the status is always also given in
 * words next to it. Someone who is out is shown dimmed, like their door.
 */
export function Avatar({
  name,
  userId,
  status,
  size = 'md',
  onFloor = false,
  className,
}: {
  name: string
  /** Whose photo to show. Without it (or without a photo), initials. */
  userId?: string | null
  status?: MapStatus
  size?: keyof typeof SIZES
  onFloor?: boolean
  className?: string
}) {
  const lit = status !== 'offline'
  const ring = status ? (onFloor ? FLOOR_STATUS : SURFACE_STATUS)[status] : undefined
  return (
    <span aria-hidden className={cn('relative inline-flex shrink-0', className)}>
      {/* The pulse sits behind the face, so a still frame reads the same. */}
      {status === 'online' ? <span className="office-pulse" style={{ ['--pulse' as string]: ring }} /> : null}
      <span
        className={cn(
          'relative flex items-center justify-center rounded-full font-semibold tracking-[0.02em]',
          SIZES[size],
          onFloor
            ? lit
              ? 'bg-ivory text-forest'
              : 'bg-[rgba(246,250,247,0.08)] text-[rgba(246,250,247,0.70)]'
            : lit
              ? 'bg-forest text-ivory'
              : 'bg-surface-sunken text-text-muted',
        )}
        style={ring ? { boxShadow: `0 0 0 2px ${onFloor ? 'var(--room-bg, #007a37)' : 'var(--surface-raised)'}, 0 0 0 4px ${ring}` } : undefined}
      >
        <Photo userId={userId} className={cn('size-full', !lit && 'opacity-60 grayscale')}>
          {initials(name) || '?'}
        </Photo>
      </span>
    </span>
  )
}

/** A status dot and its word. Never colour alone. */
export function StatusWord({ status, onFloor = false }: { status: MapStatus; onFloor?: boolean }) {
  const colour = (onFloor ? FLOOR_STATUS : SURFACE_STATUS)[status]
  return (
    <span className={cn('flex items-center gap-1.5 text-[12px]', onFloor ? 'text-[rgba(246,250,247,0.82)]' : 'text-text-secondary')}>
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={status === 'offline' ? { boxShadow: `inset 0 0 0 1px ${colour}` } : { background: colour }}
      />
      {STATUS_LABEL[status]}
    </span>
  )
}

/**
 * "3 of 5" as five pips. The numbers are always printed beside it; the pips
 * are for scanning a row at a glance.
 */
export function Pips({ filled, total }: { filled: number; total: number }) {
  if (total <= 0 || total > 24) return null
  return (
    <span aria-hidden className="inline-flex items-center gap-[3px]">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn('h-[6px] w-[6px] rounded-full', i < filled ? 'bg-brand' : 'bg-transparent shadow-[inset_0_0_0_1px_var(--line-strong-role)]')}
        />
      ))}
    </span>
  )
}
