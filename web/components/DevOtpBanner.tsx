'use client';
import { S } from '@/lib/strings';

// §6: amber ribbon shown only when a dev_otp is present. Tap fills the OTP.
export function DevOtpBanner({
  email,
  otp,
  onFill,
}: {
  email: string;
  otp: string;
  onFill?: (otp: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onFill?.(otp)}
      className="w-full rounded-control border border-accent/40 bg-accent/10 px-3 py-2 text-left text-gp-sm text-[#92400e] transition hover:bg-accent/20"
    >
      {S.dev.otpFor(email)}: <span className="font-bold tracking-widest">{otp}</span>
      {onFill && <span className="ml-1 text-[#b45309]">({S.dev.tapToFill})</span>}
    </button>
  );
}
