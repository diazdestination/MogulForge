import { Suspense } from "react";
import { RescueNav } from "@/components/rescue-nav";
import { RescueBrandingBar } from "@/components/rescue-branding-bar";

/** Authenticated Revenue Rescue dashboard shell: client branding strip + sub-navigation + page content. */
export default function RevenueRescueLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Suspense fallback={null}>
        <RescueBrandingBar />
      </Suspense>
      <Suspense fallback={<div className="shell pt-8" />}>
        <RescueNav />
      </Suspense>
      {children}
    </div>
  );
}
