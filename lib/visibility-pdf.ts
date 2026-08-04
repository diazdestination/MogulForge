import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";
import type { VisibilityReport } from "./visibility-schema";

// MogulForge brand palette (mirrors tailwind.config.ts "forge" colors).
const INK = rgb(0x09 / 255, 0x0d / 255, 0x0c / 255);
const LIME = rgb(0xc9 / 255, 0xf7 / 255, 0x5d / 255);
const CREAM = rgb(0xf3 / 255, 0xf0 / 255, 0xe8 / 255);
const RUST = rgb(0xe3 / 255, 0x6c / 255, 0x3d / 255);
const MUTED = rgb(0.62, 0.64, 0.62);
const FAINT = rgb(0.42, 0.44, 0.42);
const CARD = rgb(0x11 / 255, 0x17 / 255, 0x15 / 255);
const BORDER = rgb(0.2, 0.22, 0.2);

const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const MARGIN = 48;
const CONTENT_W = PAGE_W - MARGIN * 2;

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const words = clean.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) line = candidate;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
};

function paintBackground(page: PDFPage) {
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: INK });
  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: LIME });
}

function addPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  paintBackground(ctx.page);
  ctx.y = PAGE_H - MARGIN - 12;
}

function ensureRoom(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN + 24) addPage(ctx);
}

function drawWrapped(ctx: Ctx, text: string, opts: { font: PDFFont; size: number; color: RGB; x?: number; maxWidth?: number; lineGap?: number }): void {
  const x = opts.x ?? MARGIN;
  const maxWidth = opts.maxWidth ?? CONTENT_W;
  const lineHeight = opts.size + (opts.lineGap ?? 4);
  for (const line of wrapText(text, opts.font, opts.size, maxWidth)) {
    ensureRoom(ctx, lineHeight);
    ctx.page.drawText(line, { x, y: ctx.y - opts.size, size: opts.size, font: opts.font, color: opts.color });
    ctx.y -= lineHeight;
  }
}

function scoreColor(score: number): RGB {
  if (score >= 70) return LIME;
  if (score >= 40) return rgb(0.98, 0.8, 0.25);
  return RUST;
}

function drawScoreBar(ctx: Ctx, score: number, x: number, width: number) {
  const h = 5;
  ensureRoom(ctx, h + 8);
  const y = ctx.y - h;
  ctx.page.drawRectangle({ x, y, width, height: h, color: rgb(0.16, 0.18, 0.16) });
  ctx.page.drawRectangle({ x, y, width: Math.max(2, (Math.min(100, Math.max(0, score)) / 100) * width), height: h, color: scoreColor(score) });
  ctx.y -= h + 8;
}

function drawWordmark(page: PDFPage, bold: PDFFont) {
  const cx = MARGIN + 13;
  const cy = PAGE_H - MARGIN - 1;
  page.drawCircle({ x: cx, y: cy, size: 13, borderColor: LIME, borderWidth: 1.2 });
  page.drawText("MF", { x: cx - bold.widthOfTextAtSize("MF", 8) / 2, y: cy - 3, size: 8, font: bold, color: LIME });
  page.drawText("MOGULFORGE", { x: cx + 20, y: cy - 4, size: 12, font: bold, color: CREAM });
}

