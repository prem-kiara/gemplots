import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditService, AuditActor } from '../../common/audit/audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { Err } from '../../common/errors';
import { slugify } from '../../common/util';

@Injectable()
export class ProjectService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  /**
   * GET /admin/projects — every project regardless of status (the public list is PUBLISHED-only,
   * so DRAFTs a P6 admin just created would be invisible). Newest first; optional status filter.
   */
  async adminList(status?: string) {
    const params: any[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE pr.status=$1`;
    }
    const rows = (
      await this.db.query(
        `SELECT pr.id, pr.name, pr.slug, pr.status, pr.district, pr.state,
                pr.rera_registered, pr.created_at,
                (SELECT count(*)::int FROM plots p WHERE p.project_id=pr.id) AS plot_count
           FROM projects pr ${where} ORDER BY pr.created_at DESC`,
        params,
      )
    ).rows;
    return {
      items: rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        status: r.status,
        district: r.district,
        state: r.state,
        rera_registered: r.rera_registered,
        plot_count: Number(r.plot_count),
        created_at: new Date(r.created_at).toISOString(),
      })),
    };
  }

  /**
   * GET /admin/projects/{id} — full project (any status) incl. all plots and every site-map
   * version with its geometries, so the catalog UI + PolygonEditor can hydrate without the
   * PUBLISHED-only customer endpoints.
   */
  async adminGet(id: string) {
    const pr = (await this.db.query(`SELECT * FROM projects WHERE id=$1`, [id])).rows[0];
    if (!pr) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');

    const plots = (
      await this.db.query(
        `SELECT id, plot_number, facing, dimensions_text, area_sqft, price_paise, status
           FROM plots WHERE project_id=$1 ORDER BY plot_number`,
        [id],
      )
    ).rows.map((p) => ({
      id: p.id,
      plot_number: p.plot_number,
      facing: p.facing,
      dimensions_text: p.dimensions_text,
      area_sqft: Number(p.area_sqft),
      price_paise: Number(p.price_paise),
      status: p.status,
    }));

    const maps = (
      await this.db.query(
        `SELECT id, version, is_active, image_key, width_px, height_px, created_at
           FROM site_maps WHERE project_id=$1 ORDER BY version DESC`,
        [id],
      )
    ).rows;
    const siteMaps = [] as any[];
    for (const m of maps) {
      const geometries = (
        await this.db.query(
          `SELECT plot_id, polygon, centroid FROM plot_geometries WHERE site_map_id=$1`,
          [m.id],
        )
      ).rows.map((g) => ({ plot_id: g.plot_id, polygon: g.polygon, centroid: g.centroid }));
      siteMaps.push({
        id: m.id,
        version: m.version,
        is_active: m.is_active,
        image_url: this.storage.signedGetUrl(m.image_key),
        width_px: m.width_px,
        height_px: m.height_px,
        created_at: new Date(m.created_at).toISOString(),
        geometries,
      });
    }

    return {
      id: pr.id,
      name: pr.name,
      slug: pr.slug,
      status: pr.status,
      description: pr.description,
      address_line: pr.address_line,
      district: pr.district,
      state: pr.state,
      pincode: pr.pincode,
      lat: pr.lat != null ? Number(pr.lat) : null,
      lng: pr.lng != null ? Number(pr.lng) : null,
      amenities: pr.amenities,
      rera_registered: pr.rera_registered,
      rera_number: pr.rera_number,
      max_advance_percentage: Number(pr.max_advance_percentage),
      hold_minutes_override: pr.hold_minutes_override,
      plots,
      site_maps: siteMaps,
    };
  }

  async create(actor: AuditActor, input: any) {
    if (input.rera_registered && !input.rera_number)
      throw Err.badRequest('VALIDATION_FAILED', 'rera_number required when rera_registered');
    const seller = (await this.db.query(`SELECT id FROM sellers ORDER BY created_at LIMIT 1`))
      .rows[0];
    if (!seller) throw Err.badRequest('VALIDATION_FAILED', 'no seller configured');

    const slug = input.slug ?? slugify(input.name);
    return this.db.tx(async (tx) => {
      const p = (
        await tx.query(
          `INSERT INTO projects
             (seller_id, name, slug, description, address_line, district, state, pincode,
              lat, lng, amenities, rera_registered, rera_number, max_advance_percentage,
              hold_minutes_override)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
            seller.id,
            input.name,
            slug,
            input.description ?? '',
            input.address_line ?? '',
            input.district ?? '',
            input.state ?? 'Tamil Nadu',
            input.pincode ?? '',
            input.lat ?? null,
            input.lng ?? null,
            JSON.stringify(input.amenities ?? []),
            !!input.rera_registered,
            input.rera_number ?? null,
            input.max_advance_percentage ?? 10.0,
            input.hold_minutes_override ?? null,
          ],
        )
      ).rows[0];
      await this.audit.log(tx, actor, 'project.create', 'project', p.id, null, {
        name: p.name,
        status: p.status,
      });
      return p;
    });
  }

  async patch(actor: AuditActor, id: string, input: any) {
    const allowed = [
      'description',
      'address_line',
      'district',
      'state',
      'pincode',
      'lat',
      'lng',
      'amenities',
    ];
    const sets: string[] = [];
    const vals: any[] = [];
    for (const k of allowed) {
      if (input[k] !== undefined) {
        vals.push(k === 'amenities' ? JSON.stringify(input[k]) : input[k]);
        sets.push(`${k}=$${vals.length}`);
      }
    }
    if (sets.length === 0) throw Err.badRequest('VALIDATION_FAILED', 'nothing to update');
    vals.push(id);
    const before = (await this.db.query(`SELECT * FROM projects WHERE id=$1`, [id])).rows[0];
    if (!before) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');
    return this.db.tx(async (tx) => {
      const p = (
        await tx.query(`UPDATE projects SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals)
      ).rows[0];
      await this.audit.log(tx, actor, 'project.update', 'project', id, before, p);
      return p;
    });
  }
}
