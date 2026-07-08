/**
 * Email templates (08 §6). Each renders a subject + plain-text body from its payload.
 * Plain text is fine for Phase 1; tone is professional but warm, signed "— Gem Housing".
 */
export type EmailTemplate =
  | 'login_otp'
  | 'reserve_otp'
  | 'reservation_requested_admin'
  | 'reservation_received'
  | 'reservation_approved'
  | 'reservation_rejected'
  | 'reservation_expired';

export type EmailPayload = Record<string, any>;

export interface RenderedEmail {
  subject: string;
  bodyText: string;
}

/** Outcome the driver reports back so EmailService can record it in emails_outbox. */
export interface DriverResult {
  status: 'LOGGED' | 'SENT' | 'FAILED';
  error?: string;
}

/**
 * Invariant 11: every integration sits behind a driver interface with an offline default.
 * No module may import a vendor SDK outside its driver.
 */
export interface EmailDriver {
  deliver(
    toEmail: string,
    template: EmailTemplate,
    subject: string,
    bodyText: string,
    payload: EmailPayload,
  ): Promise<DriverResult>;
}
