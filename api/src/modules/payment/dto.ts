import { IsInt, Min } from 'class-validator';

export class CreateOrderDto {
  @IsInt() @Min(1) amount_paise!: number;
}
