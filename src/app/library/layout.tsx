import type { ReactNode } from "react";
import { AppHeader } from "@/components/AppHeader";

/**
 * Renders the header outside `library/error.tsx`'s boundary (`error.tsx`
 * wraps `page.tsx` and nested segments, never the `layout.tsx` at its own
 * level — see Next's error.js docs) so a failure loading the library
 * replaces only the content below the header, not the whole page. Safe to
 * hoist here — unlike feed/[id], nothing under library/ has a print
 * stylesheet depending on `<header>` being a direct child of a specific
 * wrapper div.
 */
export default function LibraryLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      {children}
    </div>
  );
}
