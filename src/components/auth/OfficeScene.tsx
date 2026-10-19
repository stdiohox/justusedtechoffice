import { Fragment, type CSSProperties } from 'react'
import { Moon, UserRound } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The sign-in page's picture of the office: a small copy of the real floor
 * (lit rooms, gold door light) where the team arrives, one room at a time.
 * One room has a knock at its door and one is on "Do not disturb"; below it,
 * your own status turns from Away to Online, which is what signing in does.
 *
 * Decoration only (aria-hidden). Everything is CSS and plays once: it all
 * settles within about four seconds (WCAG 2.2.2 asks for a pause control
 * past five). Before an animation starts, its first frame holds; if
 * animations never run, the settled picture is what shows. Under reduced
 * motion the global rule in index.css jumps straight to the settled frame.
 * The faces are blank on purpose: no invented people.
 */

type Room = { who?: 'in' | 'busy'; knock?: boolean }

/** Reading order. Two rows of three, with one room still empty. */
const ROOMS: Room[] = [{ who: 'in' }, { who: 'in', knock: true }, {}, { who: 'busy' }, { who: 'in' }, { who: 'in' }]

export function OfficeScene({ compact = false }: { compact?: boolean }) {
  const rooms = compact ? ROOMS.slice(0, 3) : ROOMS
  let arrival = 0
  return (
    <div aria-hidden className={cn('scene', compact && 'scene--compact')}>
      <div className="scene-floor">
        {rooms.map((room, i) => {
          const style = { '--n': room.who ? arrival++ : 0 } as CSSProperties
          return (
            <div key={i} className="scene-room" data-lit={room.who ? 'true' : undefined} data-knock={room.knock ? 'true' : undefined} style={style}>
              {room.who ? (
                <>
                  <span className="scene-light" />
                  <span className="scene-person">
                    <UserRound size={compact ? 15 : 17} strokeWidth={1.75} />
                    {room.who === 'busy' ? (
                      <span className="scene-badge">
                        <Moon size={9} strokeWidth={2.25} />
                      </span>
                    ) : null}
                  </span>
                  <span className="scene-door" />
                  {room.knock ? (
                    <span className="scene-knock">
                      <span className="scene-ring" />
                      <span className="scene-ring" />
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
          )
        })}
      </div>
      {compact ? null : (
        <div className="scene-status">
          <span className="scene-status-you">
            <UserRound size={13} strokeWidth={2} />
          </span>
          <span className="font-semibold">You</span>
          <span className="scene-status-dot" />
          <span className="scene-status-label">
            <span className="scene-status-away">Away</span>
            <span className="scene-status-online">Online</span>
          </span>
        </div>
      )}
    </div>
  )
}

/** A headline whose words rise in one after another. Read once, as a whole, by screen readers. */
export function RisingWords({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      <span className="sr-only">{text}</span>
      <span aria-hidden>
        {/* The space sits between the inline-blocks: inside one it would collapse. */}
        {text.split(' ').map((word, i) => (
          <Fragment key={i}>
            {i > 0 ? ' ' : null}
            <span className="word-rise" style={{ '--i': i } as CSSProperties}>
              {word}
            </span>
          </Fragment>
        ))}
      </span>
    </span>
  )
}
