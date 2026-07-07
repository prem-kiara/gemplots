# 05 — Maker-Checker (controlled actions + Approvals screens)

Semantics authority for Invariant 9. Data lives in `approvals` (DM §5.10).

## 1. Principles

1. A **maker** (admin) requests a controlled action → endpoint validates guardrails, writes an
   `approvals` row (PENDING) with `payload` (the proposed change) and `snapshot` (entity state
   now), returns `202`. **The target entity does not change.**
2. A **checker** — any admin whose role is in the action's `approver_roles`, and who is not the
   maker — approves or rejects. `maker_is_not_checker` DB CHECK is the backstop; the service
   returns `409 SELF_APPROVAL_FORBIDDEN` first.
3. **Guardrails run twice**: at request time (fail fast) and again at approval time (the world
   may have changed). Approval-time failure → `409 GUARDRAIL_FAILED`, approval stays PENDING.
4. Applying an approved action happens in **one transaction**: entity mutation + approvals row →
   APPROVED + audit rows for both the approval and the mutation.
5. One PENDING approval per (action, entity) — `uniq_pending_approval`. A second request →
   `409 PENDING_APPROVAL_EXISTS`.
6. Makers can `withdraw` their own PENDING request. Rejections require a note.

## 2. Implementation shape (approval module)

```ts
interface ApprovalActionHandler {
  action: ApprovalAction;
  makerRoles: Role[];        // who may request
  approverRoles: Role[];     // who may approve (maker excluded at runtime)
  validate(payload, entity, tx): Promise<GuardrailResult[]>;  // run at request AND approval
  apply(payload, entity, tx): Promise<AppliedResult>;         // the actual mutation
  summarize(payload, snapshot): {title: string; diff: FieldDiff[]}; // for the Review screen
}
```
Handlers register in a map keyed by action. `ApprovalService.request/approve/reject/withdraw`
are generic; adding action #11 later = one new handler file.

## 3. The 10 controlled actions

| # | action | Maker roles | Approver roles | payload | Guardrails (both times) | apply() |
|---|---|---|---|---|---|---|
| 1 | `UPDATE_PLOT_PRICE` | OPERATIONS, SALES | SUPER_ADMIN, OPERATIONS | `{new_price_paise}` | plot not BLOCKED/BOOKED/SOLD (no repricing under an active hold); price > 0; change ≤ ±50% unless approver is SUPER_ADMIN | set `plots.price_paise` |
| 2 | `FORCE_PLOT_STATUS` | OPERATIONS | SUPER_ADMIN | `{new_status, note}` | only transitions of DM §3.1 allowed (AVAILABLE⇄WITHDRAWN, BOOKED→SOLD); target has no active booking unless BOOKED→SOLD | set status |
| 3 | `CANCEL_BOOKING` | SALES, OPERATIONS | SUPER_ADMIN, FINANCE | `{note}` | booking is BLOCKED or BOOKED; if any SUCCESS payment exists, require an INITIATE_REFUND approval to exist or be filed with it | booking→CANCELLED, plot→AVAILABLE (guarded), cancel jobs, notify customer |
| 4 | `EXTEND_HOLD` | SALES | OPERATIONS, SUPER_ADMIN | `{extra_minutes}` | booking BLOCKED and not yet expired; total extension per booking ≤ 2880 min; extra_minutes 30–2880 | `expires_at += extra_minutes` (the ONE sanctioned write to expires_at), reschedule jobs + Redis TTL |
| 5 | `RESOLVE_MANUAL_REVIEW` | FINANCE | SUPER_ADMIN | `{resolution: CONFIRM\|CANCEL, note}` | booking is MANUAL_REVIEW; if CONFIRM: plot must be BLOCKED-by-this-booking or AVAILABLE, and a captured payment with matching amount exists | CONFIRM → payment SUCCESS + booking BOOKED + plot BOOKED (same TX as CF §5.7b); CANCEL → booking CANCELLED, plot released if held by it, refund flow required |
| 6 | `INITIATE_REFUND` | FINANCE | SUPER_ADMIN | `{amount_paise, reason}` | payment status SUCCESS; amount ≤ captured amount; booking CANCELLED or MANUAL_REVIEW | payment→REFUND_INITIATED; Phase 1: executed manually at gateway dashboard, marked REFUNDED via a follow-up FINANCE action logged to audit |
| 7 | `PUBLISH_PROJECT` | OPERATIONS | SUPER_ADMIN | `{target: PUBLISHED\|PAUSED\|ARCHIVED}` | for PUBLISHED: ≥1 plot, an active site map, every non-WITHDRAWN plot has geometry, RERA fields complete if flagged; for ARCHIVED: no active bookings in project | set project.status |
| 8 | `UPDATE_ADVANCE_CAP` | OPERATIONS | SUPER_ADMIN | `{new_percentage}` | 0 < pct ≤ 10 when rera_registered, else ≤ 25; does not affect existing payment orders | set `max_advance_percentage` |
| 9 | `BULK_PRICE_UPDATE` | OPERATIONS | SUPER_ADMIN | `{items:[{plot_id,new_price_paise}]}` (from CSV) | every plot in same project, none BLOCKED/BOOKED/SOLD; all prices > 0 | single TX over all plots; all-or-nothing |
| 10 | `UPDATE_GLOBAL_SETTING` | SUPER_ADMIN | SUPER_ADMIN (different) | `{key, new_value}` | key exists in whitelist (DM §5.13); value passes per-key validation (e.g. hold minutes 30–10080) | update global_settings; **never touches live holds** (Invariant 5) |

Audit actions written by apply(): `approval.approve` plus the domain action
(e.g. `plot.price_update`), both in the applying TX.

## 4. The two screens (Next.js admin)

### 4.1 Approvals Inbox (`/approvals`)
- Table of approvals, default filter `status=PENDING`, sorted oldest first.
- Columns: age (color: >24h amber, >72h red), action (human label), entity summary (project /
  plot number / booking ref / customer phone masked), maker, reason (truncated).
- Filters: status, action, project, maker. Badge count in the nav shows PENDING total
  (poll `GET /admin/approvals?status=PENDING` count).
- Row click → Review Detail. Makers see their own requests flagged "yours — view only".

### 4.2 Approval Review Detail (`/approvals/{id}`)
- Header: action label, status chip, maker + requested-at, entity deep-link.
- **Diff panel**: `summarize()` output — field, current (from live entity), proposed. If the live
  value has drifted from `snapshot`, show a "changed since request" warning per field.
- **Guardrails panel**: live re-check results from `GET /admin/approvals/{id}`
  (`guardrails: [{name, ok, detail}]`) — each with pass/fail icon. Approve button disabled while
  any guardrail fails or while viewer is the maker (server enforces regardless).
- Actions: Approve (optional note) / Reject (note required) / Withdraw (maker only).
- Footer: audit trail of this approval (requested, decided, applied) from
  `GET /admin/audit-logs?entity_type=approval&entity_id={id}`.

## 5. Tests that gate this module (see TP §2.6)
- Self-approval → 409 at API **and** direct-SQL UPDATE violates the CHECK.
- Guardrail drift: request price change → plot gets blocked → approval attempt →
  `GUARDRAIL_FAILED`, still PENDING.
- Double-request → `PENDING_APPROVAL_EXISTS`.
- apply() atomicity: induced failure inside apply → approvals row still PENDING, entity unchanged.
