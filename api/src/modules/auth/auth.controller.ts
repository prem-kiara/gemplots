import {
  Body,
  Controller,
  HttpCode,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { CurrentUser, Public, Roles } from './decorators';
import {
  AdminLoginDto,
  DeviceTokenDto,
  OtpRequestDto,
  OtpVerifyDto,
  ProfileUpdateDto,
  RefreshDto,
} from './dto';
import { JwtUser } from './auth.types';
import { clientIp, reqId } from '../../common/http/request-context';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @HttpCode(200)
  async otpRequest(@Body() dto: OtpRequestDto) {
    const r = await this.auth.requestOtp(dto.email);
    return {
      challenge_id: r.challengeId,
      retry_after_seconds: r.retryAfterSeconds,
      // Invariant 12: only present in console mode + non-production.
      ...(r.devOtp !== undefined ? { dev_otp: r.devOtp } : {}),
    };
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  otpVerify(@Body() dto: OtpVerifyDto) {
    return this.auth.verifyOtp(dto.challenge_id, dto.email, dto.otp);
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

  @Roles('CUSTOMER')
  @Patch()
  async updateProfile(
    @CurrentUser() user: JwtUser,
    @Body() dto: ProfileUpdateDto,
    @Req() req: Request,
  ) {
    return this.auth.updateProfile(
      user.sub,
      { full_name: dto.full_name, phone: dto.phone },
      { requestId: reqId(req), ip: clientIp(req) ?? undefined },
    );
  }

  @Post('device-tokens')
  @HttpCode(204)
  async deviceToken(@CurrentUser() user: JwtUser, @Body() dto: DeviceTokenDto) {
    await this.auth.registerDeviceToken(user.sub, dto.fcm_token, dto.platform);
  }
}
