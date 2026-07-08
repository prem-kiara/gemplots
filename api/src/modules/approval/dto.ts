import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ApproveDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

/** Reject requires a note (MC §1.6). */
export class RejectDto {
  @IsString() @MinLength(1) @MaxLength(1000) note!: string;
}
