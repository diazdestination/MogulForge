/**
 * Unit tests for the lead-import building blocks: CSV parsing, Excel parsing,
 * auto-mapping, normalization, and formula-injection prevention.
 * Pure-module tests — run directly against the TypeScript sources
 * (Node 22 strips types natively). No server or database required.
 *
 *   npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { parseCsv, escapeCsvCell, toCsv } from "../lib/rescue-import/csv.ts";
import { normalizeEmail, normalizePhone, normalizeDate, normalizeMoney, normalizeConsent } from "../lib/rescue-import/normalize.ts";
import { autoMapColumns, mappingHasContactField } from "../lib/rescue-import/mapping.ts";
import { parseUploadedFile, UploadParseError } from "../lib/rescue-import/parse-upload.ts";
import { SAMPLE_TEMPLATE_ROWS, MAX_UPLOAD_BYTES } from "../lib/rescue-import/fields.ts";

// ---------- CSV parsing ----------

test("parseCsv handles quotes, escaped quotes, commas, and CRLF", () => {
  const rows = parseCsv('name,notes\r\n"Lopez, Maria","She said ""call in fall"""\r\nplain,value\n');
  assert.deepEqual(rows, [
    ["name", "notes"],
    ["Lopez, Maria", 'She said "call in fall"'],
    ["plain", "value"],
  ]);
});

test("parseCsv strips BOM and skips fully empty rows", () => {
  const rows = parseCsv("\uFEFFa,b\n1,2\n,\n3,4");
  assert.deepEqual(rows, [["a", "b"], ["1", "2"], ["3", "4"]]);
});

test("parseCsv handles newlines inside quoted fields", () => {
  const rows = parseCsv('a,b\n"line1\nline2",x');
  assert.deepEqual(rows, [["a", "b"], ["line1\nline2", "x"]]);
});

// ---------- Formula-injection prevention ----------

test("escapeCsvCell neutralizes formula-injection payloads", () => {
  assert.equal(escapeCsvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(escapeCsvCell("+1-555"), "'+1-555");
  assert.equal(escapeCsvCell("-2+3"), "'-2+3");
  assert.equal(escapeCsvCell("@cmd"), "'@cmd");
  assert.equal(escapeCsvCell("\tpayload"), "'\tpayload");
  assert.equal(escapeCsvCell("safe"), "safe");
});

test("toCsv quotes separators and keeps injection guard", () => {
  const csv = toCsv([["a", "=HYPERLINK(\"http://evil\")"], ["with,comma", "plain"]]);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil""\)"/);
  assert.match(csv, /"with,comma"/);
  // Round-trips: the escaped formula stays inert text.
  const parsed = parseCsv(csv);
  assert.equal(parsed[0][1][0], "'");
});

// ---------- Normalization ----------

test("normalizePhone normalizes US numbers to E.164 and rejects garbage", () => {
  assert.equal(normalizePhone("(555) 201-7788"), "+15552017788");
  assert.equal(normalizePhone("1-555-201-7788"), "+15552017788");
  assert.equal(normalizePhone("5552017788"), "+15552017788");
  assert.equal(normalizePhone("555-201"), null);
  assert.equal(normalizePhone("call me"), null);
  assert.equal(normalizePhone(""), null);
});

test("normalizeEmail lowercases and validates", () => {
  assert.equal(normalizeEmail("  Maria.Lopez@Example.COM "), "maria.lopez@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
});

test("normalizeDate parses ISO, US, and Excel serial dates", () => {
  assert.equal(normalizeDate("2025-04-12"), "2025-04-12");
  assert.equal(normalizeDate("4/12/2025"), "2025-04-12");
  assert.equal(normalizeDate("04/12/25"), "2025-04-12");
  assert.equal(normalizeDate(45758), "2025-04-11"); // Excel serial
  assert.equal(normalizeDate("13/45/2025"), null);
  assert.equal(normalizeDate("soon"), null);
});

test("normalizeMoney strips currency formatting", () => {
  assert.equal(normalizeMoney("$18,500.00"), 18500);
  assert.equal(normalizeMoney("7400"), 7400);
  assert.equal(normalizeMoney("n/a"), null);
  assert.equal(normalizeMoney("-50"), null);
});

test("normalizeConsent maps opt-outs and opt-ins", () => {
  assert.equal(normalizeConsent("opted_out"), "opted_out");
  assert.equal(normalizeConsent("Do Not Contact"), "opted_out");
  assert.equal(normalizeConsent("UNSUBSCRIBED"), "opted_out");
  assert.equal(normalizeConsent("yes"), "express");
  assert.equal(normalizeConsent("implied"), "implied");
  assert.equal(normalizeConsent("whatever"), "unknown");
  assert.equal(normalizeConsent(""), "unknown");
});

// ---------- Auto-mapping ----------

test("autoMapColumns matches aliases with high confidence", () => {
  const headers = ["First Name", "E-mail Address", "Cell Phone", "Job Value", "Mystery"];
  const rows = [["Maria", "maria@example.com", "(555) 201-7788", "$18,500", "xyz"]];
  const mapping = autoMapColumns(headers, rows);
  const byColumn = Object.fromEntries(mapping.map((m) => [m.sourceColumn, m]));
  assert.equal(byColumn["First Name"].target, "firstName");
  assert.ok(byColumn["First Name"].confidence >= 0.9);
  assert.equal(byColumn["E-mail Address"].target, "email");
  assert.equal(byColumn["Cell Phone"].target, "phone");
  assert.equal(byColumn["Job Value"].target, "estimatedValue");
  assert.equal(byColumn["Mystery"].target, null);
  assert.equal(byColumn["Mystery"].confidence, 0);
});

test("autoMapColumns uses value patterns when headers are useless", () => {
  const headers = ["col1", "col2"];
  const rows = [["someone@example.com", "555-443-0912"]];
  const mapping = autoMapColumns(headers, rows);
  assert.equal(mapping[0].target, "email");
  assert.equal(mapping[1].target, "phone");
  assert.ok(mapping[0].confidence < 0.9);
});

test("autoMapColumns never assigns the same target twice", () => {
  const headers = ["email", "email address", "phone", "mobile"];
  const rows = [["a@b.co", "c@d.co", "5552017788", "5553182244"]];
  const mapping = autoMapColumns(headers, rows);
  const targets = mapping.map((m) => m.target).filter(Boolean);
  assert.equal(new Set(targets).size, targets.length);
});

test("mappingHasContactField requires email or phone", () => {
  assert.equal(mappingHasContactField({ a: "firstName", b: "notes" }), false);
  assert.equal(mappingHasContactField({ a: "firstName", b: "email" }), true);
  assert.equal(mappingHasContactField({ a: "phone" }), true);
});

// ---------- File parsing (CSV / XLSX / XLS / JSON) ----------

test("parseUploadedFile parses the sample CSV template", () => {
  const csv = toCsv(SAMPLE_TEMPLATE_ROWS);
  const parsed = parseUploadedFile("template.csv", Buffer.from(csv));
  assert.equal(parsed.fileType, "csv");
  assert.equal(parsed.headers[0], "first_name");
  assert.equal(parsed.rows.length, 3);
});

test("parseUploadedFile parses xlsx and xls workbooks", () => {
  const data = [
    ["Email", "Phone", "First Name"],
    ["maria@example.com", "(555) 201-7788", "Maria"],
    ["j.carter@example.com", "555-318-2244", "James"],
  ];
  for (const bookType of ["xlsx", "xls"]) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), "Leads");
    const buffer = XLSX.write(wb, { type: "buffer", bookType });
    const parsed = parseUploadedFile(`leads.${bookType}`, Buffer.from(buffer));
    assert.equal(parsed.fileType, bookType);
    assert.deepEqual(parsed.headers, ["Email", "Phone", "First Name"]);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.rows[0][0], "maria@example.com");
  }
});

test("parseUploadedFile parses JSON arrays and {leads: []}", () => {
  const arr = [{ email: "a@b.co", phone: "5552017788" }, { email: "c@d.co", first_name: "C" }];
  const parsed = parseUploadedFile("leads.json", Buffer.from(JSON.stringify(arr)));
  assert.deepEqual(parsed.headers, ["email", "phone", "first_name"]);
  assert.equal(parsed.rows.length, 2);
  const wrapped = parseUploadedFile("leads.json", Buffer.from(JSON.stringify({ leads: arr })));
  assert.equal(wrapped.rows.length, 2);
});

test("parseUploadedFile rejects bad types, empty and oversized files", () => {
  assert.throws(() => parseUploadedFile("leads.pdf", Buffer.from("x")), UploadParseError);
  assert.throws(() => parseUploadedFile("leads.csv", Buffer.alloc(0)), UploadParseError);
  assert.throws(() => parseUploadedFile("leads.csv", Buffer.from("only_header\n")), UploadParseError);
  assert.throws(() => parseUploadedFile("big.csv", Buffer.alloc(MAX_UPLOAD_BYTES + 1, 97)), UploadParseError);
  assert.throws(() => parseUploadedFile("leads.json", Buffer.from("{\"nope\":1}")), UploadParseError);
});
