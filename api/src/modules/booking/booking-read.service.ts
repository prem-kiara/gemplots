import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { Err } from '../../common/errors';
import { ExpiryService } from './expiry.service';

/** Booking reads (API §4). Every read runs lazy repair first so a client never sees a stale
 *  BLOCKED that should have expired. GET /bookings/{id} is the endpoint the app polls. */
@Injectable()
export class BookingReadService {
  constructor(
    private readonly db: DbService,
    private readonly expiry: ExpiryService,
  ) {}

  async getById(bookingId: string, requester: { id: string; role: string }) {
    await this.expiry.repairBooking(bookingId);
    const b = (await this.db.query(`SELECT * FROM bookings WHERE id=$1`, [bookingId])).rows[0];
    if (!b) throw Err.notFound('BOOKING_NOT_FOUND', 'Booking not found');
    if (requester.role === 'CUSTOMER' && b.user_id !== requester.id)
      throw Err.forbidden('NOT_BOOKING_OWNER', 'Not your booking');

    const plot = (
      await this.db.query(
        `SELECT p.id, p.plot_number, p.area_sqft, p.price_paise, p.facing, p.status,
                pr.id AS project_id, pr.name AS project_name, pr.slug
           FROM plots p JOIN projects pr ON pr.id=p.project_id WHERE p.id=$1`,
        [b.plot_id],
      )
    ).rows[0];
    const payments = (
      await this.db.query(
        `SELECT id, status, amount_paise, receipt_number, gateway_order_id
           FROM payments WHERE booking_id=$1 ORDER BY created_at`,
        [bookingId],
      )
    ).rows;

    return this.shape(b, plot, payments);
  }

  async listMine(userId: string, limit = 20, cursor?: string) {
    await this.repairUserActivePlots(userId);
    const params: any[] = [userId];
    let where = `b.user_id=$1`;
    if (cursor) {
      params.push(cursor);
      where += ` AND b.created_at < $${params.length}`;
    }
    params.push(limit + 1);
    const rows = (
      await this.db.query(
        `SELECT b.*, p.plot_number, pr.name AS project_name, pr.id AS project_id, pr.slug
           FROM bookings b JOIN plots p ON p.id=b.plot_id JOIN projects pr ON pr.id=p.project_id
          WHERE ${where}
          ORDER BY b.created_at DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((b) =>
      this.shape(
        b,
        {
          id: b.plot_id,
          plot_number: b.plot_number,
          project_id: b.project_id,
          project_name: b.project_name,
          slug: b.slug,
        },
        undefined,
      ),
    );
    return {
      items,
      next_cursor: hasMore ? new Date(rows[limit - 1].created_at).toISOString() : null,
    };
  }

  private async repairUserActivePlots(userId: string) {
    const plots = (
      await this.db.query<{ plot_id: string }>(
        `SELECT DISTINCT plot_id FROM bookings
           WHERE user_id=$1 AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')`,
        [userId],
      )
    ).rows.map((r) => r.plot_id);
    await this.expiry.repairPlots(plots);
  }

  private shape(b: any, plot: any, payments?: any[]) {
    const out: any = {
      id: b.id,
      status: b.status,
      plot: {
        id: plot.id,
        plot_number: plot.plot_number,
        area_sqft: plot.area_sqft != null ? Number(plot.area_sqft) : undefined,
        price_paise: plot.price_paise != null ? Number(plot.price_paise) : undefined,
        facing: plot.facing,
        status: plot.status,
      },
      project: { id: plot.project_id, name: plot.project_name, slug: plot.slug },
      total_price_paise: Number(b.total_price_paise),
      advance_amount_paise: b.advance_amount_paise != null ? Number(b.advance_amount_paise) : null,
      blocked_at: new Date(b.blocked_at).toISOString(),
      expires_at: new Date(b.expires_at).toISOString(),
      confirmed_at: b.confirmed_at ? new Date(b.confirmed_at).toISOString() : null,
    };
    if (payments)
      out.payments = payments.map((p) => ({
        id: p.id,
        status: p.status,
        amount_paise: Number(p.amount_paise),
        receipt_number: p.receipt_number,
      }));
    return out;
  }
}
