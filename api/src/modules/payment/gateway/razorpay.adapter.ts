import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import {
  CreateOrderInput,
  ParsedWebhook,
  PaymentGatewayAdapter,
} from './adapter';

/**
 * Razorpay adapter (CF §4.1). Amounts are in paise natively. Signature is HMAC-SHA256 of the
 * RAW body with PG_WEBHOOK_SECRET (Razorpay's documented scheme). The orders API call is left as
 * a TODO for the live integration; the shape and signing are production-correct.
 */
export class RazorpayAdapter implements PaymentGatewayAdapter {
  readonly name = 'RAZORPAY';

  private secret() {
    return process.env.PG_WEBHOOK_SECRET ?? 'whsec_dev';
  }

  async createOrder(i: CreateOrderInput): Promise<{ gatewayOrderId: string }> {
    // TODO(prod): POST https://api.razorpay.com/v1/orders with basic auth PG_KEY_ID:PG_KEY_SECRET,
    // body { amount: i.amountPaise, currency: 'INR', receipt: i.receipt, notes: i.notes }.
    return { gatewayOrderId: `order_${randomUUID().replace(/-/g, '').slice(0, 18)}` };
  }

  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, any>): boolean {
    const sig = String(headers['x-razorpay-signature'] ?? '');
    if (!sig) return false;
    const expected = createHmac('sha256', this.secret()).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(rawBody: Buffer): ParsedWebhook {
    const body = JSON.parse(rawBody.toString('utf8'));
    const entity =
      body?.payload?.payment?.entity ?? body?.payload?.payment ?? {};
    return {
      eventId: body?.id ?? body?.event_id ?? '',
      eventType: body?.event ?? '',
      gatewayPaymentId: entity?.id ?? '',
      gatewayOrderId: entity?.order_id ?? '',
      amountPaise: Number(entity?.amount ?? 0),
      currency: entity?.currency ?? 'INR',
      raw: body,
    };
  }
}
