import { Suspense } from "react";
import { RescueNav } from "@/components/rescue-nav";

/** Authenticated Revenue Rescue dashboard shell: sub-navigation + page content. */
export default function RevenueRescueLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Suspense fallback={<div className="shell pt-8" />}>
        <RescueNav />
      </Suspense>
      {children}
    </div>
  );
}
