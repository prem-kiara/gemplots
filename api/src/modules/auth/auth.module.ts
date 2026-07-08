import { Module } from '@nestjs/common';
import { AuthController, MeController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [NotificationModule],
  controllers: [AuthController, MeController],
  providers: [AuthService, OtpService, TokenService],
  exports: [AuthService, TokenService, OtpService],
})
export class AuthModule {}
