import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { AuditService, AuditActor } from '../../common/audit/audit.service';
import { Err } from '../../common/errors';
import { rupeesToPaise } from '../../common/util';

interface CsvRow {
  plot_number: string;
  facing?: string;
  dimensions_text?: string;
  area_sqft: number;
  price_inr: number;
}

@Injectable()
export class PlotService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Bulk CSV upload (API §5.1) — validate-all-then-insert-all in ONE transaction (all-or-nothing).
   * dryRun returns the row errors without inserting.
   */
  async bulkUpload(actor: AuditActor, projectId: string, csv: string, dryRun: boolean) {
    const project = (await this.db.query(`SELECT id FROM projects WHERE id=$1`, [projectId]))
      .rows[0];
    if (!project) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');

    const { rows, errors } = this.parse(csv);
    // Detect in-file duplicates.
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const pn = rows[i].plot_number;
      if (seen.has(pn)) errors.push({ row: i + 2, message: `duplicate plot_number ${pn}` });
      seen.add(pn);
    }
    // Detect existing plot_numbers in the project.
    if (rows.length) {
      const existing = (
        await this.db.query<{ plot_number: string }>(
          `SELECT plot_number FROM plots WHERE project_id=$1 AND plot_number = ANY($2)`,
          [projectId, rows.map((r) => r.plot_number)],
        )
      ).rows.map((r) => r.plot_number);
      const exSet = new Set(existing);
      rows.forEach((r, i) => {
        if (exSet.has(r.plot_number))
          errors.push({ row: i + 2, message: `plot_number ${r.plot_number} already exists` });
      });
    }

    if (dryRun || errors.length > 0) {
      return { inserted: 0, errors };
    }

    const inserted = await this.db.tx(async (tx) => {
      let n = 0;
      for (const r of rows) {
        await tx.query(
          `INSERT INTO plots (project_id, plot_number, facing, dimensions_text, area_sqft, price_paise)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            projectId,
            r.plot_number,
            r.facing ?? null,
            r.dimensions_text ?? '',
            r.area_sqft,
            rupeesToPaise(r.price_inr),
          ],
        );
        n++;
      }
      await this.audit.log(tx, actor, 'plot.bulk_upload', 'project', projectId, null, {
        inserted: n,
      });
      return n;
    });
    return { inserted, errors: [] };
  }

  private parse(csv: string): { rows: CsvRow[]; errors: { row: number; message: string }[] } {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const errors: { row: number; message: string }[] = [];
    const rows: CsvRow[] = [];
    if (lines.length === 0) return { rows, errors };
    const header = lines[0].split(',').map((h) => h.trim());
    const idx = (name: string) => header.indexOf(name);
    const need = ['plot_number', 'area_sqft', 'price_inr'];
    for (const col of need)
      if (idx(col) < 0) errors.push({ row: 1, message: `missing column ${col}` });
    if (errors.length) return { rows, errors };

    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split(',').map((c) => c.trim());
      const plot_number = cells[idx('plot_number')];
      const area_sqft = Number(cells[idx('area_sqft')]);
      const price_inr = Number(cells[idx('price_inr')]);
      const rowNum = i + 1;
      if (!plot_number) errors.push({ row: rowNum, message: 'plot_number empty' });
      if (!(area_sqft > 0)) errors.push({ row: rowNum, message: 'area_sqft must be > 0' });
      if (!(price_inr > 0)) errors.push({ row: rowNum, message: 'price_inr must be > 0' });
      rows.push({
        plot_number,
        facing: idx('facing') >= 0 ? cells[idx('facing')] : undefined,
        dimensions_text: idx('dimensions_text') >= 0 ? cells[idx('dimensions_text')] : undefined,
        area_sqft,
        price_inr,
      });
    }
    return { rows, errors };
  }
}
