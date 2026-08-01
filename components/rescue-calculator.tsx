"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { calculatorDefaults } from "@/lib/rescue-config";

type Field = {
  key: keyof typeof calculatorDefaults;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
};

const fields: Field[] = [
  { key: "dormantLeads", label: "Dormant leads in your database", min: 50, max: 10000, step: 50, format: v => v.toLocaleString() },
  { key: "averageProjectValue", label: "Average project value", min: 500, max: 150000, step: 500, format: v => `$${v.toLocaleString()}` },
  { key: "reactivationRate", label: "Estimated reactivation rate", min: 0.01, max: 0.25, step: 0.01, format: v => `${Math.round(v * 100)}%` },
  { key: "bookingRate", label: "Appointment booking rate", min: 0.05, max: 0.8, step: 0.05, format: v => `${Math.round(v * 100)}%` },
  { key: "closeRate", label: "Sales close rate", min: 0.05, max: 0.8, step: 0.05, format: v => `${Math.round(v * 100)}%` },
];

export function RescueCalculator() {
  const [values, setValues] = useState({ ...calculatorDefaults });

  const reactivatedLeads = values.dormantLeads * values.reactivationRate;
  const bookedAppointments = reactivatedLeads * values.bookingRate;
  const soldProjects = bookedAppointments * values.closeRate;
  const estimatedRevenue = soldProjects * values.averageProjectValue;

  const outputs = [
    { label: "Conversations restarted", value: Math.round(reactivatedLeads).toLocaleString() },
    { label: "Appointments booked", value: Math.round(bookedAppointments).toLocaleString() },
    { label: "Projects sold", value: soldProjects >= 10 ? Math.round(soldProjects).toLocaleString() : soldProjects.toFixed(1) },
  ];

  return <div className="grid gap-6 lg:grid-cols-[1.1fr_.9fr]">
    <div className="rounded-[2rem] border border-white/10 bg-white/[.03] p-6 sm:p-10">
      <p className="eyebrow">Your assumptions</p>
      <div className="mt-8 space-y-8">
        {fields.map(f => <label key={f.key} className="block">
          <span className="flex items-center justify-between text-sm font-bold">
            {f.label}
            <span className="rounded-full border border-forge-lime/30 bg-forge-lime/10 px-3 py-1 text-xs font-extrabold text-forge-lime">{f.format(values[f.key])}</span>
          </span>
          <input
            type="range"
            min={f.min}
            max={f.max}
            step={f.step}
            value={values[f.key]}
            onChange={e => setValues(v => ({ ...v, [f.key]: Number(e.target.value) }))}
            className="mt-4 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-forge-lime"
            aria-label={f.label}
          />
          <span className="mt-1.5 flex justify-between text-[11px] text-white/30"><span>{f.format(f.min)}</span><span>{f.format(f.max)}</span></span>
        </label>)}
      </div>
    </div>

    <div className="flex flex-col rounded-[2rem] border border-forge-lime/30 bg-forge-lime/[.05] p-6 sm:p-10">
      <p className="eyebrow">Estimated recovery</p>
      <div className="mt-8 space-y-4">
        {outputs.map(o => <div key={o.label} className="flex items-center justify-between border-b border-white/10 pb-4">
          <span className="text-sm text-white/60">{o.label}</span>
          <span className="font-display text-4xl font-semibold">{o.value}</span>
        </div>)}
      </div>
      <div className="mt-8">
        <p className="text-sm text-white/60">Estimated recovered revenue</p>
        <p className="mt-2 font-display text-6xl font-semibold leading-none text-forge-lime sm:text-7xl">${Math.round(estimatedRevenue).toLocaleString()}</p>
      </div>
      <p className="mt-8 rounded-xl border border-white/10 bg-forge-ink/60 p-4 text-xs leading-5 text-white/45">These figures are estimates based on the assumptions you set above — not guarantees. Actual results depend on your data quality, offer, market, and sales follow-through.</p>
      <Link href="/contact" className="btn-primary mt-8 w-full">Start a Revenue Rescue Sprint <ArrowRight size={16} /></Link>
      <Link href="/revenue-rescue/demo" className="btn-secondary mt-3 w-full">See it working in the demo</Link>
    </div>
  </div>;
}
