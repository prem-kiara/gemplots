// Mirrors the API payloads used by the web app (docs/10 §5, §13). Kept intentionally partial —
// only fields the UI reads. Money is integer paise; timestamps are ISO-8601 UTC strings.

export type Role =
  | 'CUSTOMER'
  | 'SUPER_ADMIN'
  | 'OPERATIONS'
  | 'SALES'
  | 'FINANCE'
  | 'AUDITOR';

export type PlotStatus = 'AVAILABLE' | 'ON_HOLD' | 'RESERVED' | 'SOLD' | 'WITHDRAWN' | 'BLOCKED' | 'BOOKED';

export type BookingStatus =
  | 'PENDING_CONFIRMATION'
  | 'PENDING_APPROVAL'
  | 'RESERVED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'CANCELLED';

export interface User {
  id: string;
  phone: string | null;
  full_name: string;
  role: Role;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  user: User;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  district: string;
  state: string;
  rera_registered: boolean;
  rera_number: string | null;
  price_range_paise: { min: number | null; max: number | null };
  plot_counts: { total: number; available: number };
  cover_image_url: string | null;
  amenities: string[] | null;
}

export interface ProjectDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  address_line: string | null;
  district: string;
  state: string;
  pincode: string | null;
  amenities: string[] | null;
  rera_registered: boolean;
  rera_number: string | null;
  hold_minutes: number;
  plot_counts: Record<string, number>;
}

export interface MapPlot {
  plot_id: string;
  plot_number: string;
  status: PlotStatus;
  polygon: number[][]; // normalized [[x,y],...]
  centroid: number[]; // [x,y] normalized
  area_sqft: number;
  price_paise: number;
  facing: string | null;
}

export interface ProjectMap {
  map_version: number;
  image_url: string;
  width_px: number;
  height_px: number;
  plots: MapPlot[];
}

export interface PlotDetail {
  id: string;
  project_id: string;
  plot_number: string;
  facing: string | null;
  dimensions_text: string | null;
  area_sqft: number;
  price_paise: number;
  status: PlotStatus;
  attributes: Record<string, unknown> | null;
  blocked_until?: string;
}

export interface ReserveResult {
  booking_id: string;
  plot_id: string;
  status: BookingStatus;
  plot_number: string;
  project_name: string;
  total_price_paise: number;
  blocked_at: string;
  expires_at: string;
  challenge_id?: string;
  dev_otp?: string;
  replay?: boolean;
}

export interface Booking {
  id: string;
  status: BookingStatus;
  plot: {
    id: string;
    plot_number: string;
    area_sqft?: number;
    price_paise?: number;
    facing: string | null;
    status: PlotStatus;
  };
  project: { id: string; name: string; slug: string };
  total_price_paise: number;
  advance_amount_paise: number | null;
  blocked_at: string;
  expires_at: string;
  confirmed_at: string | null;
  payments?: { id: string; status: string; amount_paise: number; receipt_number: string | null }[];
}

export interface BookingListItem extends Booking {}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

export interface ConfirmResult {
  booking_id: string;
  status: BookingStatus;
  approval_id?: string;
  expires_at: string;
}

export interface OtpChallenge {
  challenge_id: string;
  retry_after_seconds: number;
  dev_otp?: string;
}

// ---- Admin ----

export interface DashboardSummary {
  approvals_pending: number;
  active_holds: {
    booking_id: string;
    plot_number: string;
    project_name: string;
    customer_email: string;
    status: BookingStatus;
    expires_at: string | null;
  }[];
  plots_by_status: Record<string, number>;
  recent_notifications: Notification[];
}

export interface ApprovalListItem {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  status: string;
  reason: string | null;
  maker_email: string | null;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  summary: string;
}

export interface Guardrail {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ApprovalDetail extends ApprovalListItem {
  payload: Record<string, unknown> | null;
  snapshot: {
    booking?: { id: string; plot_id: string; status: string; total_price_paise: number };
    plot?: { id: string; plot_number: string; project_id: string; project_name: string };
    customer?: { id: string; name: string; email: string; phone: string | null };
    reserve_confirmed_at?: string;
  } | null;
  guardrails: Guardrail[];
}

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  read_at: string | null;
  created_at: string;
}

export interface EmailRow {
  id: string;
  to_email: string;
  template: string;
  subject: string;
  body_text: string;
  status: 'LOGGED' | 'SENT' | 'FAILED';
  error: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface AdminBookingRow {
  id: string;
  status: BookingStatus;
  plot_number: string;
  project_name: string;
  customer_email: string;
  customer_name: string | null;
  total_price_paise: number;
  expires_at: string | null;
  reserve_confirmed_at: string | null;
  created_at: string;
}

export interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  request_id: string | null;
  ip: string | null;
  created_at: string;
}
