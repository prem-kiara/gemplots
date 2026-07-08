import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { BookingService } from './booking.service';
import { BookingReadService } from './booking-read.service';
import { ReservationService } from './reservation.service';
import { ConfirmReservationDto } from './dto';
import { CurrentUser, Roles } from '../auth/decorators';
import { JwtUser } from '../auth/auth.types';
import { clientIp, reqId } from '../../common/http/request-context';

@Controller('v1')
export class BookingController {
  constructor(
    private readonly booking: BookingService,
    private readonly reads: BookingReadService,
    private readonly reservations: ReservationService,
  ) {}

  // Status is set explicitly on the response (passthrough) so a replay can return 200 while a
  // fresh reservation returns 201. A fixed @HttpCode(201) would override the replay status.
  @Roles('CUSTOMER')
  @Post('plots/:id/reserve')
  async reserve(
    @CurrentUser() user: JwtUser,
    @Param('id') plotId: string,
    @Headers('idempotency-key') idemKey: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.booking.reserve(user.sub, plotId, idemKey, {
      requestId: reqId(req),
      ip: clientIp(req) ?? undefined,
    });
    const { replay, ...body } = r;
    if (replay) {
      res.status(200);
      res.setHeader('Idempotency-Replay', 'true');
    } else {
      res.status(201);
    }
    return body;
  }

  @Roles('CUSTOMER')
  @Post('reservations/:id/confirm')
  @HttpCode(200)
  confirm(
    @CurrentUser() user: JwtUser,
    @Param('id') bookingId: string,
    @Body() dto: ConfirmReservationDto,
    @Req() req: Request,
  ) {
    return this.reservations.confirm(bookingId, dto.challenge_id, dto.otp, { id: user.sub }, {
      requestId: reqId(req),
      ip: clientIp(req) ?? undefined,
    });
  }

  @Roles('CUSTOMER')
  @Post('reservations/:id/resend-otp')
  @HttpCode(200)
  resendOtp(@CurrentUser() user: JwtUser, @Param('id') bookingId: string) {
    return this.reservations.resendOtp(bookingId, { id: user.sub });
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
