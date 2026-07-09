import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ControlledActionService } from './controlled-action.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { JwtUser } from '../auth/auth.types';
import { clientIp, reqId } from '../../common/http/request-context';
import {
  AdvanceCapDto,
  BulkPriceDto,
  CancelBookingDto,
  ExtendHoldDto,
  ForceStatusDto,
  PriceDto,
  PublishDto,
  SettingDto,
} from './controlled-action.dto';
import { Requester } from './approval.service';

/**
 * Maker (request) endpoints for the controlled actions (MC §1.1, §3). Each validates guardrails at
 * request time and files a PENDING approval — none mutate the target entity. All respond 202
 * {approval_id, status:'PENDING'}. Route @Roles matches the handler's makerRoles; the service
 * re-checks makerRoles as the backstop. AUDITOR (read-only) is never a maker.
 */
@Controller('v1/admin')
export class ControlledActionController {
  constructor(private readonly actions: ControlledActionService) {}

  private requester(u: JwtUser, req: Request): Requester {
    return { id: u.sub, role: u.role, requestId: reqId(req), ip: clientIp(req) ?? undefined };
  }

  @Roles('OPERATIONS')
  @Post('projects/:id/publish')
  @HttpCode(202)
  publish(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PublishDto,
  ) {
    return this.actions.requestPublish(id, dto.target, this.requester(u, req));
  }

  @Roles('OPERATIONS')
  @Post('projects/:id/advance-cap')
  @HttpCode(202)
  advanceCap(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: AdvanceCapDto,
  ) {
    return this.actions.requestAdvanceCap(id, dto.new_percentage, this.requester(u, req));
  }

  @Roles('OPERATIONS')
  @Post('projects/:id/bulk-price')
  @HttpCode(202)
  bulkPrice(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: BulkPriceDto,
  ) {
    return this.actions.requestBulkPrice(id, dto.items, this.requester(u, req));
  }

  @Roles('OPERATIONS', 'SALES')
  @Post('plots/:id/price')
  @HttpCode(202)
  price(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PriceDto,
  ) {
    return this.actions.requestPrice(id, dto.new_price_paise, this.requester(u, req));
  }

  @Roles('OPERATIONS')
  @Post('plots/:id/force-status')
  @HttpCode(202)
  forceStatus(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ForceStatusDto,
  ) {
    return this.actions.requestForceStatus(id, dto.new_status, dto.note ?? '', this.requester(u, req));
  }

  @Roles('SALES', 'OPERATIONS')
  @Post('bookings/:id/cancel')
  @HttpCode(202)
  cancel(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: CancelBookingDto,
  ) {
    return this.actions.requestCancel(id, dto.note, this.requester(u, req));
  }

  @Roles('SALES')
  @Post('bookings/:id/extend-hold')
  @HttpCode(202)
  extendHold(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ExtendHoldDto,
  ) {
    return this.actions.requestExtendHold(id, dto.extra_minutes, this.requester(u, req));
  }

  @Roles('SUPER_ADMIN')
  @Post('settings')
  @HttpCode(202)
  setting(@CurrentUser() u: JwtUser, @Req() req: Request, @Body() dto: SettingDto) {
    return this.actions.requestSetting(dto.key, dto.new_value, this.requester(u, req));
  }
}
