import { Controller, Get, Query } from '@nestjs/common';
import { AdminReadService } from './admin-read.service';
import { Roles } from '../auth/decorators';

/**
 * Admin read surface (08 §7/§11, docs/10 §8.6). Emails + bookings are readable by any admin role.
 * Audit logs + settings are SUPER_ADMIN + AUDITOR (API §5.7). Dashboard summary is any admin role.
 */
@Controller('v1/admin')
export class AdminReadController {
  constructor(private readonly reads: AdminReadService) {}

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get('emails')
  emails(
    @Query('to') to?: string,
    @Query('template') template?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reads.emails({ to, template, cursor, limit: limit ? Number(limit) : undefined });
  }

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get('bookings')
  bookings(
    @Query('status') status?: string,
    @Query('project_id') projectId?: string,
    @Query('email') email?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reads.bookings({
      status,
      project_id: projectId,
      email,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Roles('SUPER_ADMIN', 'AUDITOR')
  @Get('audit-logs')
  auditLogs(
    @Query('entity_type') entityType?: string,
    @Query('entity_id') entityId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reads.auditLogs({
      entity_type: entityType,
      entity_id: entityId,
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Roles('SUPER_ADMIN', 'AUDITOR')
  @Get('settings')
  settings() {
    return this.reads.settings();
  }

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get('dashboard/summary')
  dashboardSummary() {
    return this.reads.dashboardSummary();
  }
}
