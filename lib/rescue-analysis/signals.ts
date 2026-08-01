import { type LeadCategory } from "./categories.ts";

/**
 * Deterministic signal engine — runs before any AI call. Every point awarded
 * or removed is recorded as a named signal with a human-readable explanation,
 * so a score is never a black box. Pure module (unit-testable without a server).
 */

export type LeadFacts = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  projectType: string | null;
  projectDescription: string | null;
  estimatedValue: number | null;
  source: string | null;
  sourceDetail: string | null;
  firstContactDate: string | null;
  lastContactDate: string | null;
  estimateDate: string | null;
  consentStatus: "unknown" | "express" | "implied" | "opted_out";
  suppressed: boolean;
  suppressionReason: string | null;
  status: string | null;
  notes: string | null;
};

export type Signal = {
  key: string;
  label: string;
  points: number;
  detail: string;
};

export type DeterministicAnalysis = {
  score: number;
  category: LeadCategory;
  signals: Signal[];
  /** Machine-readable uncertainty/risk markers (unknown_consent, stale_estimate, …). */
  flags: string[];
  needsReview: boolean;
};

const BASE_SCORE = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

function clampScore(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function daysSince(dateStr: string | null, now: Date): number | null {
  if (!dateStr) return null;
  const parsed = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((now.getTime() - parsed.getTime()) / DAY_MS);
}

/** Tokenizes a free-text service area ("Dallas–Fort Worth, TX 75201") for matching. */
function serviceAreaTokens(serviceArea: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of serviceArea.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 || /^\d{5}$/.test(raw)) tokens.add(raw);
  }
  return tokens;
}

/** Conservative keyword detection over CRM status/notes text for lifecycle buckets. */
export function detectLifecycleCategory(facts: Pick<LeadFacts, "status" | "notes">): {
  category: Extract<LeadCategory, "previously_lost" | "existing_customer" | "no_longer_qualified"> | null;
  evidence: string | null;
} {
  const statusText = (facts.status ?? "").toLowerCase();
  const notesText = (facts.notes ?? "").toLowerCase();
  const checks: Array<{ category: "previously_lost" | "existing_customer" | "no_longer_qualified"; pattern: RegExp }> = [
    { category: "existing_customer", pattern: /\b(existing customer|closed[\s_-]?won|job completed|completed job|repeat customer|current customer|won)\b/ },
    { category: "previously_lost", pattern: /\b(closed[\s_-]?lost|lost|went with (another|competitor)|chose (another|a different|competitor)|hired someone else)\b/ },
    { category: "no_longer_qualified", pattern: /\b(not qualified|no longer qualified|disqualified|moved away|sold (the )?(house|home|property)|out of (our )?(service )?area)\b/ },
  ];
  for (const source of [statusText, notesText]) {
    if (!source) continue;
    for (const check of checks) {
      const match = source.match(check.pattern);
      if (match) return { category: check.category, evidence: match[0] };
    }
  }
  return { category: null, evidence: null };
}

/**
 * Scores a lead from stored facts only. Suppression and opt-out are hard
 * gates: they zero the score and force `do_not_contact` before anything else
 * is considered — no downstream logic (including AI) may override them.
 */
