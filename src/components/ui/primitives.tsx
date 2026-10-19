import { forwardRef } from 'react'
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/* -------------------------------------------------------------------------
 * Button
 * One shape vocabulary for the whole app: pills. Primary is the brand dark
 * green (#007a37) with light text (5.2:1). Gold is never a text colour on a light surface; where the
 * brand wants gold on a CTA it appears as a hover fill behind dark ink.
 * ---------------------------------------------------------------------- */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
type ButtonSize = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-forest text-ivory hover:bg-gold hover:text-text-primary',
  secondary: 'bg-surface-raised text-text-primary hairline hover:bg-surface-sunken',
  ghost: 'bg-transparent text-text-secondary hover:bg-[var(--hover)] hover:text-text-primary',
  danger: 'bg-surface-raised text-state-danger hairline hover:bg-[var(--tint-danger)]',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, icon, className, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'press inline-flex shrink-0 items-center justify-center rounded-full font-semibold whitespace-nowrap',
        'transition-colors duration-150',
        'disabled:cursor-not-allowed disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  )
})

/* ------------------------------------------------------------------------- */

export function Label({
  htmlFor,
  children,
  className,
}: {
  htmlFor?: string
  children: ReactNode
  className?: string
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(
        'mb-1.5 block text-[11px] font-medium tracking-[0.08em] text-text-secondary uppercase',
        className,
      )}
    >
      {children}
    </label>
  )
}

const FIELD_BASE =
  'w-full rounded-[12px] border bg-surface-raised px-3 text-sm text-text-primary transition-colors duration-150 ' +
  'focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-not-allowed disabled:opacity-50'

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...props }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        FIELD_BASE,
        'h-9',
        invalid ? 'border-state-danger' : 'border-[var(--field-border)]',
        className,
      )}
      {...props}
    />
  )
})

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(FIELD_BASE, 'resize-y py-2 leading-relaxed', 'border-[var(--field-border)]', className)}
      {...props}
    />
  )
})

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        FIELD_BASE,
        'h-9 cursor-pointer appearance-none border-[var(--field-border)] pr-8',
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235A5A52' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")]",
        'bg-[length:12px] bg-[right_0.65rem_center] bg-no-repeat',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  )
})

/* -------------------------------------------------------------------------
 * Inline error. Sits next to what caused it, never as a toast the rep will
 * miss while looking at the control they just used.
 * ---------------------------------------------------------------------- */
export function FieldError({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <p role="alert" className="mt-1.5 text-[13px] text-state-danger">
      {children}
    </p>
  )
}

/* -------------------------------------------------------------------------
 * Skeleton. Matches the exact final geometry so nothing shifts on arrival.
 * ---------------------------------------------------------------------- */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-[8px]', className)} />
}

export function TableSkeleton({ rows = 8, columns = 8 }: { rows?: number; columns?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r} className="hairline-b h-11">
          {Array.from({ length: columns }).map((_, c) => (
            <td key={c} className="px-3">
              <Skeleton className={cn('h-3', c === 0 ? 'w-32' : 'w-16')} />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}

/* -------------------------------------------------------------------------
 * Empty state. Teaches the interface and offers the next action. Never
 * "No data available".
 * ---------------------------------------------------------------------- */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode
  title: string
  body?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      {icon ? <div className="mb-3 text-text-muted">{icon}</div> : null}
      <p className="text-[15px] font-medium text-text-primary">{title}</p>
      {body ? <p className="mt-1 max-w-sm text-sm text-text-muted">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  )
}
