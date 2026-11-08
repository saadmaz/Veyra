'use client';

import Link from 'next/link';
import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useId,
} from 'react';
import { errorMessage } from '@/lib/messages';

/*
 * Shared console UI. Accessibility (WCAG 2.2 AA): every input has a visible label; hints and
 * errors are linked with aria-describedby; invalid fields set aria-invalid; errors are announced
 * through role="alert", progress through role="status"; focus rings are always visible.
 */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
};

export function Button({
  variant = 'primary',
  busy = false,
  disabled,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`button button--${variant}${className ? ` ${className}` : ''}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  children,
  variant = 'primary',
}: {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary';
}) {
  return (
    <Link href={href} className={`button button--${variant}`}>
      {children}
    </Link>
  );
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  error?: string | undefined;
};

export function TextField({ label, hint, error, id, className, ...rest }: FieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label htmlFor={inputId} className="field__label">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      <input
        {...rest}
        id={inputId}
        className="field__input"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      />
      {error ? (
        <p id={errorId} className="field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  id,
  children,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  const generated = useId();
  const selectId = id ?? generated;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  return (
    <div className="field">
      <label htmlFor={selectId} className="field__label">
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="field__hint">
          {hint}
        </p>
      ) : null}
      <select
        {...rest}
        id={selectId}
        className="field__input"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
      >
        {children}
      </select>
      {error ? (
        <p id={errorId} className="field__error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Alert({
  tone = 'danger',
  title,
  children,
}: {
  tone?: 'danger' | 'success' | 'info';
  title?: string;
  children: ReactNode;
}) {
  // Errors interrupt (alert); confirmations are announced politely (status).
  return (
    <div className={`alert alert--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title ? <p className="alert__title">{title}</p> : null}
      <div>{children}</div>
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner spinner--large" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state">
      <Alert>{errorMessage(error)}</Alert>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <h2 className="empty__title">{title}</h2>
      {children ? <p className="empty__body">{children}</p> : null}
      {action}
    </div>
  );
}

export function Card({
  title,
  children,
  actions,
}: {
  title?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="card" aria-label={title}>
      {title || actions ? (
        <header className="card__header">
          {title ? <h2 className="card__title">{title}</h2> : <span />}
          {actions}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'ACTIVE' || status === 'ACCEPTED'
      ? 'success'
      : status === 'PENDING' || status === 'SUSPENDED'
        ? 'warning'
        : 'muted';
  return <span className={`badge badge--${tone}`}>{status.toLowerCase().replace('_', ' ')}</span>;
}
