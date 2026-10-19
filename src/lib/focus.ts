/**
 * Somewhere real for keyboard focus when the control that had it disappears
 * (the office's sign-out and "I'm back" swap whole cards). Kept out of the
 * components so the files that export components export only components.
 */

/** Marks the "You're signed out" heading, the first place to land. */
export const SIGNED_OUT_HEADING = 'data-signed-out-heading'

/** The topmost open modal (Modal.tsx marks its content data-modal), or null. */
export function findOpenModal(): HTMLElement | null {
  const open = document.querySelectorAll<HTMLElement>('[data-modal][data-state="open"]')
  return open.length ? open[open.length - 1] : null
}

/** The signed-out heading if it is on screen, else the page's main region. */
export function focusFallback() {
  const heading = document.querySelector<HTMLElement>(`[${SIGNED_OUT_HEADING}]`)
  const target = heading ?? document.querySelector<HTMLElement>('main')
  if (!target) return
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
}
