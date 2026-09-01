import type { startMockProvider } from "../test-support/mock-provider/server";

/** Stops the mock provider server started in global-setup.ts — see the comment
 *  there on why this is a globalThis handoff rather than a shared module import. */
export default async function globalTeardown() {
  const mock = (globalThis as { __fabulaMockProvider?: Awaited<ReturnType<typeof startMockProvider>> })
    .__fabulaMockProvider;
  await mock?.stop();
}
