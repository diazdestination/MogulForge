/**
 * CSV parsing + serialization with spreadsheet formula-injection prevention.
 * Pure module — no server-only imports, directly unit-testable.
 */

/** RFC-4180-style CSV parser: quoted fields, escaped quotes, CR/LF/CRLF newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      sawAny = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      sawAny = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawAny = false;
    } else {
      field += ch;
      sawAny = true;
    }
  }
  if (sawAny || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Drop fully empty trailing rows
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

/**
 * Escapes a cell for CSV export with formula-injection prevention: values that a
 * spreadsheet would evaluate (`=`, `+`, `-`, `@`, tab, CR) are prefixed with a
 * single quote so they render as text instead of executing.
 */
export function escapeCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Serializes rows to CSV, formula-injection-safe. */
export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n") + "\r\n";
}
