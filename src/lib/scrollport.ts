/**
 * The one element in this app that scrolls.
 *
 * AppShell is `h-[100dvh] overflow-hidden` with a single `<main>` inside it
 * carrying `overflow-y-auto`. That means `window.scrollY` is ALWAYS 0 and
 * `window.scrollTo` does nothing - a fact worth stating loudly, because every
 * scroll-restoration recipe on the internet targets the window and would
 * silently no-op here. It is also why the browser's own scroll restoration
 * cannot help: there is no window scroll for it to restore.
 *
 * Referenced by id rather than by `document.querySelector('main')` so that a
 * second <main> appearing somewhere later cannot quietly steal the lookup.
 */
export const SCROLLPORT_ID = 'crm-scrollport'

/** Null before the shell mounts, and in tests. Every caller must handle that. */
export const scrollport = (): HTMLElement | null =>
  typeof document === 'undefined' ? null : document.getElementById(SCROLLPORT_ID)

/** Current offset, or 0 when the shell is not mounted. */
export const scrollportOffset = (): number => scrollport()?.scrollTop ?? 0
