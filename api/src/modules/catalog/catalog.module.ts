import { Module } from '@nestjs/common';
import { ProjectService } from './project.service';
import { PlotService } from './plot.service';
import { MapService } from './map.service';
import { CatalogReadService } from './catalog-read.service';
import { CatalogController } from './catalog.controller';
import { AdminCatalogController } from './admin-catalog.controller';
import { BookingModule } from '../booking/booking.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [BookingModule, NotificationModule], // ExpiryService (lazy repair) + feed events
  controllers: [CatalogController, AdminCatalogController],
  providers: [ProjectService, PlotService, MapService, CatalogReadService],
  exports: [ProjectService, PlotService, MapService],
})
export class CatalogModule {}