/** Renders a stored AI Visibility report as a branded (dark) PDF. */
export async function renderVisibilityPdf(input: { report: VisibilityReport; url: string; createdAt: Date; reportUrl?: string }): Promise<Uint8Array> {
  const { report, url, createdAt } = input;
  const doc = await PDFDocument.create();
  doc.setTitle(`AI Visibility Report — ${url}`);
  doc.setAuthor("MogulForge");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, page: doc.addPage([PAGE_W, PAGE_H]), y: 0, regular, bold };
  paintBackground(ctx.page);
  drawWordmark(ctx.page, bold);
  ctx.y = PAGE_H - MARGIN - 44;

  // Header
  drawWrapped(ctx, "YOUR AI VISIBILITY SCORE", { font: bold, size: 10, color: LIME, lineGap: 6 });
  drawWrapped(ctx, url, { font: regular, size: 10, color: MUTED, lineGap: 10 });

  // Big score
  ensureRoom(ctx, 64);
  const scoreText = String(report.score);
  ctx.page.drawText(scoreText, { x: MARGIN, y: ctx.y - 52, size: 56, font: bold, color: LIME });
  ctx.page.drawText("/100", { x: MARGIN + bold.widthOfTextAtSize(scoreText, 56) + 6, y: ctx.y - 52, size: 18, font: regular, color: FAINT });
  ctx.y -= 70;

  drawWrapped(ctx, report.summary, { font: regular, size: 11, color: CREAM, lineGap: 5 });
  ctx.y -= 14;

  // Categories
  for (const cat of report.categories) {
    const findingLines = cat.findings.flatMap((f) => wrapText(f, regular, 9.5, CONTENT_W - 44));
    const cardHeight = 46 + findingLines.length * 13.5 + 10;
    ensureRoom(ctx, cardHeight + 10);
    const top = ctx.y;
    ctx.page.drawRectangle({ x: MARGIN, y: top - cardHeight, width: CONTENT_W, height: cardHeight, color: CARD, borderColor: BORDER, borderWidth: 0.75 });
    ctx.y -= 16;
    ctx.page.drawText(cat.name, { x: MARGIN + 16, y: ctx.y - 11, size: 11, font: bold, color: CREAM });
    const catScore = String(cat.score);
    ctx.page.drawText(catScore, { x: MARGIN + CONTENT_W - 16 - bold.widthOfTextAtSize(catScore, 14), y: ctx.y - 11, size: 14, font: bold, color: scoreColor(cat.score) });
    ctx.y -= 20;
    drawScoreBar(ctx, cat.score, MARGIN + 16, CONTENT_W - 32);
    for (const line of findingLines) {
      ctx.page.drawText("•", { x: MARGIN + 16, y: ctx.y - 9.5, size: 9.5, font: regular, color: LIME });
      ctx.page.drawText(line, { x: MARGIN + 28, y: ctx.y - 9.5, size: 9.5, font: regular, color: MUTED });
      ctx.y -= 13.5;
    }
    ctx.y = top - cardHeight - 10;
  }

  // Priority fixes
  ensureRoom(ctx, 40);
  ctx.y -= 8;
  drawWrapped(ctx, "Priority fixes", { font: bold, size: 16, color: CREAM, lineGap: 10 });
  for (const rec of report.recommendations) {
    const whyLines = wrapText(rec.why, regular, 9.5, CONTENT_W - 32);
    const fixLines = wrapText(`Next move: ${rec.fix}`, regular, 9.5, CONTENT_W - 32);
    const titleLines = wrapText(rec.title, bold, 11, CONTENT_W - 32);
    const cardHeight = 18 + titleLines.length * 14 + whyLines.length * 13 + 6 + fixLines.length * 13 + 12;
    ensureRoom(ctx, cardHeight + 10);
    const top = ctx.y;
    ctx.page.drawRectangle({ x: MARGIN, y: top - cardHeight, width: CONTENT_W, height: cardHeight, color: CARD, borderColor: BORDER, borderWidth: 0.75 });
    ctx.y -= 16;
    for (const line of titleLines) {
      ctx.page.drawText(line, { x: MARGIN + 16, y: ctx.y - 11, size: 11, font: bold, color: CREAM });
      ctx.y -= 14;
    }
    ctx.y -= 2;
    for (const line of whyLines) {
      ctx.page.drawText(line, { x: MARGIN + 16, y: ctx.y - 9.5, size: 9.5, font: regular, color: MUTED });
      ctx.y -= 13;
    }
    ctx.y -= 6;
    for (const line of fixLines) {
      ctx.page.drawText(line, { x: MARGIN + 16, y: ctx.y - 9.5, size: 9.5, font: regular, color: LIME });
      ctx.y -= 13;
    }
    ctx.y = top - cardHeight - 10;
  }

  // Footer on every page
  const dateText = createdAt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const pages = doc.getPages();
  pages.forEach((page, i) => {
    page.drawText(`Scanned ${dateText} by MogulForge AI Visibility Scan`, { x: MARGIN, y: MARGIN - 18, size: 8, font: regular, color: FAINT });
    const pageLabel = `${i + 1} / ${pages.length}`;
    page.drawText(pageLabel, { x: PAGE_W - MARGIN - regular.widthOfTextAtSize(pageLabel, 8), y: MARGIN - 18, size: 8, font: regular, color: FAINT });
    if (i > 0) drawWordmark(page, bold);
  });

  return doc.save();
}
