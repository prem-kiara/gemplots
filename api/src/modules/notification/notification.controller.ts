import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { JwtUser } from '../auth/auth.types';

/**
 * Admin notification feed (08 §7, docs/10 §8.6/§8.7). All routes are any-admin-role (AUDITOR may
 * read AND may mark read — the read state is a shared UX flag, not a controlled action). The bell
 * polls /count every 30 s; read/read-all clear the shared unread state.
 */
@Controller('v1/admin/notifications')
export class AdminNotificationController {
  constructor(private readonly notify: NotificationService) {}

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get()
  list(
    @Query('unread') unread?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notify.listAdmin({
      unread: unread === 'true',
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Get('count')
  async count() {
    return { unread: await this.notify.adminUnreadCount() };
  }

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Post(':id/read')
  @HttpCode(204)
  async read(@Param('id') id: string) {
    await this.notify.markAdminRead(id);
  }

  @Roles('SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR')
  @Post('read-all')
  @HttpCode(204)
  async readAll() {
    await this.notify.markAllAdminRead();
  }
}

/** Customer's own notices (08 §7). audience CUSTOMER, user_id = caller. */
@Controller('v1/me/notifications')
export class MeNotificationController {
  constructor(private readonly notify: NotificationService) {}

  @Roles('CUSTOMER')
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notify.listCustomer(user.sub, {
      cursor,
      limit: limit ? Number(limit) : undefined,
    });
  }
}
