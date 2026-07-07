import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditService, AuditActor } from '../../common/audit/audit.service';
import { Err } from '../../common/errors';
import { slugify } from '../../common/util';

@Injectable()
export class ProjectService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

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
