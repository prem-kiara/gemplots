export type Role =
  | 'CUSTOMER'
  | 'SUPER_ADMIN'
  | 'OPERATIONS'
  | 'SALES'
  | 'FINANCE'
  | 'AUDITOR';

export const ADMIN_ROLES: Role[] = [
  'SUPER_ADMIN',
  'OPERATIONS',
  'SALES',
  'FINANCE',
  'AUDITOR',
];

/** AUDITOR is read-only: excluded from any write endpoint even under ADMIN:any (API §1.1). */
export const ADMIN_WRITE_ROLES: Role[] = [
  'SUPER_ADMIN',
  'OPERATIONS',
  'SALES',
  'FINANCE',
];

export interface JwtUser {
  sub: string;
  role: Role;
}
