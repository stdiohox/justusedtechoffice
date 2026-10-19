import { useState, type ReactNode } from 'react'
import { usePhotoUrl } from '@/hooks/usePhotos'
import { cn } from '@/lib/utils'

/**
 * A person's profile photo (0007) in place of their initials. `children` is
 * the initials exactly as the caller drew them before, so with no photo, a
 * photo that fails to load, or 0007 not applied, nothing changes on screen.
 *
 * The photo fills the caller's circle: pass the same size classes the
 * initials used. Decorative (alt=""): the name is always beside it.
 */
export function Photo({
  userId,
  className,
  eager,
  children,
}: {
  userId: string | null | undefined
  className?: string
  /** For the header and sidebar, which are always on screen. */
  eager?: boolean
  children: ReactNode
}) {
  const url = usePhotoUrl(userId)
  const [broken, setBroken] = useState<string | null>(null)
  if (!url || broken === url) return <>{children}</>
  return (
    <img
      src={url}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onError={() => setBroken(url)}
      className={cn('shrink-0 rounded-full object-cover', className)}
    />
  )
}
