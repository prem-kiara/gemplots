import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { CommonModule } from './common/common.module';
import { ErrorFilter } from './common/http/error.filter';
import { RequestIdMiddleware } from './common/http/request-context';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard, RolesGuard } from './modules/auth/guards';
import { HealthModule } from './modules/health/health.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { BookingModule } from './modules/booking/booking.module';
import { NotificationModule } from './modules/notification/notification.module';
import { ApprovalModule } from './modules/approval/approval.module';
import { AdminModule } from './modules/admin/admin.module';
import { PaymentModule } from './modules/payment/payment.module';

// Read the flag at module-definition time (08 §10). main.ts loads .env before importing this
// module, and tests set PAYMENTS_ENABLED in setup.ts before importing AppModule, so this is safe.
const paymentsEnabled = process.env.PAYMENTS_ENABLED === 'true';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    HealthModule,
    CatalogModule,
    BookingModule,
    NotificationModule,
    ApprovalModule,
    AdminModule,
    // PaymentModule is mounted only when PAYMENTS_ENABLED=true (Invariant 8, 08 §10). Default off:
    // the payment/webhook routes drop off the active surface and route-parity runs flag-off.
    ...(paymentsEnabled ? [PaymentModule] : []),
  ],
  providers: [
    { provide: APP_FILTER, useClass: ErrorFilter },
    { provide: APP_GUARD, useClass: JwtAuthGuard }, // runs first: authenticate
    { provide: APP_GUARD, useClass: RolesGuard }, // then authorize
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