export function analyzeDeterministic(
  facts: LeadFacts,
  opts: { now: Date; serviceArea?: string | null },
): DeterministicAnalysis {
  // ---- Hard gate 1: suppression / opt-out --------------------------------
  if (facts.suppressed || facts.consentStatus === "opted_out") {
    const reason = facts.suppressionReason
      ?? (facts.consentStatus === "opted_out" ? "The contact opted out of communication." : "The contact is on the do-not-contact list.");
    return {
      score: 0,
      category: "do_not_contact",
      signals: [{ key: "suppressed", label: "Do not contact", points: 0, detail: `${reason} Outreach is blocked by stored consent records.` }],
      flags: ["suppressed"],
      needsReview: false,
    };
  }

  // ---- Hard gate 2: no usable contact channel ----------------------------
  if (!facts.emailNormalized && !facts.phoneNormalized) {
    return {
      score: 0,
      category: "invalid_duplicate",
      signals: [{ key: "no_contact_channel", label: "No valid contact info", points: 0, detail: "Neither a valid email nor a valid phone number is on record — the lead cannot be reached." }],
      flags: ["invalid_contact"],
      needsReview: false,
    };
  }

  const signals: Signal[] = [];
  const flags: string[] = [];
  let score = BASE_SCORE;
  signals.push({ key: "base", label: "Baseline", points: BASE_SCORE, detail: "Every reachable lead starts at 40 before positive and negative signals." });

  // ---- Contact channels ---------------------------------------------------
  if (facts.emailNormalized && facts.phoneNormalized) {
    score += 8;
    signals.push({ key: "contact_channels", label: "Both email and phone on file", points: 8, detail: "Two valid outreach channels increase the chance of a response." });
  } else {
    score += 3;
    const channel = facts.emailNormalized ? "email" : "phone";
    signals.push({ key: "contact_channels", label: `One contact channel (${channel})`, points: 3, detail: `Only a valid ${channel} is on record.` });
  }

  // ---- Recency ------------------------------------------------------------
  const lastTouch = facts.lastContactDate ?? facts.firstContactDate;
  const age = daysSince(lastTouch, opts.now);
  if (age === null) {
    flags.push("unknown_recency");
    signals.push({ key: "recency", label: "No contact dates on record", points: 0, detail: "Without a first or last contact date, recency cannot be assessed." });
  } else if (age <= 30) {
    score += 20;
    signals.push({ key: "recency", label: "Contacted within the last month", points: 20, detail: `Last touch was ${age} day(s) ago — still warm.` });
  } else if (age <= 90) {
    score += 15;
    signals.push({ key: "recency", label: "Contacted within the last quarter", points: 15, detail: `Last touch was ${age} days ago.` });
  } else if (age <= 180) {
    score += 10;
    signals.push({ key: "recency", label: "Contacted within six months", points: 10, detail: `Last touch was ${age} days ago.` });
  } else if (age <= 365) {
    score += 4;
    signals.push({ key: "recency", label: "Contacted within a year", points: 4, detail: `Last touch was ${age} days ago — cooling off.` });
  } else if (age <= 730) {
    score -= 4;
    signals.push({ key: "recency", label: "Over a year since last contact", points: -4, detail: `Last touch was ${age} days ago.` });
  } else {
    score -= 10;
    signals.push({ key: "recency", label: "Over two years since last contact", points: -10, detail: `Last touch was ${age} days ago — details are likely stale.` });
  }

  // ---- Project value ------------------------------------------------------
  const value = facts.estimatedValue;
  if (value === null || value === undefined) {
    flags.push("unknown_value");
    signals.push({ key: "value", label: "No estimated value on record", points: 0, detail: "Project value is unknown; treat revenue potential conservatively." });
  } else if (value >= 25000) {
    score += 20;
    signals.push({ key: "value", label: "High project value", points: 20, detail: `Estimated at $${value.toLocaleString()} — a top-tier opportunity.` });
  } else if (value >= 10000) {
    score += 15;
    signals.push({ key: "value", label: "Strong project value", points: 15, detail: `Estimated at $${value.toLocaleString()}.` });
  } else if (value >= 5000) {
    score += 10;
    signals.push({ key: "value", label: "Moderate project value", points: 10, detail: `Estimated at $${value.toLocaleString()}.` });
  } else if (value > 0) {
    score += 5;
    signals.push({ key: "value", label: "Known project value", points: 5, detail: `Estimated at $${value.toLocaleString()}.` });
  }

  // ---- Prior estimate (demonstrated intent) -------------------------------
  const estimateAge = daysSince(facts.estimateDate, opts.now);
  if (estimateAge !== null) {
    if (estimateAge <= 365) {
      score += 15;
      signals.push({ key: "estimate", label: "Estimate on file", points: 15, detail: "The lead already requested and received an estimate — demonstrated buying intent." });
    } else {
      score += 6;
      flags.push("stale_estimate");
      signals.push({ key: "estimate", label: "Old estimate on file", points: 6, detail: `An estimate was given ${estimateAge} days ago; intent was real but may have lapsed.` });
    }
  }

  // ---- Consent ------------------------------------------------------------
  if (facts.consentStatus === "express") {
    score += 8;
    signals.push({ key: "consent", label: "Express consent", points: 8, detail: "The contact explicitly agreed to be contacted." });
  } else if (facts.consentStatus === "implied") {
    score += 3;
    signals.push({ key: "consent", label: "Implied consent", points: 3, detail: "Consent is implied from a prior business relationship." });
  } else {
    score -= 5;
    flags.push("unknown_consent");
    signals.push({ key: "consent", label: "Consent status unknown", points: -5, detail: "No consent record exists — verify eligibility before regulated channels like SMS." });
  }

  // ---- Service area -------------------------------------------------------
  const serviceArea = opts.serviceArea?.trim();
  const locationParts = [facts.city, facts.state, facts.zip].filter((v): v is string => !!v && v.trim() !== "");
  if (serviceArea && locationParts.length > 0) {
    const tokens = serviceAreaTokens(serviceArea);
    const areaLower = serviceArea.toLowerCase();
    const matches = locationParts.some((part) => {
      const lower = part.trim().toLowerCase();
      return tokens.has(lower) || areaLower.includes(lower);
    });
    if (matches) {
      score += 6;
      signals.push({ key: "service_area", label: "Inside service area", points: 6, detail: `The lead's location (${locationParts.join(", ")}) matches the stated service area.` });
    } else {
      score -= 8;
      flags.push("outside_service_area");
      signals.push({ key: "service_area", label: "Possibly outside service area", points: -8, detail: `The lead's location (${locationParts.join(", ")}) does not match the stated service area (${serviceArea}).` });
    }
  } else if (locationParts.length === 0) {
    signals.push({ key: "service_area", label: "No location on record", points: 0, detail: "City, state, and ZIP are all missing — service-area fit is unknown." });
  }

  score = clampScore(score);

  // ---- Category assignment ------------------------------------------------
  // Too many unknowns → a human should look before anything is scheduled.
  const unknownCount = flags.filter((f) => f.startsWith("unknown_")).length;
  const needsReview = unknownCount >= 2;

  const lifecycle = detectLifecycleCategory(facts);
  let category: LeadCategory;
  if (lifecycle.category) {
    category = lifecycle.category;
    signals.push({ key: "lifecycle", label: `Record marked "${lifecycle.evidence}"`, points: 0, detail: `CRM status/notes indicate this lead is ${lifecycle.category.replaceAll("_", " ")}.` });
  } else if (needsReview) {
    category = "needs_manual_review";
  } else if (score >= 70) {
    category = "hot_opportunity";
  } else if (score >= 50) {
    category = "worth_reengaging";
  } else {
    category = "long_term_nurture";
  }

  return { score, category, signals, flags, needsReview };
}
