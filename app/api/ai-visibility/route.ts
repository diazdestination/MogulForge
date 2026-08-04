import { NextResponse } from "next/server";
import { getOpenAIClient } from "@/lib/openai";
import { visibilityInputSchema, type VisibilityReport } from "@/lib/visibility-schema";
import { crawlSite } from "@/lib/visibility-crawler";
import { scoreCategories, overallScore, fallbackReport } from "@/lib/visibility-score";
import { getPool } from "@/lib/db";
import { sendLeadEmails } from "@/lib/lead-emails";
import { checkScanRequest, clientIpFromHeaders, getVisibilityLimiters } from "@/lib/visibility-guard";

async function saveReport(url: string, email: string, report: VisibilityReport): Promise<string | null> {
  try {
    const { rows } = await getPool().query(
      "INSERT INTO visibility_reports (url, email, score, report) VALUES ($1, $2, $3, $4) RETURNING id",
      [url, email, report.score, JSON.stringify(report)],
    );
    const reportId: string | null = rows[0]?.id ?? null;
    if (reportId) {
      // sendLeadEmails never throws — email failures are logged and must not
      // break the scan response.
      // Pass the full report so the prospect email can attach the branded PDF.
      await sendLeadEmails({ reportId, email, url, score: report.score, summary: report.summary }, report);
    }
    return reportId;
  } catch (error) {
    console.error("Failed to save visibility report", error);
    return null;
  }
}

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = visibilityInputSchema.safeParse(body);
  if (!parsed.success) {
    const firstIssue = Object.values(parsed.error.flatten().fieldErrors).flat().find(Boolean);
    return NextResponse.json({ error: firstIssue ?? "Enter a valid website address." }, { status: 400 });
  }

  // Abuse protection: disposable-email rejection plus per-IP and per-email
  // throttling, before any crawl or OpenAI spend.
  const verdict = checkScanRequest(getVisibilityLimiters(), {
    ip: clientIpFromHeaders(request.headers),
    email: parsed.data.email,
  });
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: verdict.error },
      {
        status: verdict.status,
        headers: verdict.retryAfterSeconds ? { "Retry-After": String(verdict.retryAfterSeconds) } : undefined,
      },
    );
  }

  const crawled = await crawlSite(parsed.data.url);
  if ("error" in crawled) return NextResponse.json({ error: crawled.error }, { status: 422 });

  const { signals } = crawled;
  const categories = scoreCategories(signals);
  const deterministic = fallbackReport(signals, categories);
  if (!process.env.OPENAI_API_KEY) {
    const reportId = await saveReport(signals.finalUrl, parsed.data.email, deterministic);
    return NextResponse.json({ result: deterministic, reportId, mode: "directional" });
  }

  try {
    const response = await getOpenAIClient().responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
      instructions:
        "You are MogulForge's AI visibility analyst. You are given verified crawl facts and deterministic category scores for a website. Base every statement strictly on those facts — never invent findings. Keep the provided numeric scores unchanged. Return concise valid JSON only.",
      input: `Write the narrative for an AI Visibility report. Return JSON with keys: summary (string, 2-3 sentences, plain language, references the strongest and weakest areas), recommendations (array of exactly 3 objects with title, why, fix — prioritized by impact, practical, grounded in the facts). Crawl facts: ${JSON.stringify(signals)} Category scores: ${JSON.stringify(categories)} Overall score: ${overallScore(categories)}`,
      text: { verbosity: "medium" },
    });
    const ai = JSON.parse(response.output_text) as Pick<VisibilityReport, "summary" | "recommendations">;
    if (!ai?.summary || !Array.isArray(ai.recommendations)) throw new Error("Malformed AI response");
    const result: VisibilityReport = { ...deterministic, summary: ai.summary, recommendations: ai.recommendations.slice(0, 3) };
    const reportId = await saveReport(signals.finalUrl, parsed.data.email, result);
    return NextResponse.json({ result, reportId, responseId: response.id });
  } catch (error) {
    console.error("AI Visibility analysis failed", error);
    const reportId = await saveReport(signals.finalUrl, parsed.data.email, deterministic);
    return NextResponse.json({ result: deterministic, reportId, mode: "directional" });
  }
}
