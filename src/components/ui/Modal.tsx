import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One modal shell for the whole app, so two dialogs can never drift apart.
 * Modals keep transform-origin at centre: unlike a popover they are not
 * anchored to a trigger, so scaling from a corner would be a lie about where
 * they came from.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  onCloseAutoFocus,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  className?: string
  /**
   * Radix returns focus to the trigger on close. When the action removes the
   * trigger (a "Mark opted out" button that no longer applies), focus would
   * land on <body>; this lets the caller name somewhere real instead.
   */
  onCloseAutoFocus?: (event: Event) => void
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="anim-overlay-in fixed inset-0 z-30 bg-[var(--scrim)]" />
        <Dialog.Content
          // Marks an open modal for anything that must live inside it while it
          // is up (the office check-in, CheckinLayer): outside it, a screen
          // reader is told to ignore the page and focus cannot reach it.
          data-modal=""
          onCloseAutoFocus={onCloseAutoFocus}
          className={cn(
            'anim-modal-in fixed top-1/2 left-1/2 z-40 w-[calc(100vw-2rem)] max-w-[520px]',
            '-translate-x-1/2 -translate-y-1/2 rounded-[14px] bg-surface',
            'shadow-[var(--shadow-md)]',
            'max-h-[calc(100dvh-4rem)] overflow-y-auto',
            className,
          )}
        >
          <div className="hairline-b flex items-start justify-between gap-4 px-5 py-4">
            <div>
              <Dialog.Title className="text-[16px] leading-tight font-semibold">
                {title}
              </Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-[13px] text-text-muted">
                  {description}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="press -mt-1 -mr-1 flex items-center justify-center rounded-[8px] p-1.5 text-text-muted transition-colors duration-150 hover:bg-[var(--hover)] hover:text-text-primary max-sm:size-11"
            >
              <X size={16} strokeWidth={1.75} />
            </Dialog.Close>
          </div>

          <div className="px-5 py-4">{children}</div>

          {footer ? (
            <div className="hairline-t flex items-center justify-end gap-2 px-5 py-3.5">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
