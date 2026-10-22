import { useRef } from 'react'
import { ExternalLink, Plus, X } from 'lucide-react'
import { Button, Input, Label } from '@/components/ui/primitives'
import { TOUCH } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { HTTP_LINK, MAX_LINKS } from '@/lib/links'

/**
 * Typing links. With `multi` (0016 applied): one box to start and "Add
 * another link", up to 5. Without it: the one box there was before.
 */
export function LinksField({
  id,
  links,
  onChange,
  multi,
}: {
  id: string
  links: string[]
  onChange: (links: string[]) => void
  multi: boolean
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([])
  const focusBox = (k: number) => requestAnimationFrame(() => boxes.current[k]?.focus())
  const rows = links.length ? links : ['']

  if (!multi) {
    return (
      <div>
        <Label htmlFor={`${id}-link`}>Link (optional)</Label>
        <Input
          id={`${id}-link`}
          type="url"
          inputMode="url"
          placeholder="https://"
          maxLength={2000}
          value={rows[0]}
          onChange={(e) => onChange([e.target.value])}
          className={TOUCH}
        />
      </div>
    )
  }

  return (
    <div role="group" aria-labelledby={`${id}-links-label`} aria-describedby={`${id}-links-hint`}>
      <p id={`${id}-links-label`} className="mb-1.5 text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase">
        Links (optional)
      </p>
      <ul className="space-y-2">
        {rows.map((value, k) => (
          <li key={k} className="flex items-center gap-1.5">
            <Input
              ref={(el) => {
                boxes.current[k] = el
              }}
              type="url"
              inputMode="url"
              placeholder="https://"
              maxLength={2000}
              aria-label={`Link ${k + 1}`}
              value={value}
              onChange={(e) => onChange(rows.map((v, j) => (j === k ? e.target.value : v)))}
              className={TOUCH}
            />
            {rows.length > 1 ? (
              <button
                type="button"
                aria-label={`Remove link ${k + 1}`}
                onClick={() => {
                  onChange(rows.filter((_, j) => j !== k))
                  focusBox(Math.max(0, k - 1))
                }}
                className="press flex size-9 shrink-0 items-center justify-center rounded-[8px] text-text-muted hover:bg-hover hover:text-text-primary max-sm:size-11"
              >
                <X size={14} aria-hidden />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length < MAX_LINKS ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn('mt-1.5', TOUCH)}
          icon={<Plus size={14} strokeWidth={1.75} />}
          onClick={() => {
            onChange([...rows, ''])
            focusBox(rows.length)
          }}
        >
          Add another link
        </Button>
      ) : null}
      <p id={`${id}-links-hint`} className="mt-1 text-[12px] text-text-muted">
        Up to {MAX_LINKS} links, each starting with http:// or https://.
      </p>
    </div>
  )
}

/** Links handed in, each opening in a new tab. Only http(s) ever becomes an href. */
export function LinkList({ links, className }: { links: string[]; className?: string }) {
  const safe = links.filter((l) => HTTP_LINK.test(l))
  if (!safe.length) return null
  return (
    <ul className={cn('mt-1 space-y-0.5', className)} aria-label={safe.length > 1 ? 'Links' : undefined}>
      {safe.map((l) => (
        <li key={l}>
          <a
            href={l}
            target="_blank"
            rel="noopener noreferrer"
            className="flex max-w-full items-center gap-1.5 font-semibold text-brand underline-offset-2 hover:underline max-sm:min-h-11"
          >
            <ExternalLink size={13} strokeWidth={1.75} className="shrink-0" aria-hidden />
            <span className="truncate">{l}</span>
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  )
}
