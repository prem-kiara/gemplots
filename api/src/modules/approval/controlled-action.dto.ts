import {
  Allow,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class PublishDto {
  @IsIn(['PUBLISHED', 'PAUSED', 'ARCHIVED']) target!: string;
}

export class PriceDto {
  @IsInt() @Min(1) new_price_paise!: number;
}

export class ForceStatusDto {
  @IsIn(['AVAILABLE', 'WITHDRAWN', 'SOLD']) new_status!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class CancelBookingDto {
  @IsString() @MaxLength(1000) note!: string;
}

export class ExtendHoldDto {
  @IsInt() @Min(30) extra_minutes!: number;
}

export class AdvanceCapDto {
  @IsNumber() @Min(0) new_percentage!: number;
}

class BulkPriceItemDto {
  @IsString() plot_id!: string;
  @IsInt() @Min(1) new_price_paise!: number;
}

export class BulkPriceDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => BulkPriceItemDto)
  items!: BulkPriceItemDto[];
}

export class SettingDto {
  @IsString() @MaxLength(100) key!: string;
  // new_value may be a number or string; validated per-key by the handler whitelist. @Allow keeps
  // it through the whitelisting ValidationPipe (which strips undecorated properties).
  @Allow() new_value!: any;
}
