import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { Err } from '../../common/errors';
import { ApprovalService, Requester } from './approval.service';

/**
 * Maker (request) side of the controlled actions (MC §1.1). Each method loads a snapshot of the
 * target entity (enough for the Review-screen diff — docs/10 §8.4) and files a PENDING approval via
 * ApprovalService.request(), which validates the maker role + runs guardrails at request time and
 * writes the request audit row. NONE of these mutate the target entity — that happens only on
 * approval. Each returns {approval_id, status:'PENDING'} → controller responds 202.
 */
@Injectable()
export class ControlledActionService {
  constructor(
    private readonly db: DbService,
    private readonly approvals: ApprovalService,
  ) {}

  /** PUBLISH_PROJECT — POST /admin/projects/:id/publish {target}. */
  async requestPublish(projectId: string, target: string, requester: Requester) {
    const pr = (
      await this.db.query(
        `SELECT id, name, status, rera_registered, rera_number FROM projects WHERE id=$1`,
        [projectId],
      )
    ).rows[0];
    if (!pr) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');
    const snapshot = {
      name: pr.name,
      status: pr.status,
      rera_registered: pr.rera_registered,
      rera_number: pr.rera_number,
    };
    return this.approvals.request(
      'PUBLISH_PROJECT',
      'project',
      projectId,
      { target },
      snapshot,
      `Set project status to ${target}`,
      requester,
    );
  }

  /** UPDATE_PLOT_PRICE — POST /admin/plots/:id/price {new_price_paise}. */
  async requestPrice(plotId: string, newPricePaise: number, requester: Requester) {
    const plot = (
      await this.db.query(
        `SELECT p.id, p.plot_number, p.price_paise, p.status, pr.name AS project_name
           FROM plots p JOIN projects pr ON pr.id=p.project_id WHERE p.id=$1`,
        [plotId],
      )
    ).rows[0];
    if (!plot) throw Err.notFound('PLOT_NOT_FOUND', 'Plot not found');
    const snapshot = {
      plot_number: plot.plot_number,
      price_paise: Number(plot.price_paise),
      status: plot.status,
      project_name: plot.project_name,
    };
    return this.approvals.request(
      'UPDATE_PLOT_PRICE',
      'plot',
      plotId,
      { new_price_paise: Number(newPricePaise) },
      snapshot,
      `Reprice plot ${plot.plot_number}`,
      requester,
    );
  }

  /** FORCE_PLOT_STATUS — POST /admin/plots/:id/force-status {new_status, note}. */
  async requestForceStatus(plotId: string, newStatus: string, note: string, requester: Requester) {
    const plot = (
      await this.db.query(`SELECT plot_number, status FROM plots WHERE id=$1`, [plotId])
    ).rows[0];
    if (!plot) throw Err.notFound('PLOT_NOT_FOUND', 'Plot not found');
    const snapshot = { plot_number: plot.plot_number, status: plot.status };
    return this.approvals.request(
      'FORCE_PLOT_STATUS',
      'plot',
      plotId,
      { new_status: newStatus, note: note ?? '' },
      snapshot,
      `Force plot ${plot.plot_number} to ${newStatus}`,
      requester,
    );
  }

  /** CANCEL_BOOKING — POST /admin/bookings/:id/cancel {note}. */
  async requestCancel(bookingId: string, note: string, requester: Requester) {
    const b = (
      await this.db.query(
        `SELECT b.id, b.status, b.plot_id, b.user_id,
                p.plot_number, pr.name AS project_name, u.email AS customer_email
           FROM bookings b
           JOIN plots p ON p.id=b.plot_id
           JOIN projects pr ON pr.id=p.project_id
           JOIN users u ON u.id=b.user_id
          WHERE b.id=$1`,
        [bookingId],
      )
    ).rows[0];
    if (!b) throw Err.notFound('BOOKING_NOT_FOUND', 'Booking not found');
    const snapshot = {
      status: b.status,
      plot_id: b.plot_id,
      plot_number: b.plot_number,
      project_name: b.project_name,
      customer_id: b.user_id,
      customer_email: b.customer_email,
    };
    return this.approvals.request(
      'CANCEL_BOOKING',
      'booking',
      bookingId,
      { note: note ?? '' },
      snapshot,
      `Cancel booking for ${b.plot_number}`,
      requester,
    );
  }

