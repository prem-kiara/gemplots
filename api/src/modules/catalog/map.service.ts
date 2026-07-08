import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditService, AuditActor } from '../../common/audit/audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { NotificationService } from '../notification/notification.service';
import { Err } from '../../common/errors';

@Injectable()
export class MapService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly notify: NotificationService,
  ) {}

  async uploadMap(
    actor: AuditActor,
    projectId: string,
    image: Buffer,
    contentType: string,
    widthPx: number,
    heightPx: number,
  ) {
    const project = (await this.db.query(`SELECT id FROM projects WHERE id=$1`, [projectId]))
      .rows[0];
    if (!project) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');
    const version =
      Number(
        (
          await this.db.query(
            `SELECT COALESCE(max(version),0)+1 AS v FROM site_maps WHERE project_id=$1`,
            [projectId],
          )
        ).rows[0].v,
      ) || 1;
    const key = `site-maps/${projectId}/v${version}`;
    await this.storage.putObject(key, image, contentType);
    return this.db.tx(async (tx) => {
      const m = (
        await tx.query(
          `INSERT INTO site_maps (project_id, version, image_key, width_px, height_px, is_active)
           VALUES ($1,$2,$3,$4,$5,false) RETURNING *`,
          [projectId, version, key, widthPx, heightPx],
        )
      ).rows[0];
      await this.audit.log(tx, actor, 'sitemap.upload', 'project', projectId, null, {
        version,
        site_map_id: m.id,
      });
      return { site_map_id: m.id, version, image_url: this.storage.signedGetUrl(key) };
    });
  }

  /** Full replace of geometries for a map (API §5.2). Validates coords, ownership, dedup. */
  async putGeometries(
    actor: AuditActor,
    siteMapId: string,
    geometries: { plot_id: string; polygon: number[][]; centroid: number[] }[],
  ) {
    const map = (await this.db.query(`SELECT * FROM site_maps WHERE id=$1`, [siteMapId])).rows[0];
    if (!map) throw Err.notFound('MAP_NOT_FOUND', 'Site map not found');

    const seen = new Set<string>();
    for (const g of geometries) {
      if (seen.has(g.plot_id))
        throw Err.badRequest('VALIDATION_FAILED', `duplicate plot_id ${g.plot_id}`);
      seen.add(g.plot_id);
      if (!Array.isArray(g.polygon) || g.polygon.length < 3)
        throw Err.badRequest('VALIDATION_FAILED', 'polygon needs >= 3 points');
      for (const pt of g.polygon)
        if (!inUnit(pt))
          throw Err.badRequest('VALIDATION_FAILED', 'polygon coords must be in [0,1]');
      if (!inUnit(g.centroid))
        throw Err.badRequest('VALIDATION_FAILED', 'centroid must be in [0,1]');
    }
    // All plots must belong to this map's project.
    const plotIds = geometries.map((g) => g.plot_id);
    if (plotIds.length) {
      const ok = Number(
        (
          await this.db.query(
            `SELECT count(*)::int AS n FROM plots WHERE id = ANY($1) AND project_id=$2`,
            [plotIds, map.project_id],
          )
        ).rows[0].n,
      );
      if (ok !== plotIds.length)
        throw Err.badRequest('VALIDATION_FAILED', 'some plot_id not in this project');
    }

    return this.db.tx(async (tx) => {
      await tx.query(`DELETE FROM plot_geometries WHERE site_map_id=$1`, [siteMapId]);
      for (const g of geometries) {
        await tx.query(
          `INSERT INTO plot_geometries (site_map_id, plot_id, polygon, centroid)
           VALUES ($1,$2,$3,$4)`,
          [siteMapId, g.plot_id, JSON.stringify(g.polygon), JSON.stringify(g.centroid)],
        );
      }
      await this.audit.log(tx, actor, 'sitemap.geometries', 'site_map', siteMapId, null, {
        count: geometries.length,
      });
      return { site_map_id: siteMapId, count: geometries.length };
    });
  }

  /** Activate a map version, guarding that every non-WITHDRAWN plot has a geometry (API §5.2). */
  async activate(actor: AuditActor, siteMapId: string) {
    const map = (await this.db.query(`SELECT * FROM site_maps WHERE id=$1`, [siteMapId])).rows[0];
    if (!map) throw Err.notFound('MAP_NOT_FOUND', 'Site map not found');

    const missing = (
      await this.db.query<{ id: string }>(
        `SELECT p.id FROM plots p
          WHERE p.project_id=$1 AND p.status <> 'WITHDRAWN'
            AND NOT EXISTS (SELECT 1 FROM plot_geometries g
                             WHERE g.site_map_id=$2 AND g.plot_id=p.id)`,
        [map.project_id, siteMapId],
      )
    ).rows.map((r) => r.id);
    if (missing.length)
      throw Err.conflict('MAP_INCOMPLETE', 'Some plots have no geometry', {
        missing_plot_ids: missing,
      });

    const result = await this.db.tx(async (tx) => {
      await tx.query(`UPDATE site_maps SET is_active=false WHERE project_id=$1 AND is_active`, [
        map.project_id,
      ]);
      await tx.query(`UPDATE site_maps SET is_active=true WHERE id=$1`, [siteMapId]);
      await this.audit.log(tx, actor, 'sitemap.activate', 'site_map', siteMapId, null, {
        version: map.version,
      });
      return { site_map_id: siteMapId, version: map.version, active: true };
    });

    // Admin feed event (08 §7) — best-effort, never rolls back the activation.
    const project = (
      await this.db.query(`SELECT name FROM projects WHERE id=$1`, [map.project_id])
    ).rows[0];
    await this.notify.feed(
      'ADMIN',
      'MAP_ACTIVATED',
      `Site map v${map.version} activated for ${project?.name ?? 'a project'}`,
      '',
      'site_map',
      siteMapId,
    );
    return result;
  }
}

function inUnit(pt: number[]): boolean {
  return (
    Array.isArray(pt) &&
    pt.length === 2 &&
    pt.every((n) => typeof n === 'number' && n >= 0 && n <= 1)
  );
}
