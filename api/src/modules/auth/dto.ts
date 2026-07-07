import { IsIn, IsString, Matches, Length } from 'class-validator';

const E164 = /^\+[1-9]\d{7,14}$/;

export class OtpRequestDto {
  @Matches(E164, { message: 'phone must be E.164' })
  phone!: string;
}

export class OtpVerifyDto {
  @IsString() challenge_id!: string;
  @Matches(E164) phone!: string;
  @Length(6, 6) otp!: string;
}

export class RefreshDto {
  @IsString() refresh_token!: string;
}

export class AdminLoginDto {
  @IsString() email!: string;
  @IsString() password!: string;
}

export class DeviceTokenDto {
  @IsString() fcm_token!: string;
  @IsIn(['android', 'ios']) platform!: string;
}
