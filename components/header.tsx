"use client";

import Link from "next/link";
import { Menu, X } from "lucide-react";
import { useState } from "react";

const links = [{ href: "/revenue-rescue", label: "Revenue Rescue" }, { href: "/revenue-rescue/demo", label: "Live Demo" }, { href: "/revenue-rescue/calculator", label: "Calculator" }, { href: "/ai-visibility", label: "AI Visibility" }, { href: "/services", label: "Services" }, { href: "/about", label: "Why MogulForge" }];

export function Header() {
  const [open, setOpen] = useState(false);
  return <header className="sticky top-0 z-50 border-b border-white/10 bg-forge-ink/85 backdrop-blur-xl"><div className="shell flex h-[76px] items-center justify-between">
    <Link href="/" className="flex items-center gap-3 font-extrabold tracking-tight"><span className="grid h-9 w-9 place-items-center rounded-full border border-forge-lime text-xs text-forge-lime">MF</span><span>MOGULFORGE</span></Link>
    <nav className="hidden items-center gap-8 lg:flex" aria-label="Primary">{links.map(link => <Link key={link.href} className="text-xs font-bold text-white/70 transition hover:text-white" href={link.href}>{link.label}</Link>)}<Link className="btn-primary !px-5 !py-2.5" href="/revenue-rescue/scan">Run the scan <span aria-hidden>↗</span></Link></nav>
    <button className="p-2 lg:hidden" aria-label="Toggle menu" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button>
  </div>{open && <nav className="shell flex flex-col gap-5 border-t border-white/10 py-6 lg:hidden" aria-label="Mobile">{links.map(link => <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className="text-lg font-bold">{link.label}</Link>)}<Link href="/revenue-rescue/scan" onClick={() => setOpen(false)} className="btn-primary">Run the Revenue Rescue Scan</Link></nav>}</header>;
}

