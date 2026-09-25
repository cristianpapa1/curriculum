/**
 * Form questions — browser regression tests from a live run.
 *
 * Reproduces what that run found: Lever custom questions with no <label>,
 * react-select comboboxes whose choice renders outside the input, required
 * radio groups the value check could not see, and answers.json matching.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { firefox, type Browser } from "playwright";
import { readQuestions, applyAnswerOverrides, uniqueMatch } from "../src/pipeline/questions.ts";
import { plainTextAnswer } from "../src/pipeline/submit.ts";

let browser: Browser;
// Launching Firefox under the full suite's load can exceed the 5s default hook timeout.
beforeAll(async () => { browser = await firefox.launch({ headless: true }); }, 60_000);
afterAll(async () => { await browser?.close(); });

const FORM = `
<form>
  <li class="application-question">
    <div class="application-label"><div class="text">Current location<span class="required">✱</span></div></div>
    <div class="application-field"><input type="text" name="cards[abc][field0]"></div>
  </li>
  <fieldset>
    <legend>Are you based in Barcelona and willing to come 2-3 days to the office? ✱</legend>
    <label><input type="radio" name="cards[abc][field1]" value="Yes">Yes</label>
    <label><input type="radio" name="cards[abc][field1]" value="No">No</label>
    <label><input type="radio" name="cards[abc][field1]" value="Not sure">Not sure</label>
  </fieldset>
  <div class="field">
    <label for="country">Country*</label>
    <div class="select__control"><div class="select__value-container">
      <div class="select__single-value">Brazil</div>
      <input id="country" class="select__input" role="combobox" value="">
    </div></div>
  </div>
  <div class="field">
    <label for="visa">Will you require VISA now or in the future?*</label>
    <div class="select__control"><div class="select__value-container">
      <input id="visa" class="select__input" role="combobox" value="">
    </div></div>
    <div id="menu" style="display:none">
      <div role="option">Yes</div><div role="option">No</div>
    </div>
  </div>
</form>
<script>
  const visa = document.getElementById('visa');
  const menu = document.getElementById('menu');
  visa.addEventListener('input', () => {
    menu.style.display = 'block';
    for (const o of menu.children) o.style.display = o.textContent.toLowerCase().includes(visa.value.toLowerCase()) ? 'block' : 'none';
  });
  for (const o of menu.children) o.addEventListener('click', () => {
    const v = document.createElement('div'); v.className = 'select__single-value'; v.textContent = o.textContent;
    visa.parentElement.prepend(v); menu.style.display = 'none'; visa.value = '';
  });
</script>`;

describe("readQuestions", () => {
  test("reads Lever questions that have no <label> and marks ✱ as required", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const qs = await readQuestions(page);
    const loc = qs.find((q) => q.question.startsWith("Current location"));
    expect(loc).toBeDefined();
    expect(loc!.required).toBe(true);
    expect(loc!.answered).toBe(false);
    await page.close();
  });

  test("REGRESSION: a react-select choice rendered outside the input counts as answered", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const country = (await readQuestions(page)).find((q) => q.question.startsWith("Country"));
    expect(country?.kind).toBe("combobox");
    expect(country?.answered).toBe(true);
    await page.close();
  });

  test("an unanswered required radio group is visible to the check", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const radio = (await readQuestions(page)).find((q) => q.kind === "radio");
    expect(radio?.required).toBe(true);
    expect(radio?.answered).toBe(false);
    expect(radio?.options).toEqual(["Yes", "No", "Not sure"]);
    await page.close();
  });
});

describe("applyAnswerOverrides", () => {
  test("'No' picks the exact option, not 'Not sure'; text and combobox are filled", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const out = await applyAnswerOverrides(page, [
      { q: "based in Barcelona", a: "No" },
      { q: "Current location", a: ["São Paulo, Brazil", "unused"] },
      { q: "require VISA", a: ["Não", "No"] },
    ]);
    expect(out.every((o) => o.action === "answered")).toBe(true);
    expect(await page.isChecked("input[value='No']")).toBe(true);
    expect(await page.isChecked("input[value='Not sure']")).toBe(false);
    expect(await page.inputValue("input[name='cards[abc][field0]']")).toBe("São Paulo, Brazil");
    const visa = (await readQuestions(page)).find((q) => q.question.startsWith("Will you require VISA"));
    expect(visa?.value).toBe("No");
    await page.close();
  }, 30_000);

  test("ANTI: a combobox with no matching option is left unanswered, never guessed", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const [r] = await applyAnswerOverrides(page, [{ q: "require VISA", a: "Maybe" }]);
    expect(r!.action).toBe("SKIPPED-UNKNOWN");
    const visa = (await readQuestions(page)).find((q) => q.question.startsWith("Will you require VISA"));
    expect(visa?.answered).toBe(false);
    await page.close();
  }, 30_000);

  test("ANTI: prose that fails the gate is blocked, not typed", async () => {
    const page = await browser.newPage();
    await page.setContent(FORM);
    const [r] = await applyAnswerOverrides(
      page,
      [{ q: "Current location", a: "I ran Kubernetes clusters at scale for ten years in production." }],
      () => "claims Kubernetes",
    );
    expect(r!.action).toBe("BLOCKED");
    expect(await page.inputValue("input[name='cards[abc][field0]']")).toBe("");
    await page.close();
  });
});

describe("plainTextAnswer", () => {
  test("accessibility questions are not a pitch", () => {
    expect(plainTextAnswer("Please let our team know if you need any adjustments to the recruitment process")).toBe("No adjustments needed.");
    expect(plainTextAnswer("Where did you gain your most notable devops experience?")).toBeUndefined();
  });
});

describe("applyAnswerOverrides — from a dry run", () => {
  const PAGE = `
  <div class="field">
    <label for="phonecc">Country</label>
    <input id="phonecc" role="combobox" class="select__input" aria-controls="cc-list">
    <div id="cc-list"><div role="option">Norway+47</div><div role="option">Brazil+55</div></div>
  </div>
  <div class="field">
    <label for="rights">Do you have full working rights to work in France or would you require visa sponsorship?*</label>
    <input id="rights" role="combobox" class="select__input" aria-controls="rights-list">
    <div id="rights-list"></div>
  </div>
  <script>
    const r = document.getElementById('rights'), list = document.getElementById('rights-list');
    const all = ['Yes, I have full working rights', 'No, I would require sponsorship'];
    r.addEventListener('input', () => {
      list.innerHTML = all.filter(o => o.toLowerCase().includes(r.value.toLowerCase())).map(o => '<div role="option">' + o + '</div>').join('');
      for (const o of list.children) o.addEventListener('click', () => { r.dataset.chosen = o.textContent; });
    });
  </script>`;

  test("REGRESSION: 'No' never matches 'Norway' in another combobox's list, and the first answer owns the question", async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const out = await applyAnswerOverrides(page, [
      { q: "full working rights", a: ["Yes, I have full working rights"] },
      { q: "require visa", a: ["No"] },
    ]);
    expect(await page.getAttribute("#rights", "data-chosen")).toBe("Yes, I have full working rights");
    expect(out[0]!.value).toContain("Yes, I have full working rights");
    expect(out.length).toBe(1); // the second override found the question already owned
    await page.close();
  }, 30_000);

  test("ANTI: a bare 'Yes' never selects a longer option that says more than was decided", async () => {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const [r] = await applyAnswerOverrides(page, [{ q: "full working rights", a: ["Yes"] }]);
    expect(r!.action).toBe("SKIPPED-UNKNOWN");
    expect(await page.getAttribute("#rights", "data-chosen")).toBeNull();
    await page.close();
  }, 30_000);
});

describe("a negated option never satisfies the word it negates", () => {
  const english = [
    "I don't speak English",
    "I understand some English words and phrases, but I can't hold a conversation",
    "I can understand work-related emails and spoken communication, but I don't speak English fluently",
    "I can participate in meetings and communicate in English, with only minor limitations",
    "I'm fluent: I can lead meetings, participate in in-depth discussions, and deliver presentations confidently in English",
  ];

  test("'Fluent' selects the fluent option, not the one denying fluency", () => {
    expect(uniqueMatch(english, "Fluent")).toBe(4);
  });

  test("a want that only ever appears negated matches nothing", () => {
    expect(uniqueMatch(["I do not have a driver's license"], "have a driver's license")).toBe(-1);
  });

  test("ANTI: a negation in an earlier clause does not veto a later match", () => {
    expect(uniqueMatch(["No, I am not a student; I am employed full time"], "employed full time")).toBe(0);
  });
});
