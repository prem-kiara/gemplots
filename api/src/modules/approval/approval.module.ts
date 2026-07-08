import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ReservePlotHandler } from './reserve-plot.handler';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [NotificationModule],
  controllers: [ApprovalController],
  providers: [ApprovalService, ReservePlotHandler],
  exports: [ApprovalService],
})
export class ApprovalModule {}
