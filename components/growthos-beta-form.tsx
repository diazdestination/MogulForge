"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { ArrowRight, CheckCircle2 } from "lucide-react";

import {
  growthOSPriorityLabels,
  type GrowthOSInterestInput,
} from "@/lib/growthos-interest-schema";

const inputClass =
  "rounded-xl border border-white/15 bg-black/15 px-4 py-3.5 text-sm text-white outline-none transition placeholder:text-white/25 focus:border-forge-lime focus:ring-1 focus:ring-forge-lime";

export function GrowthOSBetaForm() {
  const [serverError, setServerError] = useState("");
  const [success, setSuccess] = useState("");
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<GrowthOSInterestInput>();

  const submit = async (data: GrowthOSInterestInput) => {
    setServerError("");
    setSuccess("");

    const response = await fetch("/api/growthos-interest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };

    if (!response.ok) {
      setServerError(body.error ?? "We could not save your request. Please try again.");
      return;
    }

    setSuccess(body.message ?? "Your GrowthOS beta request was received.");
    reset();
  };

  if (success) {
    return (
      <div className="grid min-h-[34rem] place-items-center rounded-[2rem] border border-forge-lime/30 bg-forge-lime/[.06] p-8 text-center sm:p-12">
        <div className="max-w-md">
          <CheckCircle2 className="mx-auto h-12 w-12 text-forge-lime" aria-hidden="true" />
          <p className="mt-6 eyebrow">Request received</p>
          <h3 className="mt-4 font-display text-4xl font-semibold">You’re on the list.</h3>
          <p className="mt-5 leading-7 text-white/60">{success}</p>
          <button type="button" className="btn-secondary mt-8" onClick={() => setSuccess("")}>
            Submit another business
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit(submit)}
      className="grid gap-5 rounded-[2rem] border border-white/10 bg-white/[.035] p-6 shadow-2xl shadow-black/20 sm:grid-cols-2 sm:p-8"
    >
      <label className="grid gap-2 text-sm font-bold">
        Full name
        <input className={inputClass} autoComplete="name" {...register("fullName", { required: true })} />
        {errors.fullName && <span className="text-xs text-forge-rust">Enter your full name.</span>}
      </label>
      <label className="grid gap-2 text-sm font-bold">
        Work email
        <input className={inputClass} type="email" autoComplete="email" {...register("workEmail", { required: true })} />
        {errors.workEmail && <span className="text-xs text-forge-rust">Enter a valid work email.</span>}
      </label>
      <label className="grid gap-2 text-sm font-bold">
        Company
        <input className={inputClass} autoComplete="organization" {...register("company", { required: true })} />
        {errors.company && <span className="text-xs text-forge-rust">Enter your company name.</span>}
      </label>
      <label className="grid gap-2 text-sm font-bold">
        Phone <span className="font-normal text-white/35">Optional</span>
        <input className={inputClass} type="tel" autoComplete="tel" {...register("phone")} />
      </label>
      <label className="grid gap-2 text-sm font-bold sm:col-span-2">
        Website <span className="font-normal text-white/35">Optional</span>
        <input className={inputClass} type="text" inputMode="url" placeholder="example.com" {...register("website")} />
      </label>
      <label className="grid gap-2 text-sm font-bold sm:col-span-2">
        What should GrowthOS improve first?
        <select className={inputClass} defaultValue="" {...register("priority", { required: true })}>
          <option value="" disabled className="bg-forge-ink">Choose the highest-priority outcome</option>
          {Object.entries(growthOSPriorityLabels).map(([value, label]) => (
            <option key={value} value={value} className="bg-forge-ink">{label}</option>
          ))}
        </select>
        {errors.priority && <span className="text-xs text-forge-rust">Choose one priority.</span>}
      </label>
      <label className="grid gap-2 text-sm font-bold">
        Approximate monthly leads <span className="font-normal text-white/35">Optional</span>
        <input className={inputClass} type="number" min="0" inputMode="numeric" {...register("monthlyLeads")} />
      </label>
      <label className="grid gap-2 text-sm font-bold sm:col-span-2">
        Anything we should know? <span className="font-normal text-white/35">Optional</span>
        <textarea className={inputClass} rows={3} {...register("notes")} />
      </label>
      <label className="hidden" aria-hidden="true">
        Company fax
        <input tabIndex={-1} autoComplete="off" {...register("companyFax")} />
      </label>
      <label className="flex items-start gap-3 text-xs leading-5 text-white/50 sm:col-span-2">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 accent-[var(--lime)]"
          {...register("consent", { required: true })}
        />
        MogulForge may contact me about GrowthOS beta access. No passwords, inbox access, or business data are requested through this form.
      </label>
      {errors.consent && <p className="text-xs text-forge-rust sm:col-span-2">Confirm that we may contact you about the beta.</p>}
      {serverError && <p role="alert" className="rounded-xl border border-forge-rust/30 bg-forge-rust/10 p-4 text-sm text-forge-rust sm:col-span-2">{serverError}</p>}
      <button type="submit" disabled={isSubmitting} className="btn-primary mt-1 sm:col-span-2">
        {isSubmitting ? "Submitting your request…" : "Request GrowthOS beta access"}
        {!isSubmitting && <ArrowRight size={17} aria-hidden="true" />}
      </button>
      <p className="text-center text-xs leading-5 text-white/30 sm:col-span-2">
        Private beta access is reviewed individually so each workspace starts with the right setup and permissions.
      </p>
    </form>
  );
}
