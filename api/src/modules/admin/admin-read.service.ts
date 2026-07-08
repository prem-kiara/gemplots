import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { NotificationService } from '../notification/notification.service';
import { ExpiryService } from '../booking/expiry.service';

/** Clamp a client-supplied page size to a sane range (default 20, max 100). */
function clampLimit(limit?: string | number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
}

/**
 * Admin read surface (08 §7/§11, docs/10 §8.6). Read-only joins over bookings, the emails outbox,
 * audit logs, settings, plus the dashboard summary (docs/10 §5.3.3). All routes are @Roles admin;
 * AUDITOR may read everything here.
 */
@Injectable()
export class AdminReadService {
  constructor(
    private readonly db: DbService,
    private readonly notify: NotificationService,
    private readonly expiry: ExpiryService,
  ) {}

  /** GET /admin/emails — outbox rows newest first (demo-mode "sent mail" — 08 §6). */
  async emails(filters: { to?: string; template?: string; cursor?: string; limit?: number }) {
    const limit = clampLimit(filters.limit);
    const params: any[] = [];
    const where: string[] = [];
    if (filters.to) {
      params.push(filters.to);
      where.push(`to_email=$${params.length}`);
    }
    if (filters.template) {
      params.push(filters.template);
      where.push(`template=$${params.length}`);
    }
    if (filters.cursor) {
      params.push(filters.cursor);
      where.push(`created_at < $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit + 1);
    const rows = (
      await this.db.query(
        `SELECT id, to_email, template, subject, body_text, status, error, sent_at, created_at
           FROM emails_outbox ${whereSql}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((r) => ({
        id: r.id,
        to_email: r.to_email,
        template: r.template,
        subject: r.subject,
        body_text: r.body_text,
        status: r.status,
        error: r.error,
        sent_at: r.sent_at ? new Date(r.sent_at).toISOString() : null,
        created_at: new Date(r.created_at).toISOString(),
      })),
      next_cursor: hasMore ? new Date(rows[limit - 1].created_at).toISOString() : null,
    };
  }

  /** GET /admin/bookings — joined rows newest first, filterable by status/project/email. */
  async bookings(filters: {
    status?: string;
    project_id?: string;
    email?: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = clampLimit(filters.limit);
    const params: any[] = [];
    const where: string[] = [];
    if (filters.status) {
      params.push(filters.status);
      where.push(`b.status=$${params.length}`);
    }
    if (filters.project_id) {
      params.push(filters.project_id);
      where.push(`p.project_id=$${params.length}`);
    }
    if (filters.email) {
      params.push(filters.email);
      where.push(`u.email=$${params.length}`);
    }
    if (filters.cursor) {
      params.push(filters.cursor);
      where.push(`b.created_at < $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit + 1);
    const rows = (
      await this.db.query(
        `SELECT b.id, b.status, b.total_price_paise, b.expires_at, b.reserve_confirmed_at,
                b.created_at, p.plot_number, pr.name AS project_name,
                u.email AS customer_email, u.full_name AS customer_name
           FROM bookings b
           JOIN plots p ON p.id=b.plot_id
           JOIN projects pr ON pr.id=p.project_id
           JOIN users u ON u.id=b.user_id
           ${whereSql}
          ORDER BY b.created_at DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((r) => ({
        id: r.id,
        status: r.status,
        plot_number: r.plot_number,
        project_name: r.project_name,
        customer_email: r.customer_email,
        customer_name: r.customer_name,
        total_price_paise: Number(r.total_price_paise),
        expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        reserve_confirmed_at: r.reserve_confirmed_at
          ? new Date(r.reserve_confirmed_at).toISOString()
          : null,
        created_at: new Date(r.created_at).toISOString(),
      })),
      next_cursor: hasMore ? new Date(rows[limit - 1].created_at).toISOString() : null,
    };
  }

  /** GET /admin/audit-logs (API §5.7; SUPER_ADMIN + AUDITOR) — rows as stored, newest first. */
  async auditLogs(filters: {
    entity_type?: string;
    entity_id?: string;
    cursor?: string;
    limit?: number;
  }) {
    const limit = clampLimit(filters.limit);
    const params: any[] = [];
    const where: string[] = [];
    if (filters.entity_type) {
      params.push(filters.entity_type);
      where.push(`entity_type=$${params.length}`);
    }
    if (filters.entity_id) {
      params.push(filters.entity_id);
      where.push(`entity_id=$${params.length}`);
    }
    if (filters.cursor) {
      // Audit ids are a monotonic bigint identity — cursor on id is stable + total-ordered.
      params.push(filters.cursor);
      where.push(`id < $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit + 1);
    const rows = (
      await this.db.query(
        `SELECT id, actor_id, actor_role, action, entity_type, entity_id,
                before, after, request_id, ip, created_at
           FROM audit_logs ${whereSql}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params,
      )
    ).rows;
    const hasMore = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((r) => ({
        id: String(r.id),
        actor_id: r.actor_id,
        actor_role: r.actor_role,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        before: r.before,
        after: r.after,
        request_id: r.request_id,
        ip: r.ip,
        created_at: new Date(r.created_at).toISOString(),
      })),
      next_cursor: hasMore ? String(rows[limit - 1].id) : null,
    };
  }

  /** GET /admin/settings (read-only; SUPER_ADMIN + AUDITOR) — all global_settings rows. */
  async settings() {
    const rows = (
      await this.db.query(
        `SELECT key, value, updated_by, updated_at FROM global_settings ORDER BY key`,
      )
    ).rows;
    return {
      items: rows.map((r) => ({
        key: r.key,
        value: r.value,
        updated_by: r.updated_by,
        updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
      })),
    };
  }

  /**
   * GET /admin/dashboard/summary — EXACTLY the docs/10 §5.3.3 shape. Runs lazy repair over plots
   * with pending bookings first so counts are truthful (Invariant 6). Active holds are the
   * PENDING_* bookings, soonest-expiry first, capped at 20.
   */
  async dashboardSummary() {
    // Lazy repair: sweep any due pending holds before counting (08 §5, CF §3.3).
    const pendingPlots = (
      await this.db.query<{ plot_id: string }>(
        `SELECT DISTINCT plot_id FROM bookings
          WHERE status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')`,
      )
    ).rows.map((r) => r.plot_id);
    await this.expiry.repairPlots(pendingPlots);

    const approvalsPending = Number(
      (
        await this.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM approvals WHERE status='PENDING'`,
        )
      ).rows[0].n,
    );

    const holds = (
      await this.db.query(
        `SELECT b.id AS booking_id, p.plot_number, pr.name AS project_name,
                u.email AS customer_email, b.status, b.expires_at
           FROM bookings b
           JOIN plots p ON p.id=b.plot_id
           JOIN projects pr ON pr.id=p.project_id
           JOIN users u ON u.id=b.user_id
          WHERE b.status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')
          ORDER BY b.expires_at ASC
          LIMIT 20`,
      )
    ).rows;

    // Fixed status keys per docs/10 §5.3.3 — always present, default 0.
    const plotsByStatus: Record<string, number> = {
      AVAILABLE: 0,
      ON_HOLD: 0,
      RESERVED: 0,
      SOLD: 0,
      WITHDRAWN: 0,
    };
    const statusRows = (
      await this.db.query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM plots GROUP BY status`,
      )
    ).rows;
    for (const r of statusRows)
      if (r.status in plotsByStatus) plotsByStatus[r.status] = Number(r.n);

    const recent = await this.notify.listAdmin({ limit: 5 });

    return {
      approvals_pending: approvalsPending,
      active_holds: holds.map((h) => ({
        booking_id: h.booking_id,
        plot_number: h.plot_number,
        project_name: h.project_name,
        customer_email: h.customer_email,
        status: h.status,
        expires_at: h.expires_at ? new Date(h.expires_at).toISOString() : null,
      })),
      plots_by_status: plotsByStatus,
      recent_notifications: recent.items,
    };
  }
}
