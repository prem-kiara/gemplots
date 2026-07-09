import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApprovalService } from './approval.service';
import { ApproveDto, RejectDto } from './dto';
import { CurrentUser, Roles } from '../auth/decorators';
import { JwtUser } from '../auth/auth.types';
import { clientIp, reqId } from '../../common/http/request-context';

@Controller('v1/admin/approvals')
export class ApprovalController {
  constructor(private readonly approvals: ApprovalService) {}

  // List + detail are readable by any admin role (AUDITOR/FINANCE included) — view only.
  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get()
  list(@Query('status') status?: string, @Query('action') action?: string) {
    return this.approvals.list({ status, action });
  }

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get(':id')
  detail(@Param('id') id: string) {
    return this.approvals.detail(id);
  }

  // Approve/reject accept the UNION of every action's approver roles at the route (roles guard);
  // the handler's approverRoles is the authoritative per-action gate (e.g. FINANCE may approve
  // CANCEL_BOOKING but not RESERVE_PLOT). AUDITOR (read-only) can never decide.
  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE')
  @Post(':id/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ApproveDto,
    @Req() req: Request,
  ) {
    return this.approvals.approve(
      id,
      { id: user.sub, role: user.role, requestId: reqId(req), ip: clientIp(req) ?? undefined },
      dto.note,
    );
  }

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE')
  @Post(':id/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: RejectDto,
    @Req() req: Request,
  ) {
    return this.approvals.reject(
      id,
      { id: user.sub, role: user.role, requestId: reqId(req), ip: clientIp(req) ?? undefined },
      dto.note,
    );
  }
}
