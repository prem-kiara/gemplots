import {
  Body,
  Controller,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { ProjectService } from './project.service';
import { PlotService } from './plot.service';
import { MapService } from './map.service';
import { CurrentUser, Roles } from '../auth/decorators';
import { JwtUser } from '../auth/auth.types';
import { AuditActor } from '../../common/audit/audit.service';
import { clientIp, reqId } from '../../common/http/request-context';
import { Err } from '../../common/errors';
import {
  CreateProjectDto,
  PatchProjectDto,
  PutGeometriesDto,
  UploadMapDto,
} from './dto';

function actorOf(user: JwtUser, req: Request): AuditActor {
  return { id: user.sub, role: user.role, requestId: reqId(req), ip: clientIp(req) };
}

@Controller('v1/admin')
export class AdminCatalogController {
  constructor(
    private readonly projects: ProjectService,
    private readonly plots: PlotService,
    private readonly maps: MapService,
  ) {}

  @Roles('OPERATIONS', 'SUPER_ADMIN')
  @Post('projects')
  @HttpCode(201)
  createProject(@CurrentUser() u: JwtUser, @Req() req: Request, @Body() dto: CreateProjectDto) {
    return this.projects.create(actorOf(u, req), dto);
  }

  @Roles('OPERATIONS', 'SUPER_ADMIN')
  @Patch('projects/:id')
  patchProject(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: PatchProjectDto,
  ) {
    return this.projects.patch(actorOf(u, req), id, dto);
  }

  /** CSV bulk upload. Body is raw CSV text (Content-Type text/csv) or {csv} JSON.
   *  Production wires multipart; this keeps it dependency-light + testable (API §5.1). */
  @Roles('OPERATIONS', 'SUPER_ADMIN')
  @Post('projects/:id/plots:bulk')
  @HttpCode(201)
  async bulkPlots(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') projectId: string,
    @Query('dry_run') dryRun: string,
    @Body() body: any,
  ) {
    const csv = typeof body === 'string' ? body : body?.csv;
    if (!csv || typeof csv !== 'string')
      throw Err.badRequest('VALIDATION_FAILED', 'csv text required');
    return this.plots.bulkUpload(actorOf(u, req), projectId, csv, dryRun === 'true');
  }

  @Roles('OPERATIONS', 'SUPER_ADMIN')
  @Post('projects/:id/site-maps')
  @HttpCode(201)
  uploadMap(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') projectId: string,
    @Body() dto: UploadMapDto,
  ) {
    const buf = Buffer.from(dto.image_base64, 'base64');
    return this.maps.uploadMap(actorOf(u, req), projectId, buf, dto.content_type, dto.width_px, dto.height_px);
  }

  @Roles('OPERATIONS', 'SUPER_ADMIN')
  @Post('site-maps/:id/geometries')
  @HttpCode(200)
  putGeometries(
    @CurrentUser() u: JwtUser,
    @Req() req: Request,
    @Param('id') siteMapId: string,
    @Body() dto: PutGeometriesDto,
  ) {
    return this.maps.putGeometries(actorOf(u, req), siteMapId, dto.geometries);
  }

  @Roles('OPERATIONS', 'SUPER_ADMIN')
  @Post('site-maps/:id/activate')
  @HttpCode(200)
  activate(@CurrentUser() u: JwtUser, @Req() req: Request, @Param('id') siteMapId: string) {
    return this.maps.activate(actorOf(u, req), siteMapId);
  }
}
