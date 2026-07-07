import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { BookingService } from './booking.service';
import { BookingReadService } from './booking-read.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { JwtUser } from '../auth/auth.types';
import { clientIp, reqId } from '../../common/http/request-context';

@Controller('v1')
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly reads: BookingReadService,
  ) {}

  @Roles('CUSTOMER')
  @Post('plots/:id/block')
  @HttpCode(201)
  async block(
    @CurrentUser() user: JwtUser,
    @Param('id') plotId: string,
    @Headers('idempotency-key') idemKey: string,
    @Req() req: Request,
  ) {
    const r = await this.booking.block(user.sub, plotId, idemKey, {
      requestId: reqId(req),
      ip: clientIp(req) ?? undefined,
    });
    // A replay returns 200 per API §1.4; Nest sets 201 above, so override via passthrough.
    if (r.replay) req.res?.status(200).setHeader('Idempotency-Replay', 'true');
    const { replay, ...body } = r;
    return body;
  }

  @Roles('CUSTOMER', 'SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get('bookings/:id')
  getBooking(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.reads.getById(id, { id: user.sub, role: user.role });
  }

  @Roles('CUSTOMER')
  @Get('me/bookings')
  listMine(
    @CurrentUser() user: JwtUser,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.reads.listMine(user.sub, limit ? Number(limit) : 20, cursor);
  }
}
