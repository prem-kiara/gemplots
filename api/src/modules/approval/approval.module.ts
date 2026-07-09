import { Module } from '@nestjs/common';
import { ApprovalController } from './approval.controller';
import { ApprovalService } from './approval.service';
import { ControlledActionController } from './controlled-action.controller';
import { ControlledActionService } from './controlled-action.service';
import { ReservePlotHandler } from './reserve-plot.handler';
import { UpdatePlotPriceHandler } from './handlers/update-plot-price.handler';
import { ForcePlotStatusHandler } from './handlers/force-plot-status.handler';
import { CancelBookingHandler } from './handlers/cancel-booking.handler';
import { ExtendHoldHandler } from './handlers/extend-hold.handler';
import { PublishProjectHandler } from './handlers/publish-project.handler';
import { UpdateAdvanceCapHandler } from './handlers/update-advance-cap.handler';
import { BulkPriceUpdateHandler } from './handlers/bulk-price-update.handler';
import { UpdateGlobalSettingHandler } from './handlers/update-global-setting.handler';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [NotificationModule],
  controllers: [ApprovalController, ControlledActionController],
  providers: [
    ApprovalService,
    ControlledActionService,
    ReservePlotHandler,
    UpdatePlotPriceHandler,
    ForcePlotStatusHandler,
    CancelBookingHandler,
    ExtendHoldHandler,
    PublishProjectHandler,
    UpdateAdvanceCapHandler,
    BulkPriceUpdateHandler,
    UpdateGlobalSettingHandler,
  ],
  exports: [ApprovalService],
})
export class ApprovalModule {}
