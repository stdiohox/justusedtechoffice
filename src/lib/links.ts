/**
 * Links handed in as proof, on a report or a task (0016: up to 5; before it,
 * one). The server tidies and checks them again (office_links); these only
 * say what is wrong before anything is sent or uploaded.
 */

export const MAX_LINKS = 5
export const HTTP_LINK = /^https?:\/\/\S+$/i

/** As the server keeps them: trimmed, blanks dropped, a repeat kept once. */
export function tidyLinks(links: string[]): string[] {
  return [...new Set(links.map((l) => l.trim()).filter(Boolean))]
}

/** What is wrong with the links typed, or null. */
export function linksProblem(links: string[]): string | null {
  const tidy = tidyLinks(links)
  if (tidy.length > MAX_LINKS) return `Add up to ${MAX_LINKS} links.`
  if (tidy.some((l) => !HTTP_LINK.test(l))) return 'Each link must start with http:// or https://.'
  return null
}

/** A row's links: the list (0016), or the one link filed before it. */
export function linksOf(list: string[] | null | undefined, single: string | null | undefined): string[] {
  return list?.length ? list : single ? [single] : []
}
