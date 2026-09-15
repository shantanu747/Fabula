"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { AppHeader } from "@/components/AppHeader";

function VerifyResult() {
  const searchParams = useSearchParams();
  const status = searchParams.get("status");
  const { update } = useSession();

  useEffect(() => {
    // If this browser happens to hold the session that was just verified,
    // refresh it immediately — the explicit-update path in src/auth.ts's jwt
    // callback (docs/adr/0047) — so the share gate clears without waiting for
    // a fresh sign-in. A no-op if there's no session here at all (a Writer
    // who clicked the link from a different browser/device).
    //
    // `update({})`, not the argument-free `update()`: next-auth/react only
    // POSTs (the only request shape the server treats as `trigger: "update"`,
    // rather than a plain session re-fetch) when its own `data` argument is
    // not `undefined` — an empty object is enough to cross that line without
    // asking the callback to merge in anything.
    if (status === "success") void update({});
  }, [status, update]);

  if (status === "success") {
    return (
      <>
        <p className="mt-8 text-[13.5px] leading-[1.7] text-foreground">
          Your email is verified. You can now share stories to the feed.
        </p>
        <Link href="/library" className="btn btn-primary btn-block mt-6 py-[13px]">
          Go to my library
        </Link>
      </>
    );
  }

  return (
    <>
      <p className="mt-8 text-[13.5px] leading-[1.7] text-foreground">
        This verification link is invalid or has expired.
      </p>
      <Link href="/" className="btn btn-primary btn-block mt-6 py-[13px]">
        Back to Fabula
      </Link>
    </>
  );
}

export default function Verify() {
  return (
    <div className="flex flex-1 flex-col bg-background">
      <AppHeader />
      <div className="flex w-full flex-col items-center px-4 pb-12 sm:px-6">
        <div className="w-full max-w-[520px]">
          <div className="mt-10 md:mt-14">
            <h1 className="font-heading text-[38px] font-normal leading-[1.1] text-foreground">
              Email verification
            </h1>
            <Suspense>
              <VerifyResult />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
