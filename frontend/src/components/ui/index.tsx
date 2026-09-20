import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

/** Tailwind class joiner. No dependency needed for something this small. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/* ── Button ────────────────────────────────────────────────────────────────────
 * Always a real <button> (or <a> via `asChild`-free composition) so Enter, Space,
 * focus order and screen-reader semantics come for free. `pending` disables it AND
 * announces the change, but the caller must still guard the mutation itself — a
 * disabled button is not proof of one request. See sendQuick in server.py for what
 * happens when you trust the attribute instead.
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-[var(--color-accent)] text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] ' +
    'disabled:hover:bg-[var(--color-accent)]',
  secondary:
    'bg-[var(--color-surface-2)] text-[var(--color-fg)] border border-[var(--color-border-strong)] ' +
    'hover:bg-[var(--color-surface-3)]',
  ghost: 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]',
  danger:
    'bg-transparent text-[var(--color-danger-text)] border border-[var(--color-danger)]/50 ' +
    'hover:bg-[var(--color-danger)]/12',
}

const SIZE: Record<Size, string> = {
  // min-h rather than fixed h, so text at 200% zoom grows the button instead of
  // overflowing it.
  sm: 'min-h-8 px-3 text-sm rounded-[var(--radius-sm)]',
  md: 'min-h-10 px-4 text-sm rounded-[var(--radius-md)]',
  lg: 'min-h-[var(--tap-target)] px-5 text-base rounded-[var(--radius-md)]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  pending?: boolean
  /** Replaces the label while pending. Defaults to keeping the label. */
  pendingLabel?: string
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', pending = false, pendingLabel, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      // type defaults to "submit" inside a form, which submits the form by accident.
      type={rest.type ?? 'button'}
      disabled={disabled || pending}
      // aria-busy is what a screen reader uses to say "working"; the visual spinner
      // is not announced.
      aria-busy={pending || undefined}
      className={cx(
        'inline-flex items-center justify-center gap-2 font-semibold',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'disabled:opacity-55 disabled:cursor-default select-none',
        VARIANT[variant],
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {pending && <Spinner />}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  )
})

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  )
}

/* ── Card ─────────────────────────────────────────────────────────────────── */
export function Card({
  children,
  className,
  as: As = 'div',
}: {
  children: ReactNode
  className?: string
  as?: 'div' | 'section' | 'article' | 'li'
}) {
  return (
    <As
      className={cx(
        'rounded-[var(--radius-lg)] border border-[var(--color-border)]',
        'bg-[var(--color-surface-1)]',
        className,
      )}
    >
      {children}
    </As>
  )
}

/* ── Section heading ──────────────────────────────────────────────────────────
 * Takes an explicit level so the document outline stays correct wherever it is used.
 * A heading that looks right but is an <h4> under an <h2> is a screen-reader bug.
 */
export function SectionHeading({
  children,
  level = 2,
  action,
  hint,
}: {
  children: ReactNode
  level?: 2 | 3 | 4
  action?: ReactNode
  hint?: ReactNode
}) {
  const H = `h${level}` as 'h2' | 'h3' | 'h4'
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <H className="text-xl font-bold tracking-tight">{children}</H>
        {hint && <span className="text-xs text-[var(--color-fg-subtle)]">{hint}</span>}
      </div>
      {action}
    </div>
  )
}

/* ── Badge ─────────────────────────────────────────────────────────────────── */
const TONE = {
  neutral: 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-border-strong)]',
  live: 'bg-[var(--color-live)]/12 text-[var(--color-live-text)] border-[var(--color-live)]/35',
  warn: 'bg-[var(--color-warn)]/12 text-[var(--color-warn-text)] border-[var(--color-warn)]/35',
  danger: 'bg-[var(--color-danger)]/12 text-[var(--color-danger-text)] border-[var(--color-danger)]/35',
  accent: 'bg-[var(--color-accent)]/14 text-[var(--color-accent-text)] border-[var(--color-accent)]/35',
} as const

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: keyof typeof TONE
  className?: string
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-full)] border px-2 py-0.5',
        'text-2xs font-semibold uppercase tracking-wide',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A presence dot. Colour is never the only signal — it is always beside a label. */
export function StatusDot({ live, className }: { live: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'inline-block size-2 shrink-0 rounded-full',
        live ? 'bg-[var(--color-live)]' : 'bg-[var(--color-fg-subtle)]',
        className,
      )}
    />
  )
}

/* ── Text input ───────────────────────────────────────────────────────────────
 * `label` is required. An input without an accessible name is the single most common
 * finding in an audit of a codebase like this one, and making it optional is how that
 * happens. Pass `hideLabel` when the design calls for a placeholder-only field — the
 * label still exists for assistive technology.
 */
export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string
  hideLabel?: boolean
  id: string
  hint?: string
  error?: string | null
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hideLabel, id, hint, error, className, ...rest },
  ref,
) {
  const hintId = hint ? `${id}-hint` : undefined
  const errId = error ? `${id}-error` : undefined
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={cx(
          'text-sm font-semibold text-[var(--color-fg-muted)]',
          hideLabel && 'sr-only',
        )}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        aria-describedby={cx(hintId, errId) || undefined}
        aria-invalid={error ? true : undefined}
        className={cx(
          'min-h-[var(--tap-target)] w-full rounded-[var(--radius-md)] px-3.5',
          'border bg-[var(--color-surface-2)] text-base text-[var(--color-fg)]',
          'placeholder:text-[var(--color-fg-subtle)]',
          error ? 'border-[var(--color-danger)]' : 'border-[var(--color-border-strong)]',
          className,
        )}
        {...rest}
      />
      {hint && (
        <p id={hintId} className="text-xs text-[var(--color-fg-subtle)]">
          {hint}
        </p>
      )}
      {error && (
        <p id={errId} className="text-xs text-[var(--color-danger-text)]">
          {error}
        </p>
      )}
    </div>
  )
})
