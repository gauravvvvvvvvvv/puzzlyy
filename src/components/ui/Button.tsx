/**
 * Buttons and the tiny primitives that go with them.
 *
 * One place decides what a Puzzly control looks and feels like, so a button in
 * the lobby and a button on the board are recognisably the same object. Every
 * variant is at least 44px tall in its default size (spec §24: touch targets),
 * carries a visible focus ring from `globals.css`, and dims rather than
 * disappears when disabled.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import Link from 'next/link';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const BASE =
  'relative inline-flex select-none items-center justify-center gap-2 rounded-md font-medium ' +
  'transition-[transform,background-color,border-color,color,opacity] duration-150 ' +
  'ease-[var(--ease-out-soft)] active:translate-y-px ' +
  'disabled:pointer-events-none disabled:opacity-45';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-fg)] border border-transparent ' +
    'hover:brightness-[1.07] shadow-[var(--shadow-soft)]',
  secondary:
    'bg-[var(--surface)] text-[var(--fg)] border border-[var(--line-strong)] ' +
    'hover:bg-[var(--surface-2)] hover:border-[var(--line-strong)]',
  ghost:
    'bg-transparent text-[var(--fg-muted)] border border-transparent ' +
    'hover:bg-[var(--surface-inset)] hover:text-[var(--fg)]',
  danger:
    'bg-transparent text-[var(--color-danger-400)] border border-[var(--line)] ' +
    'hover:bg-[color-mix(in_oklab,var(--color-danger-500)_14%,transparent)]',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm rounded-sm',
  md: 'h-11 px-4 text-[0.9375rem]',
  lg: 'h-13 px-6 text-base rounded-lg',
};

export function buttonClass(
  variant: ButtonVariant = 'secondary',
  size: ButtonSize = 'md',
  extra = '',
): string {
  return [BASE, VARIANTS[variant], SIZES[size], extra].filter(Boolean).join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}

export interface ButtonLinkProps {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: ReactNode;
  prefetch?: boolean;
  'aria-label'?: string;
}

export function ButtonLink({
  href,
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {children}
    </Link>
  );
}

/**
 * A square icon-only control. Separate from `Button` because the accessible name
 * has to come from `label` — an icon button with no name is invisible to a
 * screen reader, and the tooltip is a nice side effect of the same string.
 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  variant?: ButtonVariant;
  children: ReactNode;
  /** Shrink to 36px. Only for dense desktop toolbars, never on touch. */
  compact?: boolean;
}

export function IconButton({
  label,
  variant = 'ghost',
  compact = false,
  className = '',
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={[
        BASE,
        VARIANTS[variant],
        compact ? 'h-9 w-9 rounded-sm' : 'h-11 w-11',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Small status/metadata pill. */
export function Pill({
  children,
  tone = 'neutral',
  className = '',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'good' | 'warn';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-[var(--surface-inset)] text-[var(--fg-muted)] border-[var(--line)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)] border-[color-mix(in_oklab,var(--accent)_28%,transparent)]',
    good: 'bg-[color-mix(in_oklab,var(--color-mint-500)_16%,transparent)] text-[var(--color-mint-400)] border-[color-mix(in_oklab,var(--color-mint-500)_30%,transparent)]',
    warn: 'bg-[color-mix(in_oklab,var(--color-butter-400)_16%,transparent)] text-[var(--color-butter-400)] border-[color-mix(in_oklab,var(--color-butter-400)_30%,transparent)]',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-2xs font-semibold tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
