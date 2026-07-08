import { Module } from '@nestjs/common';
import { NotificationService } from './notification.service';
import {
  AdminNotificationController,
  MeNotificationController,
} from './notification.controller';

@Module({
  controllers: [AdminNotificationController, MeNotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
