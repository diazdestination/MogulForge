import type { Metadata } from "next";
import { RescueCalculator } from "@/components/rescue-calculator";

export const metadata: Metadata = {
  title: "Revenue Rescue Calculator — What's In Your Dead File?",
  description: "Estimate the conversations, appointments, projects, and revenue hiding in your dormant leads. All results are estimates, not guarantees.",
};

export default function CalculatorPage() {
  return <section className="shell py-16 sm:py-24">
    <div className="mx-auto max-w-4xl text-center">
      <p className="eyebrow">Revenue Rescue™ Calculator</p>
      <h1 className="mt-6 font-display text-6xl font-semibold leading-[.86] sm:text-8xl">How much is sitting in your dead file?</h1>
      <p className="mx-auto mt-7 max-w-2xl leading-7 text-white/60">Set your dormant lead count, average project value, and conservative rates. The formula is simple: reactivated × booked × closed × project value.</p>
    </div>
    <div className="mx-auto mt-14 max-w-6xl"><RescueCalculator /></div>
  </section>;
}
