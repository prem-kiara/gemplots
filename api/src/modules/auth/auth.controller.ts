import {
  Body,
  Controller,
  HttpCode,
  Post,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from './decorators';
import {
  AdminLoginDto,
  DeviceTokenDto,
  OtpRequestDto,
  OtpVerifyDto,
  RefreshDto,
} from './dto';
import { JwtUser } from './auth.types';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  async otpRequest(@Body() dto: OtpRequestDto) {
    const r = await this.auth.requestOtp(dto.phone);
    return { challenge_id: r.challengeId, retry_after_seconds: r.retryAfterSeconds };
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  otpVerify(@Body() dto: OtpVerifyDto) {
    return this.auth.verifyOtp(dto.challenge_id, dto.phone, dto.otp);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refresh_token);
  }

  @Public()
  @Post('admin/login')
  @HttpCode(200)
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.auth.adminLogin(dto.email, dto.password);
  }
}

@Controller('v1/me')
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Post('device-tokens')
  @HttpCode(204)
  async deviceToken(@CurrentUser() user: JwtUser, @Body() dto: DeviceTokenDto) {
    await this.auth.registerDeviceToken(user.sub, dto.fcm_token, dto.platform);
  }
}
