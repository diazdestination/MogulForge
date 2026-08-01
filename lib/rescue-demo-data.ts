// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATASET — every record in this module is fictional example data used to
// power the read-only demo dashboard at /revenue-rescue/demo. Nothing here is
// live client data, and no messages are ever sent from demo mode.
// ─────────────────────────────────────────────────────────────────────────────

export type DemoLeadStatus =
  | "analyzed"
  | "queued"
  | "contacted"
  | "replied"
  | "appointment"
  | "won"
  | "suppressed"
  | "merged"
  | "review";

export const statusLabels: Record<DemoLeadStatus, string> = {
  analyzed: "Analyzed",
  queued: "Outreach queued",
  contacted: "Contacted",
  replied: "Replied",
  appointment: "Appointment",
  won: "Job sold",
  suppressed: "Suppressed",
  merged: "Merged",
  review: "Needs review",
};

export type DemoLead = {
  id: string;
  name: string;
  trade: string;
  source: string;
  city: string;
  value: number;
  score: number;
  status: DemoLeadStatus;
  age: string; // how long the lead sat dormant before import
  nextAction: string;
  note: string;
};

export const demoLeads: DemoLead[] = [
  { id: "L-001", name: "Mike Harrigan", trade: "Roof replacement", source: "Old estimate", city: "Mesa, AZ", value: 18400, score: 92, status: "appointment", age: "9 mo", nextAction: "Estimate visit Thu 10:00 AM", note: "SMS prepared → approved → replied “still interested” → appointment booked." },
  { id: "L-002", name: "Dana Whitfield", trade: "Pool build", source: "Unsold proposal", city: "Gilbert, AZ", value: 86000, score: 88, status: "review", age: "14 mo", nextAction: "Manual approval required (high value)", note: "Proposal above auto-send threshold — owner review before outreach." },
  { id: "L-003", name: "Luis Ortega", trade: "HVAC replacement", source: "Missed call", city: "Chandler, AZ", value: 9800, score: 84, status: "contacted", age: "5 mo", nextAction: "Follow-up SMS in 2 days", note: "Missed-call win-back text sent (simulated). Awaiting reply." },
  { id: "L-004", name: "Priya Raman", trade: "Kitchen remodel", source: "Website inquiry", city: "Tempe, AZ", value: 42500, score: 90, status: "replied", age: "7 mo", nextAction: "Assigned to salesperson — send scope options", note: "Missed inquiry → email generated → asked for cabinet options → assigned to Jake." },
  { id: "L-005", name: "Ted Kowalski", trade: "Roof repair", source: "CRM contact", city: "Phoenix, AZ", value: 3200, score: 0, status: "suppressed", age: "18 mo", nextAction: "None — do not contact", note: "Replied STOP to first SMS. Contact suppressed immediately across all channels." },
  { id: "L-006", name: "Robert Chen", trade: "Landscape design", source: "CSV import", city: "Scottsdale, AZ", value: 27500, score: 81, status: "queued", age: "11 mo", nextAction: "Seasonal check-in email queued", note: "Primary record after merge with duplicate “Bob Chen”." },
  { id: "L-007", name: "Bob Chen", trade: "Landscape design", source: "Website inquiry", city: "Scottsdale, AZ", value: 27500, score: 0, status: "merged", age: "11 mo", nextAction: "None — merged into L-006", note: "Duplicate detected (same phone + address). Merge recommended and applied." },
  { id: "L-008", name: "Angela Foster", trade: "Bathroom remodel", source: "Old estimate", city: "Mesa, AZ", value: 21800, score: 79, status: "contacted", age: "10 mo", nextAction: "Estimate-reminder email day 3", note: "Estimate never followed up after site visit. Reminder sequence started." },
  { id: "L-009", name: "Sam Delgado", trade: "Concrete driveway", source: "Facebook lead export", city: "Queen Creek, AZ", value: 8600, score: 62, status: "analyzed", age: "13 mo", nextAction: "Email-only outreach recommended", note: "Phone number invalid — outreach limited to verified email address." },
  { id: "L-010", name: "Karen Voss", trade: "Roof replacement", source: "Connected CRM", city: "Chandler, AZ", value: 16900, score: 76, status: "appointment", age: "6 mo", nextAction: "Sync stage back to CRM", note: "CRM record — stage update synchronized after appointment was booked." },
  { id: "L-011", name: "Derrick Boone", trade: "HVAC tune-up", source: "Webhook lead", city: "Phoenix, AZ", value: 4200, score: 58, status: "analyzed", age: "2 mo", nextAction: "Add to spring re-check campaign", note: "Arrived via website webhook, cleaned and scored automatically." },
  { id: "L-012", name: "Melissa Grant", trade: "Outdoor kitchen", source: "Unsold proposal", city: "Gilbert, AZ", value: 54000, score: 86, status: "replied", age: "8 mo", nextAction: "Send updated proposal pricing", note: "Replied asking whether last year's quote still stands." },
  { id: "L-013", name: "Hank Purcell", trade: "Pool remodel", source: "Old estimate", city: "Tempe, AZ", value: 31500, score: 74, status: "contacted", age: "12 mo", nextAction: "Voicemail script follow-up", note: "Project was delayed by financing — follow-up date created for next week." },
  { id: "L-014", name: "Joyce Nakamura", trade: "Window replacement", source: "CSV import", city: "Mesa, AZ", value: 12800, score: 71, status: "queued", age: "9 mo", nextAction: "SMS reactivation queued", note: "Categorized as warm — homeowner requested quotes twice historically." },
  { id: "L-015", name: "Bill Andrade", trade: "Roof repair", source: "Missed call", city: "Apache Junction, AZ", value: 5400, score: 66, status: "contacted", age: "4 mo", nextAction: "Second win-back text in 3 days", note: "Called twice during monsoon season, never reached a person." },
  { id: "L-016", name: "Sandra Ellis", trade: "Whole-home remodel", source: "Website inquiry", city: "Scottsdale, AZ", value: 145000, score: 89, status: "review", age: "10 mo", nextAction: "Manual approval required (high value)", note: "Six-figure scope — flagged for personal outreach by the owner." },
  { id: "L-017", name: "Tom Reyes", trade: "Water restoration", source: "CRM contact", city: "Phoenix, AZ", value: 7300, score: 44, status: "analyzed", age: "16 mo", nextAction: "Low priority — seasonal check-in", note: "Insurance claim closed; low reactivation probability." },
  { id: "L-018", name: "Gloria Whitman", trade: "HVAC replacement", source: "Old estimate", city: "Sun Lakes, AZ", value: 11200, score: 83, status: "won", age: "7 mo", nextAction: "Request review in 2 weeks", note: "Reactivated estimate closed at $11,200 — attributed to Dormant Estimate Revival." },
  { id: "L-019", name: "Pete Sandoval", trade: "Concrete patio", source: "Google Ads export", city: "Chandler, AZ", value: 6800, score: 57, status: "queued", age: "12 mo", nextAction: "Email prepared — pending approval", note: "Stalled reason detected: price objection. Angle: phased scope option." },
  { id: "L-020", name: "Rachel Kim", trade: "Kitchen remodel", source: "Website inquiry", city: "Tempe, AZ", value: 38700, score: 80, status: "contacted", age: "6 mo", nextAction: "Follow-up email day 5", note: "Original inquiry answered 4 days late — never converted." },
  { id: "L-021", name: "Frank Deluca", trade: "Roof replacement", source: "Unsold proposal", city: "Mesa, AZ", value: 22600, score: 78, status: "replied", age: "9 mo", nextAction: "Offer appointment times", note: "Replied “can you come back out?” — appointment options sent (simulated)." },
  { id: "L-022", name: "Marcy Oldham", trade: "Landscape lighting", source: "CSV import", city: "Gilbert, AZ", value: 4900, score: 52, status: "analyzed", age: "15 mo", nextAction: "Add to seasonal campaign", note: "Cool lead — best angle is fall lighting check-in." },
  { id: "L-023", name: "Victor Nunes", trade: "Pool build", source: "Old estimate", city: "Queen Creek, AZ", value: 74000, score: 85, status: "queued", age: "11 mo", nextAction: "SMS pending owner approval", note: "Stalled reason: HOA approval delay, since resolved per public records." },
  { id: "L-024", name: "Irene Castillo", trade: "Bathroom remodel", source: "Missed call", city: "Phoenix, AZ", value: 17800, score: 73, status: "contacted", age: "3 mo", nextAction: "Call script ready for sales team", note: "Missed call recovered — homeowner answered simulated text, prefers a call." },
  { id: "L-025", name: "Doug Mercer", trade: "Roof repair", source: "CRM contact", city: "Tempe, AZ", value: 4100, score: 39, status: "analyzed", age: "20 mo", nextAction: "Hold — verify address change", note: "Data cleanup flagged a possible move; verify before outreach." },
  { id: "L-026", name: "Alice Thornton", trade: "HVAC replacement", source: "Website inquiry", city: "Mesa, AZ", value: 10600, score: 75, status: "appointment", age: "5 mo", nextAction: "Comfort consult Mon 2:00 PM", note: "Re-engaged via email; booked through scheduling link (simulated)." },
  { id: "L-027", name: "Jorge Batista", trade: "Outdoor living", source: "Facebook lead export", city: "Chandler, AZ", value: 29800, score: 68, status: "queued", age: "13 mo", nextAction: "Email sequence queued", note: "Never contacted after form fill during busy season." },
  { id: "L-028", name: "Nina Petrov", trade: "Window replacement", source: "Old estimate", city: "Scottsdale, AZ", value: 15300, score: 70, status: "contacted", age: "8 mo", nextAction: "Estimate-reminder SMS day 2", note: "Estimate emailed but never discussed — reminder sequence running." },
  { id: "L-029", name: "Carl Jensen", trade: "Concrete foundation", source: "Webhook lead", city: "Apache Junction, AZ", value: 13900, score: 61, status: "analyzed", age: "1 mo", nextAction: "Score review after enrichment", note: "Webhook import — waiting on parcel data enrichment." },
  { id: "L-030", name: "Tanya Brooks", trade: "Pool remodel", source: "CSV import", city: "Gilbert, AZ", value: 26400, score: 77, status: "replied", age: "10 mo", nextAction: "Send finish options PDF", note: "Asked for pebble finish samples — routed to design team." },
  { id: "L-031", name: "Omar Haddad", trade: "Roof replacement", source: "Missed call", city: "Phoenix, AZ", value: 19700, score: 82, status: "queued", age: "2 mo", nextAction: "Win-back SMS queued", note: "Two missed calls in one week — high urgency signal." },
  { id: "L-032", name: "Beverly Otis", trade: "Kitchen remodel", source: "CRM contact", city: "Sun City, AZ", value: 33100, score: 47, status: "suppressed", age: "22 mo", nextAction: "None — do not contact", note: "On the do-not-contact list from a previous unsubscribe. Auto-suppressed." },
  { id: "L-033", name: "Grant Wheeler", trade: "HVAC tune-up", source: "Google Ads export", city: "Mesa, AZ", value: 3800, score: 49, status: "analyzed", age: "14 mo", nextAction: "Seasonal check-in queued", note: "Best angle: pre-summer tune-up reminder." },
  { id: "L-034", name: "Sofia Marino", trade: "Bathroom remodel", source: "Website inquiry", city: "Tempe, AZ", value: 24900, score: 72, status: "contacted", age: "7 mo", nextAction: "Follow-up email day 4", note: "Slow first response originally (11 hours) — lead went cold." },
  { id: "L-035", name: "Ray Colburn", trade: "Water restoration", source: "Old estimate", city: "Chandler, AZ", value: 8900, score: 55, status: "queued", age: "9 mo", nextAction: "Project-status message queued", note: "Job paused mid-scope — status check-in prepared." },
  { id: "L-036", name: "Judith Lang", trade: "Landscape design", source: "Unsold proposal", city: "Scottsdale, AZ", value: 41200, score: 69, status: "analyzed", age: "12 mo", nextAction: "Prepare revised proposal angle", note: "Stalled reason: scope too large. Angle: phase-one package." },
  { id: "L-037", name: "Eddie Tran", trade: "Roof repair", source: "Webhook lead", city: "Gilbert, AZ", value: 5100, score: 64, status: "contacted", age: "1 mo", nextAction: "Reply-classification watching inbox", note: "Fresh webhook lead recovered same week (simulated send)." },
  { id: "L-038", name: "Paula Rios", trade: "Pool build", source: "Website inquiry", city: "Queen Creek, AZ", value: 68500, score: 87, status: "replied", age: "8 mo", nextAction: "Offer design consult times", note: "Replied “yes, still planning for spring” — hot opportunity." },
  { id: "L-039", name: "Stan Bickford", trade: "Concrete driveway", source: "CSV import", city: "Phoenix, AZ", value: 7600, score: 43, status: "analyzed", age: "17 mo", nextAction: "Low priority — quarterly touch", note: "Cold but valid record; kept in long-cycle nurture." },
  { id: "L-040", name: "Wendy Okafor", trade: "HVAC replacement", source: "Old estimate", city: "Mesa, AZ", value: 12700, score: 81, status: "won", age: "6 mo", nextAction: "Attribution recorded", note: "Closed 5 months after original estimate — recovered revenue attributed." },
];

