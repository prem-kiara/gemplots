import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingReadService } from './booking-read.service';
import { ReservationService } from './reservation.service';
import { ExpiryService } from './expiry.service';
import { BookingController } from './booking.controller';
import { NotificationModule } from '../notification/notification.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [NotificationModule, AuthModule],
  controllers: [BookingController],
  providers: [BookingService, BookingReadService, ReservationService, ExpiryService],
  exports: [BookingService, BookingReadService, ExpiryService],
})
export class BookingModule {}
