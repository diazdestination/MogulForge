import type { Metadata } from "next";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Embed shell: these pages render inside client-site iframes, so the marketing
 * header/footer from the root layout are hidden and spacing is reset.
 */
export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <style>{`body > header, body > footer { display: none !important; } body { background: transparent; }`}</style>
      {children}
    </>
  );
}
