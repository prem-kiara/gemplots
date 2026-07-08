import { Module } from '@nestjs/common';
import { AdminReadService } from './admin-read.service';
import { AdminReadController } from './admin-read.controller';
import { NotificationModule } from '../notification/notification.module';
import { BookingModule } from '../booking/booking.module';

/** Admin read surface (08 §7/§11, docs/10 §8.6): emails, bookings, audit logs, settings, summary. */
@Module({
  imports: [NotificationModule, BookingModule], // NotificationService (feed) + ExpiryService (repair)
  controllers: [AdminReadController],
  providers: [AdminReadService],
})
export class AdminModule {}
