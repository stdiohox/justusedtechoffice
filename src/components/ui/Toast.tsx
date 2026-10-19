import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToastType } from '@/stores/toastStore'

const TONES: Record<ToastType, string> = {
  success: 'bg-forest text-ivory',
  info: 'bg-ink text-ivory',
  error: 'bg-state-danger text-ivory',
}

/**
 * Sits above the mobile tab bar and clear of the bulk-action bar, which is
 * bottom-centre. role="status" so a screen reader hears the arrival without
 * losing the reader's place, which role="alert" would do.
 */
export function Toast({
  message,
  type,
  onClose,
}: {
  message: string
  type: ToastType
  onClose: () => void
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'anim-toast-in fixed right-4 bottom-20 z-50 flex max-w-[320px] items-center gap-3',
        'rounded-[14px] px-4 py-3 text-sm shadow-[var(--shadow-lg)]',
        'md:bottom-6',
        TONES[type],
      )}
    >
      <span className="min-w-0 flex-1">{message}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Dismiss notification"
        className="press -mr-1 shrink-0 rounded-[8px] p-1 text-current opacity-60 transition-opacity duration-150 hover:opacity-100"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  )
}
