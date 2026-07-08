'use client';
import { useEffect, useRef, useState } from 'react';

// §6: 6 boxes, auto-advance, paste-splits, backspace-retreats; onComplete(code).
export function OtpInput({
  onComplete,
  onChange,
  disabled = false,
  autoFocus = true,
  value,
}: {
  onComplete: (code: string) => void;
  onChange?: (code: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  value?: string; // controlled fill (e.g. tap-to-fill dev OTP)
}) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  // Controlled external fill.
  useEffect(() => {
    if (value != null) {
      const next = value.padEnd(6, ' ').slice(0, 6).split('').map((c) => (c === ' ' ? '' : c));
      setDigits(next);
      if (value.length === 6) onComplete(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    if (autoFocus) refs.current[0]?.focus();
  }, [autoFocus]);

  function emit(next: string[]) {
    setDigits(next);
    const code = next.join('');
    onChange?.(code);
    if (code.length === 6 && next.every((d) => d !== '')) onComplete(code);
  }

  function handleChange(i: number, v: string) {
    const char = v.replace(/\D/g, '').slice(-1);
    const next = [...digits];
    next[i] = char;
    emit(next);
    if (char && i < 5) refs.current[i + 1]?.focus();
  }

  function handleKey(i: number, e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Backspace' && !digits[i] && i > 0) {
      refs.current[i - 1]?.focus();
    }
    if (e.key === 'ArrowLeft' && i > 0) refs.current[i - 1]?.focus();
    if (e.key === 'ArrowRight' && i < 5) refs.current[i + 1]?.focus();
  }

  function handlePaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;
    e.preventDefault();
    const next = pasted.padEnd(6, ' ').split('').map((c) => (c === ' ' ? '' : c));
    emit(next);
    const focusIdx = Math.min(pasted.length, 5);
    refs.current[focusIdx]?.focus();
  }

  return (
    <div className="flex justify-center gap-2" onPaste={handlePaste}>
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          inputMode="numeric"
          maxLength={1}
          value={d}
          disabled={disabled}
          aria-label={`Digit ${i + 1}`}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKey(i, e)}
          className="h-12 w-11 rounded-control border border-line text-center text-gp-xl font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
        />
      ))}
    </div>
  );
}
