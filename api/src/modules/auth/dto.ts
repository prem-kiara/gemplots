import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

const E164 = /^\+[1-9]\d{7,14}$/;

export class OtpRequestDto {
  @IsEmail({}, { message: 'email must be a valid email address' })
  email!: string;
}

export class OtpVerifyDto {
  @IsString() challenge_id!: string;
  @IsEmail() email!: string;
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

/** PATCH /me — customer profile completion (08 §9). Both fields optional. */
export class ProfileUpdateDto {
  @IsOptional() @IsString() @MaxLength(120) full_name?: string;
  @IsOptional() @Matches(E164, { message: 'phone must be E.164' }) phone?: string;
}
