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
import { PaymentModule } from './modules/payment/payment.module';

@Module({
  imports: [
    CommonModule,
    AuthModule,
    HealthModule,
    CatalogModule,
    BookingModule,
    PaymentModule,
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
