import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingReadService } from './booking-read.service';
import { ReservationService } from './reservation.service';
import { ExpiryService } from './expiry.service';
import { ReminderService } from './reminder.service';
import { BookingController } from './booking.controller';
import { NotificationModule } from '../notification/notification.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [NotificationModule, AuthModule],
  controllers: [BookingController],
  providers: [BookingService, BookingReadService, ReservationService, ExpiryService, ReminderService],
  exports: [BookingService, BookingReadService, ExpiryService, ReminderService],
})
export class BookingModule {}
