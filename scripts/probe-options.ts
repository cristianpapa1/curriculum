#!/usr/bin/env bun
/**
 * Record the real option lists of a Greenhouse form's react-select comboboxes.
 *
 * Their options load only when the list is opened, so form-questions.json holds
 * them empty and shared answers were being written blind ("no option matched").
 * This opens each combobox, reads its options, and prints label → id → options.
 * Read-only: nothing is selected and nothing is submitted.
 *
 * Every frame is probed, not just the top document: several companies serve the
 * Greenhouse form inside an iframe on their own careers page (collibra.com,
 * brex.com, catonetworks.com). Probing only the top frame found no comboboxes
 * there and reported a form with no questions, while the filler — which does
 * walk frames — was filling it.
 *
 *   bun run scripts/probe-options.ts [--full] <url> [...]
 */

import { firefox } from "playwright";
import type { Frame, Page } from "playwright";

const FULL = process.argv.includes("--full");
const urls = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const ctx = await firefox.launchPersistentContext(".browser-profile-dryrun-probe", { headless: true, viewport: { width: 1440, height: 1000 } });

/** Probe one frame's comboboxes. Returns how many were reported. */
async function probeFrame(page: Page, frame: Frame | Page, where: string): Promise<number> {
  const inputs = frame.locator("input[role=combobox]");
  const n = await inputs.count().catch(() => 0);
  let reported = 0;
  for (let i = 0; i < n; i++) {
    const input = inputs.nth(i);
    if (!(await input.isVisible().catch(() => false))) continue;
    const id = (await input.getAttribute("id").catch(() => "")) ?? "";
    if (id === "candidate-location") continue;
    const label = ((await input.evaluate((el: any) => {
      const byFor = el.id ? document.querySelector(`label[for="${el.id}"]`) : null;
      if (byFor) return byFor.textContent;
      let node = el;
      for (let k = 0; k < 6 && node?.parentElement; k++) {
        node = node.parentElement;
        const l = node.querySelector("label");
        if (l) return l.textContent;
      }
      return "";
    }).catch(() => "")) as string ?? "").trim().replace(/\s+/g, " ");
    await input.scrollIntoViewIfNeeded().catch(() => {});
    await input.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(900);
    // react-select names each option after its input; the phone-country list is
    // always in the DOM and must not be read as this field's options.
    const own = id
      ? frame.locator(`[id^="react-select-${id}-option"]`)
      : frame.locator("[role=listbox]:visible [role=option]");
    const options = (await own.allInnerTexts().catch(() => [])).map((t) => t.trim()).filter(Boolean);
    await page.keyboard.press("Escape").catch(() => {});
    console.log(`- ${label.slice(0, 90)}  [#${id}]${where ? `  (${where})` : ""}`);
    if (options.length) {
      console.log(`    ${options.slice(0, FULL ? 500 : 15).map((o) => JSON.stringify(o.slice(0, 90))).join(" | ")}${!FULL && options.length > 15 ? ` … (${options.length})` : ""}`);
    }
    reported++;
  }
  return reported;
}

for (const url of urls) {
  const page = await ctx.newPage();
  console.log(`\n=== ${url}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(5000);
    let reported = await probeFrame(page, page, "");
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const src = frame.url();
      // Ignore the analytics and consent iframes every careers page carries.
      if (!/greenhouse|ashby|lever|smartrecruiters|workable|job|career|apply/i.test(src)) continue;
      reported += await probeFrame(page, frame, new URL(src).host);
    }
    if (reported === 0) console.log("  (no comboboxes found — the form may need a click to open, or the page is a listing)");
  } catch (err) {
    console.log(`  ERROR ${(err as Error).message.slice(0, 120)}`);
  }
  await page.close();
}
await ctx.close();