// ── Derived aggregates (computed so the dashboard always matches the dataset) ──

const active = demoLeads.filter(l => l.status !== "merged");
const sum = (leads: DemoLead[]) => leads.reduce((total, l) => total + l.value, 0);

export const demoSummary = {
  imported: demoLeads.length,
  analyzed: active.length,
  highPotential: active.filter(l => l.score >= 75).length,
  conversations: active.filter(l => ["replied", "appointment", "won"].includes(l.status)).length,
  appointments: active.filter(l => ["appointment", "won"].includes(l.status)).length,
  won: active.filter(l => l.status === "won").length,
  recoveredRevenue: sum(active.filter(l => l.status === "won")),
  pipelineValue: sum(active.filter(l => ["replied", "appointment"].includes(l.status))),
  suppressed: active.filter(l => l.status === "suppressed").length,
};

export const demoFunnel = [
  { stage: "Imported", count: demoLeads.length },
  { stage: "Analyzed", count: active.length },
  { stage: "Contacted", count: active.filter(l => ["contacted", "replied", "appointment", "won"].includes(l.status)).length },
  { stage: "Replied", count: active.filter(l => ["replied", "appointment", "won"].includes(l.status)).length },
  { stage: "Appointments", count: active.filter(l => ["appointment", "won"].includes(l.status)).length },
  { stage: "Jobs sold", count: active.filter(l => l.status === "won").length },
];

