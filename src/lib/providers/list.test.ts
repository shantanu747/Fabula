import { afterEach, describe, expect, it } from "vitest";
import { getProviderList } from "./list";
import { PROVIDERS } from "./registry";
import type { LLMProvider } from "./types";

describe("getProviderList", () => {
  afterEach(() => {
    delete PROVIDERS["temp-provider"];
  });

  it("summarises every registered provider", () => {
    const list = getProviderList();

    expect(list.length).toBe(Object.keys(PROVIDERS).length);
    expect(list).toContainEqual({ id: "anthropic", displayName: PROVIDERS.anthropic.displayName });
  });

  it("exposes only id and displayName", () => {
    // The result is serialised into a Server Component boundary, so anything
    // else on the provider object (its SDK client, its generator) must not ride
    // along.
    expect(Object.keys(getProviderList()[0]).sort()).toEqual(["displayName", "id"]);
  });

  it("reflects the registry rather than a copy taken at import time", () => {
    // Adding a provider must never require touching calling code — the whole
    // point of the registry (docs/adr/0001).
    PROVIDERS["temp-provider"] = { id: "temp-provider", displayName: "Temp" } as LLMProvider;

    expect(getProviderList()).toContainEqual({ id: "temp-provider", displayName: "Temp" });
  });
});