  /** EXTEND_HOLD — POST /admin/bookings/:id/extend-hold {extra_minutes}. */
  async requestExtendHold(bookingId: string, extraMinutes: number, requester: Requester) {
    const b = (
      await this.db.query(
        `SELECT b.id, b.status, b.plot_id, b.expires_at, p.plot_number
           FROM bookings b JOIN plots p ON p.id=b.plot_id WHERE b.id=$1`,
        [bookingId],
      )
    ).rows[0];
    if (!b) throw Err.notFound('BOOKING_NOT_FOUND', 'Booking not found');
    const snapshot = {
      status: b.status,
      plot_id: b.plot_id,
      plot_number: b.plot_number,
      expires_at: new Date(b.expires_at).toISOString(),
    };
    return this.approvals.request(
      'EXTEND_HOLD',
      'booking',
      bookingId,
      { extra_minutes: Number(extraMinutes) },
      snapshot,
      `Extend hold on ${b.plot_number} by ${extraMinutes} min`,
      requester,
    );
  }

  /** UPDATE_ADVANCE_CAP — POST /admin/projects/:id/advance-cap {new_percentage}. */
  async requestAdvanceCap(projectId: string, newPercentage: number, requester: Requester) {
    const pr = (
      await this.db.query(
        `SELECT name, max_advance_percentage, rera_registered FROM projects WHERE id=$1`,
        [projectId],
      )
    ).rows[0];
    if (!pr) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');
    const snapshot = {
      name: pr.name,
      max_advance_percentage: Number(pr.max_advance_percentage),
      rera_registered: pr.rera_registered,
    };
    return this.approvals.request(
      'UPDATE_ADVANCE_CAP',
      'project',
      projectId,
      { new_percentage: Number(newPercentage) },
      snapshot,
      `Set advance cap to ${newPercentage}%`,
      requester,
    );
  }

  /** BULK_PRICE_UPDATE — POST /admin/projects/:id/bulk-price {items}. */
  async requestBulkPrice(
    projectId: string,
    items: { plot_id: string; new_price_paise: number }[],
    requester: Requester,
  ) {
    const pr = (await this.db.query(`SELECT name FROM projects WHERE id=$1`, [projectId])).rows[0];
    if (!pr) throw Err.notFound('PROJECT_NOT_FOUND', 'Project not found');
    // Snapshot the current numbers/prices for the diff panel.
    const plotIds = items.map((i) => i.plot_id);
    const rows = plotIds.length
      ? (
          await this.db.query(
            `SELECT id, plot_number, price_paise FROM plots WHERE id = ANY($1) AND project_id=$2`,
            [plotIds, projectId],
          )
        ).rows
      : [];
    const plots: Record<string, string> = {};
    const prices: Record<string, number> = {};
    for (const r of rows) {
      plots[r.id] = r.plot_number;
      prices[r.id] = Number(r.price_paise);
    }
    const snapshot = { name: pr.name, plots, prices };
    return this.approvals.request(
      'BULK_PRICE_UPDATE',
      'project',
      projectId,
      { items: items.map((i) => ({ plot_id: i.plot_id, new_price_paise: Number(i.new_price_paise) })) },
      snapshot,
      `Bulk reprice ${items.length} plot(s)`,
      requester,
    );
  }

  /** UPDATE_GLOBAL_SETTING — POST /admin/settings {key, new_value}. entity = the setting key. */
  async requestSetting(key: string, newValue: any, requester: Requester) {
    const row = (
      await this.db.query(`SELECT value FROM global_settings WHERE key=$1`, [key])
    ).rows[0];
    const snapshot = { key, value: row?.value ?? null };
    return this.approvals.request(
      'UPDATE_GLOBAL_SETTING',
      'global_setting',
      key,
      { key, new_value: newValue },
      snapshot,
      `Change setting ${key}`,
      requester,
    );
  }
}
