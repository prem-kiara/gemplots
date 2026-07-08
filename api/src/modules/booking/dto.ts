import { IsString, Length } from 'class-validator';

/** POST /v1/reservations/{id}/confirm — verify the RESERVE OTP (08 §5 step 2). */
export class ConfirmReservationDto {
  @IsString() challenge_id!: string;
  @Length(6, 6) otp!: string;
}
