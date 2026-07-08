'use client';
import { CheckIcon } from './icons';

// §6: horizontal 4-step progress. `current` is the active (1-based) step; earlier are done.
export function Stepper({
  steps,
  current,
  failed = false,
}: {
  steps: string[];
  current: number;
  failed?: boolean;
}) {
  return (
    <ol className="flex items-center">
      {steps.map((label, i) => {
        const step = i + 1;
        const done = step < current;
        const active = step === current;
        const isFailedHere = failed && active;
        return (
          <li key={label} className="flex flex-1 items-center last:flex-none">
            <div className="flex flex-col items-center">
              <span
                className={`flex h-7 w-7 items-center justify-center rounded-full text-gp-sm font-semibold ${
                  isFailedHere
                    ? 'bg-danger text-white'
                    : done
                      ? 'bg-primary text-white'
                      : active
                        ? 'border-2 border-primary text-primary'
                        : 'border border-line text-muted'
                }`}
              >
                {done ? <CheckIcon width={14} height={14} /> : step}
              </span>
              <span
                className={`mt-1 hidden text-center text-[11px] sm:block ${
                  active ? 'font-semibold text-ink' : 'text-muted'
                }`}
              >
                {label}
              </span>
            </div>
            {step < steps.length && (
              <div className={`mx-1 h-0.5 flex-1 ${done ? 'bg-primary' : 'bg-line'}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