export const hotOpportunities = [...active]
  .filter(l => !["suppressed", "won"].includes(l.status))
  .sort((a, b) => b.score - a.score)
  .slice(0, 6);

export type DemoCampaign = {
  name: string;
  channel: string;
  status: string;
  sent: number;
  replies: number;
  appointments: number;
  pipeline: number;
};

export const demoCampaigns: DemoCampaign[] = [
  { name: "Dormant Estimate Revival", channel: "SMS", status: "Simulated", sent: 24, replies: 6, appointments: 3, pipeline: 61200 },
  { name: "Missed Call Win-Back", channel: "SMS", status: "Simulated", sent: 11, replies: 2, appointments: 1, pipeline: 27500 },
  { name: "Unsold Proposal Follow-Up", channel: "Email", status: "Simulated", sent: 14, replies: 4, appointments: 1, pipeline: 148500 },
  { name: "Spring Re-Check", channel: "Email", status: "Draft", sent: 0, replies: 0, appointments: 0, pipeline: 0 },
];

export const demoActivity = [
  { when: "12 min ago", text: "Mike Harrigan confirmed Thursday 10:00 AM estimate visit.", kind: "appointment" },
  { when: "1 hr ago", text: "Paula Rios replied: “yes, still planning for spring.” Marked hot.", kind: "reply" },
  { when: "3 hrs ago", text: "Ted Kowalski replied STOP — suppressed across all channels.", kind: "suppression" },
  { when: "5 hrs ago", text: "Duplicate detected: “Bob Chen” merged into Robert Chen.", kind: "cleanup" },
  { when: "Yesterday", text: "Sandra Ellis flagged for manual approval (estimated value $145,000).", kind: "review" },
  { when: "Yesterday", text: "Karen Voss stage update synchronized back to connected CRM.", kind: "sync" },
  { when: "2 days ago", text: "Carl Jensen imported via webhook, cleaned, and scored 61.", kind: "import" },
  { when: "2 days ago", text: "Sam Delgado phone marked invalid — email-only outreach recommended.", kind: "cleanup" },
  { when: "3 days ago", text: "Gloria Whitman job closed at $11,200 — attributed to Dormant Estimate Revival.", kind: "won" },
];

export const currency = (n: number) => `$${n.toLocaleString("en-US")}`;
