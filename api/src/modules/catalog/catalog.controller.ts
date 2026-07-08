import { Controller, Get, Param, Query } from '@nestjs/common';
import { CatalogReadService } from './catalog-read.service';
import { Public } from '../auth/decorators';

/** Customer read APIs — all public (API §3). */
@Controller('v1')
export class CatalogController {
  constructor(private readonly reads: CatalogReadService) {}

  @Public()
  @Get('projects')
  listProjects(@Query('district') district?: string, @Query('state') state?: string) {
    return this.reads.listProjects({ district, state });
  }

  @Public()
  @Get('projects/:idOrSlug')
  getProject(@Param('idOrSlug') idOrSlug: string) {
    return this.reads.getProject(idOrSlug);
  }

  @Public()
  @Get('projects/:id/map')
  getMap(@Param('id') id: string) {
    return this.reads.getProjectMap(id);
  }

  @Public()
  @Get('plots/:id')
  getPlot(@Param('id') id: string) {
    return this.reads.getPlot(id);
  }
}
