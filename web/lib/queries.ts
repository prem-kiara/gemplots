'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type {
  Booking,
  DashboardSummary,
  Page,
  PlotDetail,
  ProjectDetail,
  ProjectMap,
  ProjectSummary,
  BookingListItem,
  ApprovalListItem,
  ApprovalDetail,
  Notification,
  EmailRow,
  AuditRow,
  AdminProjectRow,
  AdminProjectDetail,
  GlobalSetting,
} from './types';
import { markDevMode } from './devmode';

// Note any dev_otp anywhere in a response → flip the DEV MODE ribbon on.
export function noteDevOtp(obj: unknown): void {
  if (obj && typeof obj === 'object' && 'dev_otp' in obj && (obj as { dev_otp?: string }).dev_otp) {
    markDevMode();
  }
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => api<ProjectSummary[]>('/v1/projects'),
  });
}

export function useProject(idOrSlug: string) {
  return useQuery({
    queryKey: ['project', idOrSlug],
    queryFn: () => api<ProjectDetail>(`/v1/projects/${idOrSlug}`),
    enabled: !!idOrSlug,
  });
}

export function useProjectMap(projectId: string | undefined) {
  return useQuery({
    queryKey: ['map', projectId],
    queryFn: () => api<ProjectMap>(`/v1/projects/${projectId}/map`),
    enabled: !!projectId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
}

export function usePlot(plotId: string | undefined) {
  return useQuery({
    queryKey: ['plot', plotId],
    queryFn: () => api<PlotDetail>(`/v1/plots/${plotId}`),
    enabled: !!plotId,
  });
}

export function useBooking(bookingId: string) {
  return useQuery({
    queryKey: ['booking', bookingId],
    queryFn: () => api<Booking>(`/v1/bookings/${bookingId}`),
    enabled: !!bookingId,
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s === 'PENDING_CONFIRMATION' || s === 'PENDING_APPROVAL' ? 3_000 : false;
    },
  });
}

export function useMyBookings() {
  return useQuery({
    queryKey: ['me', 'bookings'],
    queryFn: () => api<Page<BookingListItem>>('/v1/me/bookings?limit=50'),
  });
}

export function useDashboardSummary() {
  return useQuery({
    queryKey: ['admin', 'summary'],
    queryFn: () => api<DashboardSummary>('/v1/admin/dashboard/summary'),
    refetchInterval: 30_000,
  });
}

// ---- Admin ----

export function useApprovals(filters: { status?: string; action?: string }) {
  const qs = new URLSearchParams();
  if (filters.status) qs.set('status', filters.status);
  if (filters.action) qs.set('action', filters.action);
  const q = qs.toString();
  return useQuery({
    queryKey: ['admin', 'approvals', filters],
    queryFn: () => api<{ items: ApprovalListItem[] }>(`/v1/admin/approvals${q ? `?${q}` : ''}`),
    refetchInterval: 60_000,
  });
}

export function useApproval(id: string) {
  return useQuery({
    queryKey: ['admin', 'approval', id],
    queryFn: () => api<ApprovalDetail>(`/v1/admin/approvals/${id}`),
    enabled: !!id,
  });
}

export function useNotificationCount() {
  return useQuery({
    queryKey: ['admin', 'notifications', 'count'],
    queryFn: () => api<{ unread: number }>('/v1/admin/notifications/count'),
    refetchInterval: 30_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['admin', 'notifications'],
    queryFn: () => api<Page<Notification>>('/v1/admin/notifications?limit=50'),
  });
}

export function useEmails() {
  return useQuery({
    queryKey: ['admin', 'emails'],
    queryFn: () => api<Page<EmailRow>>('/v1/admin/emails?limit=50'),
  });
}

// ---- Admin catalog (P6) ----

export function useAdminProjects(status?: string) {
  return useQuery({
    queryKey: ['admin', 'projects', status ?? 'all'],
    queryFn: () =>
      api<{ items: AdminProjectRow[] }>(
        `/v1/admin/projects${status ? `?status=${status}` : ''}`,
      ),
  });
}

export function useAdminProject(id: string) {
  return useQuery({
    queryKey: ['admin', 'project', id],
    queryFn: () => api<AdminProjectDetail>(`/v1/admin/projects/${id}`),
    enabled: !!id,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api<{ items: GlobalSetting[] }>('/v1/admin/settings'),
  });
}

export function useAudit(filters: { entity_type?: string; entity_id?: string }) {
  const qs = new URLSearchParams();
  if (filters.entity_type) qs.set('entity_type', filters.entity_type);
  if (filters.entity_id) qs.set('entity_id', filters.entity_id);
  qs.set('limit', '50');
  return useQuery({
    queryKey: ['admin', 'audit', filters],
    queryFn: () => api<Page<AuditRow>>(`/v1/admin/audit-logs?${qs.toString()}`),
  });
}
