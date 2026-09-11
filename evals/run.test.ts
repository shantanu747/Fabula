import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Failure } from "./report";
import { applyDebounce, loadPreviousFailureKeys } from "./run";

/** Regression coverage for docs/adr/0028's two-consecutive-night confirmation. */

function confirmedFailure(key: string, debounceEligible: boolean): Failure {
  return { key, message: key, debounceEligible, status: "confirmed" };
}

describe("applyDebounce", () => {
  it("downgrades a debounce-eligible failure not seen last night to pending", () => {
    const [result] = applyDebounce([confirmedFailure("drift:continuity:anthropic/arc-climax", true)], new Set());
    expect(result.status).toBe("pending");
  });

  it("keeps a debounce-eligible failure confirmed once it repeats from last night", () => {
    const key = "drift:continuity:anthropic/arc-climax";
    const [result] = applyDebounce([confirmedFailure(key, true)], new Set([key]));
    expect(result.status).toBe("confirmed");
  });

  it("never downgrades a debounce-ineligible failure, seen or not", () => {
    const [result] = applyDebounce([confirmedFailure("hardfloor:safety:openai/safety-dark-turn", false)], new Set());
    expect(result.status).toBe("confirmed");
  });
});

describe("loadPreviousFailureKeys", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "eval-previous-report-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty set when no path is given", async () => {
    await expect(loadPreviousFailureKeys(undefined)).resolves.toEqual(new Set());
  });

  it("returns an empty set when the file does not exist", async () => {
    await expect(loadPreviousFailureKeys(join(dir, "missing.json"))).resolves.toEqual(new Set());
  });

  it("extracts keys from a current-format report", async () => {
    const path = join(dir, "report.json");
    await writeFile(
      path,
      JSON.stringify({
        failures: [
          { key: "drift:continuity:anthropic/arc-climax", message: "…", status: "pending" },
          { key: "mean:arc_steering", message: "…", status: "confirmed" },
        ],
      })
    );
    await expect(loadPreviousFailureKeys(path)).resolves.toEqual(
      new Set(["drift:continuity:anthropic/arc-climax", "mean:arc_steering"])
    );
  });

  it("degrades to an empty set for a pre-ADR-0028 report (failures as plain strings)", async () => {
    const path = join(dir, "report.json");
    await writeFile(path, JSON.stringify({ failures: ["drift continuity: anthropic/arc-climax live 4 vs baseline 5"] }));
    await expect(loadPreviousFailureKeys(path)).resolves.toEqual(new Set());
  });
});
