import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { BookingModule } from '../booking/booking.module';
import { NotificationModule } from '../notification/notification.module';
import { GATEWAY } from './gateway/adapter';
import { RazorpayAdapter } from './gateway/razorpay.adapter';

/** PAYMENT_GATEWAY selects the adapter; Razorpay is the only one wired today (CF §4.1). */
@Module({
  imports: [BookingModule, NotificationModule],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    {
      provide: GATEWAY,
      useFactory: () => {
        switch (process.env.PAYMENT_GATEWAY ?? 'RAZORPAY') {
          case 'RAZORPAY':
          default:
            return new RazorpayAdapter();
        }
      },
    },
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
