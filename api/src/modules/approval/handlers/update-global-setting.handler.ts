import { Injectable } from '@nestjs/common';
import { Executor } from '../../../common/db/db.service';
import { AuditService } from '../../../common/audit/audit.service';
import { ConfigService } from '../../../common/config/config.service';
import { Role } from '../../auth/auth.types';
import {
  AppliedResult,
  ApprovalActionHandler,
  ApprovalRow,
  Checker,
  FieldDiff,
  GuardrailResult,
} from '../approval.types';

/**
 * The global_settings whitelist (DM §5.13) with per-key validation. Each validator returns null
 * when the value is acceptable, or an error string otherwise. Values MUST be JSON-storable.
 */
type Validator = (v: any) => string | null;

function intInRange(lo: number, hi: number): Validator {
  return (v) => {
    const n = Number(v);
    if (!Number.isInteger(n)) return 'must be an integer';
    if (n < lo || n > hi) return `must be between ${lo} and ${hi}`;
    return null;
  };
}

export const SETTING_WHITELIST: Record<string, Validator> = {
  global_hold_minutes: intInRange(30, 10080),
  reserve_otp_minutes: intInRange(30, 10080),
  admin_decision_hours: intInRange(1, 336),
  max_active_holds_per_user: intInRange(1, 10),
  otp_send_limit_per_15min: intInRange(1, 100),
  otp_send_limit_per_day: intInRange(1, 1000),
  otp_verify_max_attempts: intInRange(1, 20),
  min_advance_paise: intInRange(1, 100_000_000_000),
};

/**
 * UPDATE_GLOBAL_SETTING (MC §3.10). Maker SUPER_ADMIN, approver SUPER_ADMIN (different admin —
 * the maker_is_not_checker DB CHECK still splits them). payload {key, new_value}. Guardrails: key
 * in the whitelist; value passes per-key validation. apply(): update global_settings +
 * ConfigService.invalidate(key). MUST NOT touch live holds (Invariant 5′) — it only rewrites the
 * setting; existing deadlines are frozen at state entry.
 */
@Injectable()
export class UpdateGlobalSettingHandler implements ApprovalActionHandler {
  readonly action = 'UPDATE_GLOBAL_SETTING' as const;
  readonly makerRoles: Role[] = ['SUPER_ADMIN'];
  readonly approverRoles: Role[] = ['SUPER_ADMIN'];

  constructor(
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    const p = approval.payload ?? {};
    return {
      title: `Change setting ${p.key}`,
      diff: [{ field: p.key, current: s.value ?? null, proposed: p.new_value }],
    };
  }

  async validate(approval: ApprovalRow, _ex: Executor): Promise<GuardrailResult[]> {
    const key = approval.payload?.key;
    const value = approval.payload?.new_value;
    const validator = SETTING_WHITELIST[key];
    const known = !!validator;
    const err = known ? validator(value) : 'key not in whitelist';
    return [
      {
        name: 'key_whitelisted',
        ok: known,
        detail: known ? `${key} is a settable key` : `${key} is not in the settings whitelist`,
      },
      {
        name: 'value_valid',
        ok: known && err === null,
        detail: err === null ? 'Value passes validation' : `Invalid value: ${err}`,
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const key = approval.payload?.key;
    const value = approval.payload?.new_value;
    const validator = SETTING_WHITELIST[key];
    if (!validator) throw new Error(`UPDATE_GLOBAL_SETTING apply: ${key} not whitelisted`);
    const err = validator(value);
    if (err) throw new Error(`UPDATE_GLOBAL_SETTING apply: invalid value (${err})`);

    const before = (
      await ex.query(`SELECT value FROM global_settings WHERE key=$1 FOR UPDATE`, [key])
    ).rows[0];
    // Normalise to the integer we validated so the stored JSON is a number, not a string.
    const normalised = Number(value);

    await ex.query(
      `INSERT INTO global_settings (key, value, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=$3, updated_at=now()`,
      [key, JSON.stringify(normalised), checker.id],
    );
    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'setting.update',
      'global_setting',
      key,
      { value: before?.value ?? null },
      { value: normalised },
    );
    return { audit: [] };
  }

  /** Post-commit — drop the config cache so the new value is read immediately (never live holds). */
  async afterApply(approval: ApprovalRow): Promise<void> {
    this.config.invalidate(approval.payload?.key);
  }
}
