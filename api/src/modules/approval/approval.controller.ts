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

  // Approve/reject are restricted to the RESERVE_PLOT approver roles at the route (roles guard),
  // with the handler's approverRoles as the backstop. FINANCE + AUDITOR cannot decide (08 §5).
  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES')
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

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES')
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
