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

/** Roles allowed to upload lead files and run imports. */
export const IMPORT_WRITE_ROLES: OrgRole[] = ["owner", "admin", "sales_manager", "office_staff"];

/** Roles allowed to generate message drafts (everyone who works leads; not read-only analysts). */
export const MESSAGE_WRITE_ROLES: OrgRole[] = ["owner", "admin", "sales_manager", "sales_rep", "office_staff"];

/** Roles allowed to create/edit campaigns and confirm activation (spec: owner/admin manage, sales manager approves). */
export const CAMPAIGN_MANAGE_ROLES: OrgRole[] = ["owner", "admin", "sales_manager"];

/** Roles allowed to act on leads: assign, change pipeline stage, suppress, note. */
export const LEAD_ACTION_ROLES: OrgRole[] = ["owner", "admin", "sales_manager", "sales_rep", "office_staff"];

/** Roles allowed to book/manage appointments. */
export const APPOINTMENT_WRITE_ROLES: OrgRole[] = ["owner", "admin", "sales_manager", "sales_rep", "office_staff"];

/** Roles allowed to log conversation messages (inbound replies, outbound notes/sends). */
export const CONVERSATION_WRITE_ROLES: OrgRole[] = ["owner", "admin", "sales_manager", "sales_rep", "office_staff"];

/** Roles that only ever see leads assigned to them (enforced server-side in queries). */
export const ASSIGNED_ONLY_ROLES: OrgRole[] = ["sales_rep"];

/** Platform-level roles (users.platform_role) for MogulForge staff. */
export const PLATFORM_ROLES = ["platform_admin", "support_admin"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
