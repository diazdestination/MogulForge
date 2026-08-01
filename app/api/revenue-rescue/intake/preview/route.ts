import { NextResponse } from "next/server";
import { ApiError, guard, requireUser } from "@/lib/api-guard";
import { parseUploadedFile, UploadParseError } from "@/lib/rescue-import/parse-upload";
import { autoMapColumns } from "@/lib/rescue-import/mapping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stateless upload preview for the intake wizard: parses the file, returns row
 * count, column preview, and an auto-mapping proposal. Nothing is stored —
 * the file is re-sent with the final intake submission.
 */
export const POST = guard(async (request: Request) => {
  await requireUser();
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw new ApiError(400, "Attach a file to preview.");
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const { headers, rows, fileType } = parseUploadedFile(file.name, buffer);
    const mapping = autoMapColumns(headers, rows.slice(0, 25));
    return NextResponse.json({
      fileName: file.name,
      fileType,
      rowCount: rows.length,
      columns: headers,
      sampleRows: rows.slice(0, 5),
      autoMapping: mapping,
    });
  } catch (error) {
    if (error instanceof UploadParseError) throw new ApiError(400, error.message);
    throw error;
  }
});
