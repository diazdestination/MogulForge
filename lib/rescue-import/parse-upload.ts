/**
 * Uploaded-file parsing for the lead import pipeline: CSV, XLSX, XLS, JSON.
 * Server-side only in practice (SheetJS), but kept free of `server-only` so the
 * parsing logic stays directly unit-testable.
 */
import * as XLSX from "xlsx";
import { parseCsv } from "./csv.ts";
import { MAX_IMPORT_ROWS, MAX_UPLOAD_BYTES, fileExtension, isAcceptedExtension, type AcceptedExtension } from "./fields.ts";

export type ParsedUpload = {
  headers: string[];
  /** Data rows (header row excluded), each cell stringified + trimmed. */
  rows: string[][];
  fileType: AcceptedExtension;
};

export class UploadParseError extends Error {}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function fromMatrix(matrix: unknown[][]): { headers: string[]; rows: string[][] } {
  const nonEmpty = matrix
    .map((row) => (Array.isArray(row) ? row.map(stringifyCell) : []))
    .filter((row) => row.some((cell) => cell !== ""));
  if (nonEmpty.length < 1) throw new UploadParseError("The file is empty.");
  const headers = nonEmpty[0].map((h, i) => (h === "" ? `Column ${i + 1}` : h));
  const rows = nonEmpty.slice(1).map((row) => headers.map((_, i) => row[i] ?? ""));
  if (rows.length === 0) throw new UploadParseError("The file has a header row but no data rows.");
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new UploadParseError(`The file has ${rows.length.toLocaleString()} rows — the limit is ${MAX_IMPORT_ROWS.toLocaleString()} per import. Split it into smaller files.`);
  }
  return { headers, rows };
}

function parseJsonUpload(buffer: Buffer): { headers: string[]; rows: string[][] } {
  let data: unknown;
  try {
    data = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new UploadParseError("The file is not valid JSON.");
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray((data as { leads?: unknown[] }).leads)
      ? (data as { leads: unknown[] }).leads
      : data && typeof data === "object" && Array.isArray((data as { records?: unknown[] }).records)
        ? (data as { records: unknown[] }).records
        : null;
  if (!list) throw new UploadParseError("JSON imports must be an array of objects (or { \"leads\": [...] }).");
  const objects = list.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  if (objects.length === 0) throw new UploadParseError("The JSON file contains no lead objects.");
  const headers: string[] = [];
  for (const obj of objects) for (const key of Object.keys(obj)) if (!headers.includes(key)) headers.push(key);
  const matrix: unknown[][] = [headers, ...objects.map((obj) => headers.map((key) => obj[key]))];
  return fromMatrix(matrix);
}

/**
 * Parses an uploaded lead file. Validates extension + size and returns headers
 * and stringified data rows. Throws UploadParseError with a user-facing message.
 */
export function parseUploadedFile(fileName: string, buffer: Buffer): ParsedUpload {
  if (buffer.length === 0) throw new UploadParseError("The file is empty.");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new UploadParseError(`The file is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }
  const ext = fileExtension(fileName);
  if (!isAcceptedExtension(ext)) {
    throw new UploadParseError("Unsupported file type. Upload a .csv, .xlsx, .xls, or .json file.");
  }
  if (ext === "json") return { ...parseJsonUpload(buffer), fileType: ext };
  if (ext === "csv") {
    const matrix = parseCsv(buffer.toString("utf8"));
    return { ...fromMatrix(matrix), fileType: ext };
  }
  // xlsx / xls via SheetJS
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, dense: true });
  } catch {
    throw new UploadParseError("Could not read the spreadsheet. Re-save it as .xlsx or export a CSV and try again.");
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) throw new UploadParseError("The spreadsheet has no sheets.");
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
  return { ...fromMatrix(matrix), fileType: ext };
}
