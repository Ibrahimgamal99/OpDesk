import React from 'react';

/* Shared modal-form primitives (ported from echo). They render onto the
   existing `up-form-*` CSS in styles/index.css so modal forms across the
   admin panels share one layout. */

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
}

export function FormRow({ children, single }: FormRowProps) {
  return <div className={`up-form-row${single ? ' single' : ''}`}>{children}</div>;
}

/* ── FormField ───────────────────────────────────────────────────── */
interface FormFieldProps {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
  htmlFor?: string;
}

export function FormField({ label, hint, required, children, htmlFor }: FormFieldProps) {
  return (
    <div className="up-form-group">
      <label htmlFor={htmlFor}>
        {label}{required && <span className="ui-required"> *</span>}
      </label>
      {children}
      {hint && <span className="up-hint">{hint}</span>}
    </div>
  );
}
