/**
 * Canonical lead fields for the Revenue Rescue import pipeline, plus the sample
 * CSV template. Pure module — safe to import from client, server, and tests.
 */

export type LeadFieldKey =
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "address"
  | "city"
  | "state"
  | "zip"
  | "projectType"
  | "projectDescription"
  | "estimatedValue"
  | "source"
  | "sourceDetail"
  | "externalRecordId"
  | "firstContactDate"
  | "lastContactDate"
  | "estimateDate"
  | "consentStatus"
  | "notes";

export type LeadFieldDef = {
  key: LeadFieldKey;
  label: string;
  /** Column header used in the sample template. */
  templateHeader: string;
  /** Lowercased, alphanumeric-only header aliases that auto-map to this field. */
  aliases: string[];
  kind: "text" | "email" | "phone" | "number" | "date";
};

export const LEAD_FIELDS: LeadFieldDef[] = [
  { key: "firstName", label: "First name", templateHeader: "first_name", kind: "text", aliases: ["firstname", "fname", "first", "givenname"] },
  { key: "lastName", label: "Last name", templateHeader: "last_name", kind: "text", aliases: ["lastname", "lname", "last", "surname", "familyname"] },
  { key: "email", label: "Email", templateHeader: "email", kind: "email", aliases: ["email", "emailaddress", "mail", "contactemail", "customeremail"] },
  { key: "phone", label: "Phone", templateHeader: "phone", kind: "phone", aliases: ["phone", "phonenumber", "mobile", "cell", "cellphone", "telephone", "tel", "contactphone", "mobilephone"] },
  { key: "address", label: "Street address", templateHeader: "address", kind: "text", aliases: ["address", "street", "streetaddress", "address1", "addressline1"] },
  { key: "city", label: "City", templateHeader: "city", kind: "text", aliases: ["city", "town"] },
  { key: "state", label: "State", templateHeader: "state", kind: "text", aliases: ["state", "province", "region"] },
  { key: "zip", label: "ZIP / postal code", templateHeader: "zip", kind: "text", aliases: ["zip", "zipcode", "postal", "postalcode", "postcode"] },
  { key: "projectType", label: "Project type", templateHeader: "project_type", kind: "text", aliases: ["projecttype", "jobtype", "servicetype", "service", "worktype", "tradetype"] },
  { key: "projectDescription", label: "Project description", templateHeader: "project_description", kind: "text", aliases: ["projectdescription", "jobdescription", "description", "scope", "workdescription", "details"] },
  { key: "estimatedValue", label: "Estimated value ($)", templateHeader: "estimated_value", kind: "number", aliases: ["estimatedvalue", "value", "estimateamount", "jobvalue", "amount", "quoteamount", "price", "dealvalue", "projectvalue", "bidamount"] },
  { key: "source", label: "Lead source", templateHeader: "lead_source", kind: "text", aliases: ["source", "leadsource", "channel", "origin", "howheard"] },
  { key: "sourceDetail", label: "Source detail", templateHeader: "source_detail", kind: "text", aliases: ["sourcedetail", "campaign", "campaignname", "adname", "medium"] },
  { key: "externalRecordId", label: "External record ID", templateHeader: "external_record_id", kind: "text", aliases: ["externalrecordid", "externalid", "recordid", "crmid", "leadid", "id", "contactid"] },
  { key: "firstContactDate", label: "First contact date", templateHeader: "first_contact_date", kind: "date", aliases: ["firstcontactdate", "firstcontact", "createddate", "datecreated", "createdat", "dateadded", "leaddate"] },
  { key: "lastContactDate", label: "Last contact date", templateHeader: "last_contact_date", kind: "date", aliases: ["lastcontactdate", "lastcontact", "lastactivity", "lastactivitydate", "lasttouch", "modifieddate", "updatedat"] },
  { key: "estimateDate", label: "Estimate date", templateHeader: "estimate_date", kind: "date", aliases: ["estimatedate", "quotedate", "proposaldate", "biddate"] },
  { key: "consentStatus", label: "Consent status", templateHeader: "consent_status", kind: "text", aliases: ["consentstatus", "consent", "optin", "optinstatus", "optout", "subscribed", "emailoptin", "smsconsent", "donotcontact", "dnc"] },
  { key: "notes", label: "Notes", templateHeader: "notes", kind: "text", aliases: ["notes", "note", "comments", "comment", "remarks"] },
];

export const LEAD_FIELD_BY_KEY: Record<LeadFieldKey, LeadFieldDef> = Object.fromEntries(
  LEAD_FIELDS.map((field) => [field.key, field]),
) as Record<LeadFieldKey, LeadFieldDef>;

export function isLeadFieldKey(value: string): value is LeadFieldKey {
  return Object.prototype.hasOwnProperty.call(LEAD_FIELD_BY_KEY, value);
}

export const SAMPLE_TEMPLATE_ROWS: string[][] = [
  LEAD_FIELDS.map((field) => field.templateHeader),
  ["Maria", "Lopez", "maria.lopez@example.com", "(555) 201-7788", "412 Cedar Ln", "Springfield", "OH", "45501", "Roof replacement", "Full tear-off quoted after hail storm", "18500", "Website form", "Storm landing page", "CRM-10041", "2025-04-12", "2025-05-02", "2025-04-20", "express", "Asked us to call back in fall"],
  ["James", "Carter", "j.carter@example.com", "555-318-2244", "88 Birch Rd", "Dayton", "OH", "45402", "Gutter install", "Estimate sent, never followed up", "3200", "Missed call", "", "CRM-10087", "2025-06-03", "2025-06-03", "", "unknown", ""],
  ["Dana", "Whitfield", "", "5554430912", "9 Elm Ct", "Columbus", "OH", "43004", "Siding repair", "Wind damage, insurance claim pending", "7400", "Facebook lead ad", "Spring siding campaign", "CRM-10112", "2025-03-19", "2025-03-27", "2025-03-25", "opted_out", "Requested no further texts"],
];

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB
export const MAX_IMPORT_ROWS = 20000;
export const ACCEPTED_EXTENSIONS = ["csv", "xlsx", "xls", "json"] as const;
export type AcceptedExtension = (typeof ACCEPTED_EXTENSIONS)[number];

export function fileExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName.trim());
  return match ? match[1].toLowerCase() : "";
}

export function isAcceptedExtension(ext: string): ext is AcceptedExtension {
  return (ACCEPTED_EXTENSIONS as readonly string[]).includes(ext);
}
