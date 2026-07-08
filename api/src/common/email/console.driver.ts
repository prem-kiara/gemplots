import { Injectable, Logger } from '@nestjs/common';
import {
  DriverResult,
  EmailDriver,
  EmailPayload,
  EmailTemplate,
} from './email.types';

/**
 * Default offline driver (08 §6): logs via the Nest Logger and reports LOGGED. The portal's
 * outbox viewer is the demo-mode "sent mail". Never throws.
 */
@Injectable()
export class ConsoleDriver implements EmailDriver {
  private readonly logger = new Logger('Email');

  async deliver(
    toEmail: string,
    template: EmailTemplate,
    subject: string,
    _bodyText: string,
    _payload: EmailPayload,
  ): Promise<DriverResult> {
    this.logger.log(`[${template}] → ${toEmail}: ${subject}`);
    return { status: 'LOGGED' };
  }
}
