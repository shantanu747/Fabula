"use client";

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";
import type { ReactNode } from "react";
import { StoryProvider } from "@/lib/story/StoryContext";
import type { ProviderSummary } from "@/lib/providers/list";

export function Providers({
  session,
  providers,
  children,
}: {
  session: Session | null;
  providers: ProviderSummary[];
  children: ReactNode;
}) {
  return (
    <SessionProvider session={session}>
      <StoryProvider providers={providers}>{children}</StoryProvider>
    </SessionProvider>
  );
}
