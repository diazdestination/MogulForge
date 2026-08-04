import { NextResponse } from "next/server";
import { ApiError, guard, readJson, requireMember, requireUser } from "@/lib/api-guard";
import { MANAGER_ROLES } from "@/lib/roles";
import { resolveIntakeOrganization } from "@/lib/rescue-intake";
import { ensureOnboardingRecord } from "@/lib/onboarding";
import { updateOrgSettings } from "@/lib/org-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Onboarding step 1: company basics.
 *
 * Org resolution is EXPLICIT when the wizard already knows its org (resume /
 * revisit, incl. multi-org managers): the client sends organizationId and we
 * verify manager membership on exactly that org — never silently redirecting
 * progress to a different org the user happens to manage. Only when no
 * organizationId is supplied (brand-new signup) do we fall back to the intake
 * resolver, which reuses the user's managed org or provisions a starter org.
 */
export const POST = guard(async (request: Request) => {
  const user = await requireUser();
  const body = await readJson(request);

  const companyName = typeof body.companyName === "string" ? body.companyName.trim().slice(0, 100) : "";
  if (companyName.length < 2) throw new ApiError(400, "Please enter your company name.");
  const industry = typeof body.industry === "string" && body.industry.trim() ? body.industry.trim().slice(0, 80) : "home services";
  const website = typeof body.website === "string" ? body.website.trim().slice(0, 300) : "";
  const explicitOrgId = typeof body.organizationId === "string" && body.organizationId.trim() ? body.organizationId.trim() : null;

  let organizationId: string;
  let created = false;
  if (explicitOrgId) {
    // Membership + manager role decide access — the id is only a resource pointer.
    const { org } = await requireMember(explicitOrgId, MANAGER_ROLES);
    organizationId = org.id;
  } else {
    const result = await resolveIntakeOrganization({ id: user.id, email: user.email, name: user.name }, companyName, industry);
    organizationId = result.organizationId;
    created = result.created;
  }

  await ensureOnboardingRecord(organizationId);
  // Saving the website is best-effort profile data (used to prefill the
  // website step) — merged section-wise so other contact fields survive.
  if (website) await updateOrgSettings(organizationId, { contact: { website } });

  return NextResponse.json({ organizationId, created });
});
