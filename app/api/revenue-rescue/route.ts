import { NextResponse } from "next/server";
import { getOpenAIClient } from "@/lib/openai";
import { rescueInputSchema } from "@/lib/rescue-schema";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = rescueInputSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Please check the form fields.", issues: parsed.error.flatten().fieldErrors }, { status: 400 });
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
    return NextResponse.json({ error: "The analysis could not be completed right now." }, { status: 503 });
  }
}

