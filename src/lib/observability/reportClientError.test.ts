import { afterEach, describe, expect, it, vi } from "vitest";
import { reportClientError } from "./reportClientError";

describe("reportClientError", () => {
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("prefers sendBeacon when available, posting digest/route only", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    Object.defineProperty(globalThis, "navigator", { value: { sendBeacon }, configurable: true });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    reportClientError("digest-abc", "/story");

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeacon.mock.calls[0];
    expect(url).toBe("/api/telemetry");
    expect(blob).toBeInstanceOf(Blob);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to a keepalive fetch when sendBeacon is unavailable", async () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    reportClientError(undefined, "/feed");
    // fetch is fire-and-forget (not awaited by the caller) — flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/telemetry");
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ kind: "error", digest: undefined, route: "/feed" });
  });

  it("swallows a rejected fetch rather than throwing", async () => {
    Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    expect(() => reportClientError("d", "/")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  it("never throws even if navigator/fetch access itself throws", () => {
    Object.defineProperty(globalThis, "navigator", {
      get() {
        throw new Error("navigator inaccessible");
      },
      configurable: true,
    });

    expect(() => reportClientError("d", "/")).not.toThrow();
  });
});
