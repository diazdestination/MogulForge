"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

const LINKS = [
  { href: "/dashboard/revenue-rescue", label: "Overview", exact: true },
  { href: "/dashboard/revenue-rescue/leads", label: "Leads" },
  { href: "/dashboard/revenue-rescue/campaigns", label: "Campaigns" },
  { href: "/dashboard/revenue-rescue/conversations", label: "Conversations" },
  { href: "/dashboard/revenue-rescue/appointments", label: "Appointments" },
  { href: "/dashboard/revenue-rescue/imports", label: "Imports" },
  { href: "/dashboard/revenue-rescue/integrations", label: "Integrations" },
  { href: "/dashboard/revenue-rescue/plan", label: "Plan & Usage" },
  { href: "/dashboard/revenue-rescue/branding", label: "Branding" },
];

/** Dashboard sub-navigation. Preserves the active ?org= selection across pages. */
export function RescueNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const org = searchParams.get("org");
  const suffix = org ? `?org=${encodeURIComponent(org)}` : "";
  return (
    <nav className="shell pt-8">
      <div className="flex flex-wrap gap-1 rounded-2xl border border-white/10 bg-white/[0.03] p-1.5">
        {LINKS.map((link) => {
          const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={`${link.href}${suffix}`}
              className={`rounded-xl px-4 py-2 text-xs font-bold uppercase tracking-wide transition ${
                active ? "bg-forge-lime text-black" : "text-white/55 hover:bg-white/10 hover:text-white"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
