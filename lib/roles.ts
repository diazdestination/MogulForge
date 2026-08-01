/** Organization-level roles (memberships.role). */
export const ORG_ROLES = ["owner", "admin", "sales_manager", "sales_rep", "office_staff", "read_only_analyst"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_LABELS: Record<OrgRole, string> = {
  owner: "Owner",
  admin: "Admin",
  sales_manager: "Sales Manager",
  sales_rep: "Sales Rep",
  office_staff: "Office Staff",
  read_only_analyst: "Read-only Analyst",
};

export function isOrgRole(value: string): value is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(value);
}

/** Roles allowed to manage org settings, members, and invites. */
export const MANAGER_ROLES: OrgRole[] = ["owner", "admin"];

/** Platform-level roles (users.platform_role) for MogulForge staff. */
export const PLATFORM_ROLES = ["platform_admin", "support_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
