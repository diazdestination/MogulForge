import { NextResponse } from "next/server";
import { getOpenAIClient } from "@/lib/openai";
import { rescueInputSchema } from "@/lib/rescue-schema";

export const runtime = "nodejs";

function directionalAssessment(input: ReturnType<typeof rescueInputSchema.parse>) {
  const opportunity = input.averageJobValue * input.monthlyLeadVolume;
  const low = Math.round(opportunity * 0.08 / 100) * 100;
  const high = Math.round(opportunity * 0.22 / 100) * 100;
  const hasDefinedFollowUp = !/none|manual|when we can|no process/i.test(input.followUpProcess);
  const score = Math.max(35, Math.min(82, 52 + (hasDefinedFollowUp ? 12 : 0) + (input.monthlyLeadVolume > 20 ? 6 : 0)));
  return {
    score,
    estimatedMonthlyLeakage: `$${low.toLocaleString()}–$${Math.max(high, low).toLocaleString()}`,
    topLeaks: [
      { title: "Lead response gap", impact: "Every delayed reply gives a ready buyer time to choose another provider.", fix: "Add immediate confirmation and a five-minute response workflow." },
      { title: "Conversion path friction", impact: `At an average value of $${input.averageJobValue.toLocaleString()}, even a small conversion lift can be meaningful.`, fix: "Give each high-intent page one clear next step and proof near the call to action." },
      { title: "Unrecovered opportunities", impact: "Unclosed estimates and older leads often receive no structured second chance.", fix: "Install estimate follow-up and a simple lead-reactivation sequence." },
    ],
    quickWins: ["Reply to every new lead immediately", "Simplify the primary website call to action", "Follow up on every open estimate"],
    summary: `${input.businessName} has a credible opportunity to recover more value from its existing ${input.industry.toLowerCase()} demand in ${input.serviceArea}. This first-pass estimate is directional and should be confirmed with your real pipeline data.`,
  };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = rescueInputSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const firstIssue = Object.values(issues).flat().find(Boolean);
    return NextResponse.json({ error: firstIssue ?? "Please check the form fields.", issues }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ result: directionalAssessment(parsed.data), mode: "directional" });
  }
  try {
    const response = await getOpenAIClient().responses.create({
      model: process.env.OPENAI_MODEL ?? "gpt-5.6-luna",
      instructions: "You are MogulForge's revenue recovery analyst. Give a practical, evidence-aware first-pass assessment. Never claim you inspected data you were not given. Make assumptions explicit. Return concise valid JSON only.",
      input: `Assess this business and return JSON with keys score (integer 0-100), estimatedMonthlyLeakage (string range), topLeaks (array of 3 objects with title, impact, fix), quickWins (array of 3 strings), and summary (string). Business data: ${JSON.stringify(parsed.data)}`,
      text: { verbosity: "medium" },
    });
    const result = JSON.parse(response.output_text);
    return NextResponse.json({ result, responseId: response.id });
  } catch (error) {
    console.error("Revenue Rescue analysis failed", error);
    return NextResponse.json({ result: directionalAssessment(parsed.data), mode: "directional" });
  }
}
