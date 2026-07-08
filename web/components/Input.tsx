'use client';
import { useId } from 'react';
import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helper?: string;
}

export function Input({ label, error, helper, className = '', id, ...rest }: InputProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-gp-sm font-semibold text-ink">
          {label}
        </label>
      )}
      <input
        id={inputId}
        aria-invalid={!!error}
        className={`min-h-[44px] rounded-control border px-3 py-2 text-gp-base text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-primary ${
          error ? 'border-danger' : 'border-line'
        } ${className}`}
        {...rest}
      />
      {error ? (
        <p className="text-gp-sm text-danger" aria-live="polite">
          {error}
        </p>
      ) : helper ? (
        <p className="text-gp-sm text-muted">{helper}</p>
      ) : null}
    </div>
  );
}

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
}

export function TextArea({ label, error, className = '', id, ...rest }: TextAreaProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="flex flex-col gap-1">
      {label && (
        <label htmlFor={inputId} className="text-gp-sm font-semibold text-ink">
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        aria-invalid={!!error}
        className={`min-h-[80px] rounded-control border px-3 py-2 text-gp-base text-ink outline-none transition focus-visible:ring-2 focus-visible:ring-primary ${
          error ? 'border-danger' : 'border-line'
        } ${className}`}
        {...rest}
      />
      {error && (
        <p className="text-gp-sm text-danger" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
