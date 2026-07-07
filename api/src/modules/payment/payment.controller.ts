import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PaymentService } from './payment.service';
import { CreateOrderDto } from './dto';
import { CurrentUser, Public, Roles } from '../auth/decorators';
import { JwtUser } from '../auth/auth.types';
import { clientIp, reqId } from '../../common/http/request-context';

@Controller('v1')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Roles('CUSTOMER')
  @Post('bookings/:id/payment-order')
  @HttpCode(201)
  createOrder(
    @CurrentUser() user: JwtUser,
    @Param('id') bookingId: string,
    @Headers('idempotency-key') idemKey: string,
    @Body() dto: CreateOrderDto,
    @Req() req: Request,
  ) {
    return this.payments.createOrder(user.sub, bookingId, dto.amount_paise, idemKey, {
      requestId: reqId(req),
      ip: clientIp(req) ?? undefined,
    });
  }

  /** Public + signature-verified (CF §5). Uses the raw body captured in main.ts. */
  @Public()
  @Post('webhooks/payments/:gateway')
  async webhook(
    @Param('gateway') _gateway: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Res() res: Response,
  ) {
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const result = await this.payments.handleWebhook(raw, req.headers as any);
    res.status(result.http).json(result.body);
  }
}
