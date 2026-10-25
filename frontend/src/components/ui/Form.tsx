import React from 'react';

/* ── FormSection ─────────────────────────────────────────────────── */
interface FormSectionProps {
  title: string;
  children: React.ReactNode;
  first?: boolean;
}

export function FormSection({ title, children, first }: FormSectionProps) {
  return (
    <>
      <div className={`up-form-divider${first ? ' first' : ''}`}>{title}</div>
      {children}
    </>
  );
}

/* ── FormRow ─────────────────────────────────────────────────────── */
interface FormRowProps {
  children: React.ReactNode;
  single?: boolean;
  triple?: boolean;
}

export function FormRow({ children, single, triple }: FormRowProps) {
  let cls = 'up-form-row';
  if (single) cls += ' single';
  if (triple) cls += ' triple';
  return <div className={cls}>{children}</div>;
}

/* ── FormField ───────────────────────────────────────────────────── */
interface FormFieldProps {
  label: string;
  /** Inline after the label text, e.g. an info popover explaining the field. */
  labelExtra?: React.ReactNode;
  hint?: string;
  /** A server-side field error for this control (an ApiError's fieldErrors() entry). */
  error?: string;
  required?: boolean;
  children: React.ReactNode;
  htmlFor?: string;
}

export function FormField({ label, labelExtra, hint, error, required, children, htmlFor }: FormFieldProps) {
  return (
    <div className="up-form-group">
      <label htmlFor={htmlFor}>
        {label}{required && <span className="ui-required"> *</span>}{labelExtra}
      </label>
      {children}
      {hint && <span className="up-hint">{hint}</span>}
      {error && <span className="up-field-error" role="alert">{error}</span>}
    </div>
  );
}
