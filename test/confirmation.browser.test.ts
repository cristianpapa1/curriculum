/**
 * Submission confirmation — browser regression tests.
 *
 * Reproduces a live false positive: a form shows
 * "Thanks for your interest" in an application-limits notice BEFORE submit.
 * The detector matched it two seconds after the click, declared three
 * applications submitted, and closed the page while the request was still in
 * flight. These tests run against local pages in a real Firefox.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { firefox, type Browser } from "playwright";
import { awaitSubmissionOutcome, captchaChallengeGuard } from "../src/pipeline/submit.ts";

let browser: Browser;
// Launching Firefox under the full suite's load can exceed the 5s default hook timeout.
beforeAll(async () => { browser = await firefox.launch({ headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

const FORM_WITH_NOTICE = `
  <div class="notice">You can submit up to 3 applications. Thanks for your interest and we appreciate your understanding!</div>
  <form><input name="email" value="x@y.z"><button type="submit" id="go">Submit Application</button></form>`;

describe("awaitSubmissionOutcome", () => {
  test("REGRESSION: a pre-existing 'Thanks for your interest' is NOT a confirmation", async () => {
    const page = await browser.newPage();
    // Click does nothing but spin — the request never completes.
    await page.setContent(FORM_WITH_NOTICE + `<script>
      document.getElementById('go').addEventListener('click', e => { e.preventDefault(); e.target.textContent = '⟳ Submit Application'; e.target.disabled = true; });
    </script>`);
    const before = await page.innerText("body");
    await page.click("#go");
    const out = await awaitSubmissionOutcome(page, before, { polls: 12, pollMs: 1000 });
    expect(out.ok).toBe(false);
    await page.close();
  }, 45_000);

  test("a NEW confirmation that replaces the form IS a submission", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM_WITH_NOTICE + `<script>
      document.getElementById('go').addEventListener('click', e => {
        e.preventDefault();
        setTimeout(() => { document.body.innerHTML = '<div role=alert>Success. Your application was successfully submitted.</div>'; }, 1500);
      });
    </script>`);
    const before = await page.innerText("body");
    await page.click("#go");
    const out = await awaitSubmissionOutcome(page, before, { polls: 12, pollMs: 1000 });
    expect(out.ok).toBe(true);
    expect(out.evidence).toMatch(/successfully submitted/i);
    await page.close();
  }, 45_000);

  test("confirmation text while the submit button is still visible is NOT a submission", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form><button type="submit" id="go">Submit</button></form><div id="msg"></div><script>
      document.getElementById('go').addEventListener('click', e => { e.preventDefault(); document.getElementById('msg').textContent = 'Application submitted'; });
    </script>`);
    const before = await page.innerText("body");
    await page.click("#go");
    const out = await awaitSubmissionOutcome(page, before, { polls: 12, pollMs: 1000 });
    expect(out.ok).toBe(false);
    await page.close();
  }, 45_000);

  test("validation errors are reported as a refusal", async () => {
    const page = await browser.newPage();
    await page.setContent(`<form><button type="submit" id="go">Submit</button></form><script>
      document.getElementById('go').addEventListener('click', e => { e.preventDefault(); document.body.insertAdjacentHTML('afterbegin', '<div class=error>Missing entry for required field: Email</div>'); });
    </script>`);
    const before = await page.innerText("body");
    await page.click("#go");
    const out = await awaitSubmissionOutcome(page, before, { polls: 12, pollMs: 1000 });
    expect(out.ok).toBe(false);
    expect(out.evidence).toMatch(/refused/);
    await page.close();
  }, 45_000);
});

describe("awaitSubmissionOutcome — Greenhouse regressions", () => {
  const GH_FORM = `
    <p>* indicates a required field</p>
    <form><label>First Name*<input value="the candidate"></label><button type="submit" id="go">Submit application</button></form>
    <div id="after"></div>`;

  test("REGRESSION (Abinbev): a pre-existing '* indicates a required field' is NOT a refusal", async () => {
    const page = await browser.newPage();
    await page.setContent(GH_FORM + `<script>
      document.getElementById('go').addEventListener('click', e => {
        e.preventDefault(); e.target.disabled = true;
        setTimeout(() => { document.querySelector('form').remove(); document.getElementById('after').textContent = 'Thank you for applying.'; }, 1500);
      });
    </script>`);
    const before = await page.innerText("body");
    await page.click("#go");
    const out = await awaitSubmissionOutcome(page, before, { polls: 10, pollMs: 500 });
    expect(out.ok).toBe(true);
    await page.close();
  }, 30_000);

  test("a code prompt that appears late is handled inside the wait, then confirmation counts", async () => {
    const page = await browser.newPage();
    await page.setContent(GH_FORM + `<script>
      const go = document.getElementById('go');
      let stage = 0;
      go.addEventListener('click', e => {
        e.preventDefault();
        if (stage === 0) {
          stage = 1;
          setTimeout(() => {
            const d = document.createElement('div');
            d.innerHTML = '<p>A security code was sent to your email. Enter the 8-character code.</p>' + Array.from({length: 8}, () => '<input maxlength="1">').join('');
            document.querySelector('form').prepend(d);
          }, 2500);
        } else {
          const code = [...document.querySelectorAll('input[maxlength="1"]')].map(i => i.value).join('');
          if (code === 'ABCD1234') { document.querySelector('form').remove(); document.getElementById('after').textContent = 'Your application has been submitted.'; }
        }
      });
    </script>`);
    const before = await page.innerText("body");
    await page.click("#go");
    let asked = 0;
    const out = await awaitSubmissionOutcome(page, before, {
      polls: 20, pollMs: 500,
      interstitial: async (p, text, baseline) => {
        if (asked || !/security code/i.test(text) || /security code/i.test(baseline)) return null;
        asked++;
        const boxes = p.locator("input[maxlength='1']");
        for (let i = 0; i < 8; i++) await boxes.nth(i).fill("ABCD1234"[i]!);
        const next = await p.innerText("body");
        await p.click("#go");
        return { baseline: next };
      },
    });
    expect(asked).toBe(1);
    expect(out.ok).toBe(true);
    await page.close();
  }, 30_000);

  test("a NEW validation message after the click IS a refusal", async () => {
    const page = await browser.newPage();
    await page.setContent(GH_FORM + `<script>
      document.getElementById('go').addEventListener('click', e => {
        e.preventDefault();
        const p = document.createElement('p'); p.textContent = 'Location (City) is required'; document.querySelector('form').append(p);
      });
    </script>`);
    const before = await page.innerText("body");
    await page.click("#go");
    const out = await awaitSubmissionOutcome(page, before, { polls: 6, pollMs: 500 });
    expect(out.ok).toBe(false);
    expect(out.evidence).toMatch(/form refused/);
    await page.close();
  }, 30_000);
});

describe("awaitSubmissionOutcome — long postings", () => {
  test("REGRESSION: a code prompt below 8,000 characters of job description is still seen", async () => {
    const page = await browser.newPage();
    const description = "<p>" + "Northstar Labs builds infrastructure software. ".repeat(400) + "</p>";
    await page.setContent(description + `
      <form><button type="submit" id="go">Submit application</button></form><div id="after"></div>
      <script>
        document.getElementById('go').addEventListener('click', e => {
          e.preventDefault();
          const d = document.createElement('div');
          d.innerHTML = '<p>A verification code was sent to your email.</p><label>Security code</label><input maxlength="1">';
          document.querySelector('form').prepend(d);
        });
      </script>`);
    const before = await page.innerText("body");
    expect(before.length).toBeGreaterThan(8000);
    await page.click("#go");
    let seen = false;
    const out = await awaitSubmissionOutcome(page, before, {
      polls: 6, pollMs: 500,
      interstitial: async (_p, text, baseline) => {
        if (!seen && /security code/i.test(text) && !/security code/i.test(baseline)) {
          seen = true;
          return { error: "prompt reached the interstitial" };
        }
        return null;
      },
    });
    expect(seen).toBe(true);
    expect(out.evidence).toBe("prompt reached the interstitial");
    await page.close();
  }, 30_000);
});

describe("captchaChallengeGuard — Lever hCaptcha", () => {
  test("the always-present invisible widget frame is not a challenge", async () => {
    const page = await browser.newPage();
    await page.setContent(`<iframe title="Widget containing checkbox for hCaptcha security challenge" style="width:1440px;height:1000px;position:fixed;visibility:hidden"></iframe>`);
    expect(await captchaChallengeGuard(page, "", "")).toBeNull();
    await page.close();
  });

  test("a visible challenge puzzle ends the attempt and is never worked around", async () => {
    const page = await browser.newPage();
    await page.setContent(`<iframe title="Main content of the hCaptcha challenge" style="width:400px;height:600px"></iframe>`);
    const r = await captchaChallengeGuard(page, "", "");
    expect(r && "error" in r ? r.error : "").toMatch(/needs a person/);
    await page.close();
  });
});
