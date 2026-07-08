// Role helpers (§4 route guards). We trust the persisted `gp.user` role rather than decoding the
// JWT — the login/verify responses carry {id, full_name, phone, role} and the server enforces
// authorization regardless.

import type { Role, User } from './types';
import { getUser, clearSession, api } from './api';

export const ADMIN_ROLES: Role[] = ['SUPER_ADMIN', 'OPERATIONS', 'SALES', 'FINANCE', 'AUDITOR'];

/** Roles allowed to read the Audit log + Settings (others get 403 — hide the nav). */
export const AUDIT_ROLES: Role[] = ['SUPER_ADMIN', 'AUDITOR'];

export function isAdmin(user: User | null): boolean {
  return !!user && ADMIN_ROLES.includes(user.role);
}

export function canSeeAudit(user: User | null): boolean {
  return !!user && AUDIT_ROLES.includes(user.role);
}

export function currentUser(): User | null {
  return getUser();
}

/** Best-effort refresh-token revocation, then local clear. */
export async function logout(): Promise<void> {
  const refresh = typeof window !== 'undefined' ? localStorage.getItem('gp.refresh') : null;
  if (refresh) {
    try {
      await api('/v1/auth/logout', { method: 'POST', body: { refresh_token: refresh } });
    } catch {
      // ignore — we clear locally regardless
    }
  }
  clearSession();
}
