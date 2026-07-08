import { EmailPayload, EmailTemplate, RenderedEmail } from './email.types';

const SIGNATURE = '\n\n— Gem Housing';

/**
 * Renders subject + plain-text body for each template (08 §6). Missing payload fields render as
 * empty rather than throwing — email is a side effect and must never break a business flow.
 */
export function renderEmail(template: EmailTemplate, payload: EmailPayload): RenderedEmail {
  const p = payload ?? {};
  switch (template) {
    case 'login_otp':
      return {
        subject: 'Your Gem Housing login code',
        bodyText:
          `Hello,\n\nYour Gem Housing login code is ${p.otp}. ` +
          `It is valid for a short while — please enter it to sign in.\n\n` +
          `If you did not request this, you can safely ignore this email.` +
          SIGNATURE,
      };
    case 'reserve_otp':
      return {
        subject: `Confirm your reservation for plot ${p.plot_number}`,
        bodyText:
          `Hello,\n\nTo confirm your interest in plot ${p.plot_number}, ` +
          `please enter this code: ${p.otp}.\n\n` +
          `Once confirmed, our team will review your request shortly.` +
          SIGNATURE,
      };
    case 'reservation_requested_admin':
      return {
        subject: `Action needed: reservation request for plot ${p.plot_number}`,
        bodyText:
          `A customer has requested a reservation and is awaiting approval.\n\n` +
          `Customer: ${p.customer_email}\n` +
          `Project:  ${p.project_name}\n` +
          `Plot:     ${p.plot_number}\n` +
          `Approval: ${p.approval_id}\n\n` +
          `Please review and decide in the admin portal.` +
          SIGNATURE,
      };
    case 'reservation_received':
      return {
        subject: `We've received your reservation for plot ${p.plot_number}`,
        bodyText:
          `Hello,\n\nThank you — we've received your reservation request for plot ` +
          `${p.plot_number}. Our team is reviewing it and will get back to you soon.\n\n` +
          `We appreciate your interest in Gem Housing.` +
          SIGNATURE,
      };
    case 'reservation_approved':
      return {
        subject: `Good news — plot ${p.plot_number} is reserved for you`,
        bodyText:
          `Hello,\n\nGreat news! Your reservation for plot ${p.plot_number} in ` +
          `${p.project_name} has been approved and the plot is now reserved for you.\n\n` +
          `Our team will reach out with the next steps.` +
          SIGNATURE,
      };
    case 'reservation_rejected':
      return {
        subject: `Update on your reservation for plot ${p.plot_number}`,
        bodyText:
          `Hello,\n\nThank you for your interest in plot ${p.plot_number}. ` +
          `After review, we're unable to proceed with this reservation at the moment.\n\n` +
          `Note: ${p.note}\n\n` +
          `Please feel free to explore other available plots — we'd be glad to help.` +
          SIGNATURE,
      };
    case 'reservation_expired':
      return {
        subject: `Your reservation for plot ${p.plot_number} has expired`,
        bodyText:
          `Hello,\n\nThe reservation window for plot ${p.plot_number} has passed, ` +
          `so the plot has been released and is available again.\n\n` +
          `You're welcome to start a new reservation any time.` +
          SIGNATURE,
      };
    default:
      // Faithful fallback: never throw on an unknown template.
      return {
        subject: 'Gem Housing notification',
        bodyText: `Hello,\n\nThis is a notification from Gem Housing.${SIGNATURE}`,
      };
  }
}
