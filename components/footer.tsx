import Link from "next/link";

export function Footer() {
  return <footer className="border-t border-white/10 bg-black/20"><div className="shell grid gap-10 py-12 md:grid-cols-[1fr_auto_auto]">
    <div><div className="font-extrabold">MOGULFORGE</div><p className="mt-3 max-w-sm text-sm leading-6 text-white/50">We find the revenue hiding in plain sight—and forge the systems that bring it back.</p></div>
    <div className="space-y-3 text-sm"><p className="eyebrow">Explore</p><Link className="block text-white/60 hover:text-white" href="/services">Services</Link><Link className="block text-white/60 hover:text-white" href="/revenue-rescue">Revenue Rescue</Link><Link className="block text-white/60 hover:text-white" href="/ai-visibility">AI Visibility Scan</Link></div>
    <div className="space-y-3 text-sm"><p className="eyebrow">Start</p><Link className="block text-white/60 hover:text-white" href="/contact">Book a strategy call</Link><a className="block text-white/60 hover:text-white" href="mailto:hello@mogulforge.com">hello@mogulforge.com</a></div>
  </div><div className="shell border-t border-white/10 py-6 text-xs text-white/35">© {new Date().getFullYear()} MogulForge. AI Revenue Rescue™ and MogulScore™ are trademarks of MogulForge.</div></footer>;
}

