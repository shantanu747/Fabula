import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareToBudgets,
  extractClientReferenceManifest,
  formatReport,
  measureRoute,
  readEntryChunks,
} from "./bundle-budget.mts";

// A trimmed but structurally real fixture, shaped like Next 16's Turbopack
// output (see the file comment in bundle-budget.mts) — two statements, the
// second assigning the manifest object under a bracketed key.
function manifestFixture(entryJSFiles: Record<string, string[]>): string {
  return [
    'globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};',
    `globalThis.__RSC_MANIFEST["/story/page"] = {"clientModules":{"a":{"id":1}},"entryJSFiles":${JSON.stringify(
      entryJSFiles
    )}};`,
    "",
  ].join("\n");
}

describe("extractClientReferenceManifest", () => {
  it("parses the object assigned to __RSC_MANIFEST[...]", () => {
    const source = manifestFixture({ "[project]/src/app/story/page": ["static/chunks/a.js"] });
    const manifest = extractClientReferenceManifest(source, "/story") as {
      entryJSFiles: Record<string, string[]>;
    };
    expect(manifest.entryJSFiles["[project]/src/app/story/page"]).toEqual(["static/chunks/a.js"]);
  });

  it("tolerates braces inside string values", () => {
    const source = manifestFixture({ "[project]/src/app/{weird}/page": ["static/chunks/{a}.js"] });
    const manifest = extractClientReferenceManifest(source, "/weird") as {
      entryJSFiles: Record<string, string[]>;
    };
    expect(manifest.entryJSFiles["[project]/src/app/{weird}/page"]).toEqual(["static/chunks/{a}.js"]);
  });

  it("fails with a clear message, not a raw parse error, when the marker is missing", () => {
    expect(() => extractClientReferenceManifest("export default {};", "/story")).toThrow(
      /build manifest shape changed/
    );
  });

  it("fails with a clear message when the braces never close", () => {
    const broken = 'globalThis.__RSC_MANIFEST["/story/page"] = {"entryJSFiles": {';
    expect(() => extractClientReferenceManifest(broken, "/story")).toThrow(/build manifest shape changed/);
  });
});

describe("readEntryChunks / measureRoute", () => {
  let nextDir: string;

  afterEach(() => {
    if (nextDir) rmSync(nextDir, { recursive: true, force: true });
  });

  function writeFixtureBuild(route: string, segment: string, entryKey: string, chunkContents: string[]) {
    nextDir = mkdtempSync(join(tmpdir(), "bundle-budget-test-"));
    const appDir = join(nextDir, "server", "app", segment === "page" ? "" : segment.replace(/\/page$/, ""));
    mkdirSync(appDir, { recursive: true });
    mkdirSync(join(nextDir, "static", "chunks"), { recursive: true });

    const chunkPaths = chunkContents.map((_, i) => `static/chunks/${route.replace(/\W/g, "_")}-${i}.js`);
    chunkContents.forEach((content, i) => {
      writeFileSync(join(nextDir, chunkPaths[i]), content);
    });

    writeFileSync(
      join(appDir, `${segment.split("/").pop()}_client-reference-manifest.js`),
      manifestFixture({ [entryKey]: chunkPaths })
    );

    return { nextDir, chunkPaths };
  }

  it("resolves the root route's manifest and sums its chunks' gzipped size", () => {
    const { chunkPaths } = writeFixtureBuild("/", "page", "[project]/src/app/page", [
      "console.log('hello world');",
      "console.log('a second chunk');",
    ]);

    const chunks = readEntryChunks(nextDir, "/");
    expect(chunks).toEqual(chunkPaths);

    const result = measureRoute(nextDir, "/");
    const expectedBytes =
      gzipSync(Buffer.from("console.log('hello world');")).length +
      gzipSync(Buffer.from("console.log('a second chunk');")).length;
    expect(result.gzippedBytes).toBe(expectedBytes);
  });

  it("resolves a nested route's manifest", () => {
    writeFixtureBuild("/story", "story/page", "[project]/src/app/story/page", ["console.log('story');"]);

    const result = measureRoute(nextDir, "/story");
    expect(result.gzippedBytes).toBe(gzipSync(Buffer.from("console.log('story');")).length);
  });

  it("fails with a clear message when the manifest file doesn't exist", () => {
    nextDir = mkdtempSync(join(tmpdir(), "bundle-budget-test-"));
    expect(() => readEntryChunks(nextDir, "/story")).toThrow(/run `next build` first/);
  });

  it("fails with a clear message when entryJSFiles is missing the route's key", () => {
    nextDir = mkdtempSync(join(tmpdir(), "bundle-budget-test-"));
    const appDir = join(nextDir, "server", "app", "story");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(
      join(appDir, "page_client-reference-manifest.js"),
      manifestFixture({ "[project]/src/app/some-other-route/page": ["static/chunks/a.js"] })
    );

    expect(() => readEntryChunks(nextDir, "/story")).toThrow(/build manifest shape changed/);
  });
});

describe("compareToBudgets", () => {
  it("flags routes over budget and leaves the rest alone", () => {
    const rows = compareToBudgets({ "/": 12_000, "/story": 20_000 }, { "/": 10_000, "/story": 20_000 });
    expect(rows.find((r) => r.route === "/")).toMatchObject({ over: true, deltaBytes: 2_000 });
    expect(rows.find((r) => r.route === "/story")).toMatchObject({ over: false, deltaBytes: 0 });
  });

  it("throws if a budgeted route was never measured", () => {
    expect(() => compareToBudgets({}, { "/story": 10_000 })).toThrow(/no measurement/);
  });
});

describe("formatReport", () => {
  it("renders every route and marks over-budget ones", () => {
    const rows = compareToBudgets({ "/": 12_000, "/story": 5_000 }, { "/": 10_000, "/story": 20_000 });
    const report = formatReport(rows);
    expect(report).toContain("/");
    expect(report).toContain("OVER BUDGET");
    expect(report).toContain("ok");
  });
});
