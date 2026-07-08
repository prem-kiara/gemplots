import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';
import { StorageService } from '../../common/storage/storage.service';
import { Err } from '../../common/errors';
import { effectiveCapPct } from '../../common/util';
import { ExpiryService } from '../booking/expiry.service';

/** Canonical UUID shape (docs/10 §5.3.1): a match → id lookup, else treat the value as a slug. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Customer read APIs (API §3). Every read runs lazy repair (CF §3.3) so statuses are truthful. */
@Injectable()
export class CatalogReadService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    private readonly expiry: ExpiryService,
  ) {}

  async listProjects(filters: { district?: string; state?: string }) {
    const params: any[] = [];
    let where = `pr.status='PUBLISHED'`;
    if (filters.district) {
      params.push(filters.district);
      where += ` AND pr.district=$${params.length}`;
    }
    if (filters.state) {
      params.push(filters.state);
      where += ` AND pr.state=$${params.length}`;
    }
    const rows = (
      await this.db.query(
        `SELECT pr.*,
                (SELECT count(*) FROM plots p WHERE p.project_id=pr.id) AS total,
                (SELECT count(*) FROM plots p WHERE p.project_id=pr.id AND p.status='AVAILABLE') AS available,
                (SELECT min(price_paise) FROM plots p WHERE p.project_id=pr.id) AS min_price,
                (SELECT max(price_paise) FROM plots p WHERE p.project_id=pr.id) AS max_price,
                (SELECT image_key FROM site_maps s WHERE s.project_id=pr.id AND s.is_active) AS cover_key
           FROM projects pr WHERE ${where} ORDER BY pr.created_at DESC`,
        params,
      )
    ).rows;
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      district: r.district,
      state: r.state,
      rera_registered: r.rera_registered,
      rera_number: r.rera_number,
      price_range_paise: {
        min: r.min_price != null ? Number(r.min_price) : null,
        max: r.max_price != null ? Number(r.max_price) : null,
      },
      plot_counts: { total: Number(r.total), available: Number(r.available) },
      cover_image_url: r.cover_key ? this.storage.signedGetUrl(r.cover_key) : null,
      amenities: r.amenities,
    }));
  }

  /** Detail by UUID or slug (docs/10 §5.3.1): a UUID matches the id column, else the slug. */
  async getProject(idOrSlug: string) {
    const byId = UUID_RE.test(idOrSlug);
    const pr = (
      await this.db.query(
        `SELECT * FROM projects WHERE ${byId ? 'id' : 'slug'}=$1 AND status='PUBLISHED'`,
        [idOrSlug],
      )
    ).rows[0];
    if (!pr) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');
    const id = pr.id;
    const counts = (
      await this.db.query(
        `SELECT status, count(*)::int AS n FROM plots WHERE project_id=$1 GROUP BY status`,
        [id],
      )
    ).rows.reduce((acc: any, r: any) => ({ ...acc, [r.status]: r.n }), {});
    const holdMinutes =
      pr.hold_minutes_override ?? (await this.config.int('global_hold_minutes'));
    return {
      id: pr.id,
      name: pr.name,
      slug: pr.slug,
      description: pr.description,
      address_line: pr.address_line,
      district: pr.district,
      state: pr.state,
      pincode: pr.pincode,
      lat: pr.lat,
      lng: pr.lng,
      amenities: pr.amenities,
      rera_registered: pr.rera_registered,
      rera_number: pr.rera_number,
      max_advance_percentage: Number(pr.max_advance_percentage),
      effective_advance_cap_pct: effectiveCapPct(Number(pr.max_advance_percentage), pr.rera_registered),
      hold_minutes: holdMinutes,
      plot_counts: counts,
    };
  }

  async getProjectMap(projectId: string) {
    const map = (
      await this.db.query(`SELECT * FROM site_maps WHERE project_id=$1 AND is_active`, [projectId])
    ).rows[0];
    if (!map) throw Err.notFound('MAP_NOT_FOUND', 'No active site map');

    // Lazy repair every plot on this map before reporting statuses (CF §3.3).
    const plotIds = (
      await this.db.query<{ plot_id: string }>(
        `SELECT plot_id FROM plot_geometries WHERE site_map_id=$1`,
        [map.id],
      )
    ).rows.map((r) => r.plot_id);
    await this.expiry.repairPlots(plotIds);

    const plots = (
      await this.db.query(
        `SELECT g.plot_id, g.polygon, g.centroid,
                p.plot_number, p.status, p.area_sqft, p.price_paise, p.facing
           FROM plot_geometries g JOIN plots p ON p.id=g.plot_id
          WHERE g.site_map_id=$1 ORDER BY p.plot_number`,
        [map.id],
      )
    ).rows;

    return {
      map_version: map.version,
      image_url: this.storage.signedGetUrl(map.image_key),
      width_px: map.width_px,
      height_px: map.height_px,
      plots: plots.map((p) => ({
        plot_id: p.plot_id,
        plot_number: p.plot_number,
        status: p.status,
        polygon: p.polygon,
        centroid: p.centroid,
        area_sqft: Number(p.area_sqft),
        price_paise: Number(p.price_paise),
        facing: p.facing,
      })),
    };
  }

  async getPlot(plotId: string) {
    await this.expiry.repairPlots([plotId]);
    const p = (
      await this.db.query(
        `SELECT p.*, pr.status AS project_status FROM plots p
           JOIN projects pr ON pr.id=p.project_id WHERE p.id=$1`,
        [plotId],
      )
    ).rows[0];
    if (!p || p.project_status !== 'PUBLISHED')
      throw Err.notFound('PLOT_NOT_FOUND', 'Plot not found');

    const out: any = {
      id: p.id,
      project_id: p.project_id,
      plot_number: p.plot_number,
      facing: p.facing,
      dimensions_text: p.dimensions_text,
      area_sqft: Number(p.area_sqft),
      price_paise: Number(p.price_paise),
      status: p.status,
      attributes: p.attributes,
    };
    if (p.status === 'BLOCKED') {
      const hold = (
        await this.db.query(
          `SELECT expires_at FROM bookings
            WHERE plot_id=$1 AND status='BLOCKED' ORDER BY blocked_at DESC LIMIT 1`,
          [plotId],
        )
      ).rows[0];
      if (hold) out.blocked_until = new Date(hold.expires_at).toISOString();
    } else if (p.status === 'ON_HOLD') {
      // Reserve-flow hold: surface the active booking's decision/verification deadline so the
      // customer plot sheet can render "on hold until …" (docs/10 §7.3).
      const hold = (
        await this.db.query(
          `SELECT expires_at FROM bookings
            WHERE plot_id=$1 AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')
            ORDER BY blocked_at DESC LIMIT 1`,
          [plotId],
        )
      ).rows[0];
      if (hold) out.blocked_until = new Date(hold.expires_at).toISOString();
    }
    return out;
  }
}
