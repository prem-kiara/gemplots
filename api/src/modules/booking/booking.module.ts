import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingReadService } from './booking-read.service';
import { ExpiryService } from './expiry.service';
import { BookingController } from './booking.controller';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [NotificationModule],
  controllers: [BookingController],
  providers: [BookingService, BookingReadService, ExpiryService],
  exports: [BookingService, BookingReadService, ExpiryService],
})
export class BookingModule {}
