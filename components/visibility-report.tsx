import type { VisibilityReport } from "@/lib/visibility-schema";

function ScoreBar({ score }: { score: number }) {
  return <div className="h-2 w-full overflow-hidden rounded-full bg-white/10"><div className="h-full rounded-full bg-gradient-to-r from-forge-rust via-yellow-400 to-forge-lime transition-all" style={{ width: `${score}%` }} /></div>;
}

export function VisibilityReportView({ report, scannedUrl }: { report: VisibilityReport; scannedUrl?: string }) {
  return <div>
    <p className="eyebrow">Your AI Visibility Score</p>
    {scannedUrl && <p className="mt-2 text-sm text-white/40">{scannedUrl}</p>}
    <div className="mt-6 font-display text-8xl font-semibold text-forge-lime">{report.score}<span className="text-2xl text-white/30">/100</span></div>
    <p className="mt-5 max-w-2xl text-white/65">{report.summary}</p>
    <div className="mt-9 grid gap-4 sm:grid-cols-2">
      {report.categories.map((cat) => <div key={cat.name} className="rounded-xl border border-white/10 p-5">
        <div className="flex items-baseline justify-between gap-3"><h3 className="font-extrabold">{cat.name}</h3><span className="font-display text-2xl font-semibold text-forge-lime">{cat.score}</span></div>
        <div className="mt-3"><ScoreBar score={cat.score} /></div>
        <ul className="mt-4 space-y-2 text-sm text-white/50">{cat.findings.map((f) => <li key={f} className="flex gap-2"><span aria-hidden className="text-forge-lime">·</span><span>{f}</span></li>)}</ul>
      </div>)}
    </div>
    <h3 className="mt-10 font-display text-2xl font-semibold">Priority fixes</h3>
    <div className="mt-4 space-y-4">{report.recommendations.map((rec) => <div key={rec.title} className="rounded-xl border border-white/10 p-5">
      <h4 className="font-extrabold">{rec.title}</h4>
      <p className="mt-2 text-sm text-white/50">{rec.why}</p>
      <p className="mt-3 text-sm text-forge-lime">Next move: {rec.fix}</p>
    </div>)}</div>
  </div>;
}
