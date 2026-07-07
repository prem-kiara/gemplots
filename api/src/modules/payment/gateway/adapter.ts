/**
 * The ONLY gateway-specific seam (CF §4.1). Swapping Razorpay → Cashfree/PayU = a new adapter
 * class + env change; nothing else in the codebase changes.
 */
export interface CreateOrderInput {
  amountPaise: number;
  currency: 'INR';
  receipt: string;
  notes: Record<string, string>;
}

export interface ParsedWebhook {
  eventId: string;
  eventType: 'payment.captured' | 'payment.failed' | string;
  gatewayPaymentId: string;
  gatewayOrderId: string;
  amountPaise: number;
  currency: string;
  raw: any;
}

export interface PaymentGatewayAdapter {
  readonly name: string;
  createOrder(i: CreateOrderInput): Promise<{ gatewayOrderId: string }>;
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, any>): boolean;
  parseWebhook(rawBody: Buffer): ParsedWebhook;
  /** For reconciliation (CF §7). */
  listPayments?(fromIso: string, toIso: string): Promise<
    { gatewayPaymentId: string; amountPaise: number; status: string }[]
  >;
}

export const GATEWAY = Symbol('PaymentGatewayAdapter');
