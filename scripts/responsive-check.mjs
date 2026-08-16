/**
 * Screenshots every page at mobile, tablet, and desktop widths and reports any
 * that scroll horizontally. AGENTS.md requires checking layouts at ~375px, and
 * eyeballing desktop and assuming it reflows is exactly what it warns against.
 *
 * Usage: node scripts/responsive-check.mjs [baseUrl] [outDir]
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const baseUrl = process.argv[2] ?? "http://localhost:3111";
const outDir = process.argv[3] ?? "./responsive-shots";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

const PAGES = ["/", "/story", "/login", "/signup", "/not-a-real-page"];

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
let failures = 0;

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await context.newPage();

  for (const path of PAGES) {
    const response = await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(300);

    // The check that matters: content wider than the viewport means something
    // has a fixed width or refuses to wrap.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    // Tap targets below ~44px are hard to hit accurately on a phone.
    //
    // Measured by hit-testing rather than by reading the box: the .tap-target
    // utility expands a control's touch area with an ::after overlay, which is
    // deliberately invisible to getBoundingClientRect but is what a finger
    // actually lands on. Probing 20px above and below the centre asks the
    // question the user cares about — does a tap near the control reach it —
    // and it catches an overlay that a stacking context has covered up.
    const smallTargets = await page.evaluate(() => {
      const probe = 20;
      return [...document.querySelectorAll("button, a, select, input[type=range]")]
        .map((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.height === 0) return null;
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const hits = [y - probe, y, y + probe].filter((probeY) => {
            if (probeY < 0 || probeY > window.innerHeight) return true; // off-screen, not a miss
            const hit = document.elementFromPoint(x, probeY);
            return hit ? el.contains(hit) || hit.contains(el) : false;
          });
          const label = (el.textContent || el.id || el.tagName).trim().slice(0, 30);
          return hits.length === 3 ? null : { label, h: rect.height };
        })
        .filter(Boolean);
    });

    const slug = path === "/" ? "home" : path.replace(/\//g, "-").replace(/^-/, "");
    await page.screenshot({ path: `${outDir}/${slug}-${viewport.name}.png`, fullPage: true });

    const status = response?.status();
    const problems = [];
    if (overflow > 0) problems.push(`horizontal overflow ${overflow}px`);
    if (viewport.name === "mobile" && smallTargets.length) {
      problems.push(`small tap targets: ${smallTargets.map((t) => `${t.label} (${Math.round(t.h)}px)`).join(", ")}`);
    }
    if (problems.length) failures++;

    console.log(
      `${problems.length ? "FAIL" : "ok  "} ${viewport.name.padEnd(7)} ${path.padEnd(16)} ${status} ${problems.join("; ")}`
    );
  }

  await context.close();
}

await browser.close();
console.log(failures ? `\n${failures} layout problem(s) found.` : "\nNo layout problems found.");
process.exit(failures ? 1 : 0);
