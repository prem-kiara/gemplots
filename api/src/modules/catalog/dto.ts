import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProjectDto {
  @IsString() name!: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() address_line?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsArray() amenities?: string[];
  @IsOptional() @IsBoolean() rera_registered?: boolean;
  @IsOptional() @IsString() rera_number?: string;
  @IsOptional() @IsNumber() max_advance_percentage?: number;
  @IsOptional() @IsInt() hold_minutes_override?: number;
}

export class PatchProjectDto {
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() address_line?: string;
  @IsOptional() @IsString() district?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() pincode?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
  @IsOptional() @IsArray() amenities?: string[];
}

export class UploadMapDto {
  @IsString() image_base64!: string;
  @IsString() content_type!: string;
  @IsInt() @Min(1) width_px!: number;
  @IsInt() @Min(1) height_px!: number;
}

class GeometryDto {
  @IsString() plot_id!: string;
  @IsArray() polygon!: number[][];
  @IsArray() centroid!: number[];
}
export class PutGeometriesDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => GeometryDto)
  geometries!: GeometryDto[];
}
