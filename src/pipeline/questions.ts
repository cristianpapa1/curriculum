/**
 * Form questions, read from the page as a whole — and answered per application.
 *
 * The regex fillers in submit.ts cover questions every board asks (name, email,
 * sponsorship). They cannot cover the questions each company writes for itself:
 * office-location radios, a salary-period choice, consent to AI screening, a
 * U.S.-person export-control declaration. Those were found on a live run, where
 * forms were left incomplete and one was refused after the click.
 *
 * So the page is read into QUESTIONS — each with its text, control kind,
 * options, whether it is required and whether it is answered — and written to
 * the application folder as `form-questions.json`. Answers for that specific
 * form live beside it in `answers.json`, written from the corpus and reviewed
 * like any other document, and are applied after the generic fillers so a
 * deliberate answer always wins over a heuristic one.
 *
 *   answers.json: [{ "q": "which office", "a": "Brazil - São Paulo", "why": "lives in São Paulo" }]
 *
 * `q` is a case-insensitive fragment of the question text; `a` is the text to
 * type, or the option label to pick (a list for multi-select checkboxes).
 */

import type { Page } from "playwright";
import { join, dirname } from "node:path";

export interface FormQuestion {
  /** Stable within one page load: the controls carry data-q="<id>". */
  id: number;
  question: string;
  kind: string;
  options: string[];
  required: boolean;
  answered: boolean;
  value: string;
}

export interface AnswerOverride {
  q: string;
  a: string | string[];
  why?: string;
  /** From Corpus/form-answers.json: silent when its question is absent. */
  shared?: boolean;
  /**
   * "certs": the answer claims certifications, so it applies only when some
   * relate to this posting (Inter's "CERTIFICADO OUTROS"). `a: "__CERTS__"`
   * names them instead.
   */
  requires?: "certs";
}

/** Read every visible question on the form, grouped by the question it belongs to. */
export async function readQuestions(page: Page): Promise<FormQuestion[]> {
  return (await page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      const clean = (s: any) => String(s ?? "").replace(/\s+/g, " ").trim();
      const visible = (el: any) => {
        const st = (globalThis as any).getComputedStyle(el);
        // Radios and checkboxes are often visually hidden behind a styled label.
        if ((el.type === "radio" || el.type === "checkbox") && el.closest("label")) return st.display !== "none";
        return el.offsetParent !== null && st.visibility !== "hidden";
      };
      const ownLabel = (el: any): string => {
        if (el.type === "radio" || el.type === "checkbox" || el.getAttribute("role") === "radio") {
          const l = el.closest("label") ?? (el.id ? doc.querySelector(`label[for="${el.id}"]`) : null);
          if (l) {
            const c = l.cloneNode(true);
            c.querySelectorAll("input").forEach((i: any) => i.remove());
            return clean(c.textContent);
          }
          return clean(el.getAttribute("aria-label") || el.value || el.innerText);
        }
        return "";
      };
      const questionOf = (el: any): string => {
        const mine = ownLabel(el);
        if (!(el.type === "radio" || el.type === "checkbox") && el.labels?.[0]) return clean(el.labels[0].innerText);
        let n = el;
        for (let i = 0; i < 8 && n?.parentElement; i++) {
          n = n.parentElement;
          const cands = n.querySelectorAll("legend, label, [class*=label], [class*=question], [class*=title], h3, h4");
          for (const c of cands) {
            if (c.contains(el)) continue;
            const t = clean(c.innerText);
            if (!t || t === mine || t.length > 400) continue;
            // An option label of a sibling radio is not the question.
            if (c.tagName === "LABEL" && c.querySelector("input[type=radio], input[type=checkbox]")) continue;
            return t;
          }
        }
        return clean(el.getAttribute("aria-label") || el.placeholder || el.name);
      };

      const groups = new Map<string, any>();
      let next = 0;
      const controls = doc.querySelectorAll("input, select, textarea, [role=radio], [role=checkbox]");
      for (const el of controls) {
        const type = String(el.type || el.getAttribute("role") || el.tagName).toLowerCase();
        if (["hidden", "submit", "button", "password", "file", "search"].includes(type)) continue;
        if (!visible(el)) continue;
        // Disabled means not asked: "Current role" disables the end-date fields.
        if (el.disabled) continue;
        // react-select's aria-hidden twin exists only for native validation.
        if (el.getAttribute("aria-hidden") === "true") continue;
        const question = questionOf(el);
        if (!question) continue;
        // Options of one radio/checkbox question share a group; two FIELDS with
        // the same title are two questions. EBANX asks "Demographic Information*"
        // twice, and merged into one group only the first was ever answered.
        const choice = type === "radio" || type === "checkbox";
        let key = question.slice(0, 300);
        for (let n = 2; !choice && groups.get(key)?.field; n++) key = `${question.slice(0, 300)}\u0000${n}`;
        let g = groups.get(key);
        if (!g) {
          g = { id: next++, question: question.slice(0, 300), kind: type, options: [], required: false, answered: false, value: "" };
          groups.set(key, g);
        }
        if (!choice) g.field = true;
        el.setAttribute("data-q", String(g.id));
        if (/\*|✱/.test(question) || el.required || el.getAttribute("aria-required") === "true") g.required = true;

        if (type === "radio" || type === "checkbox") {
          const lab = ownLabel(el);
          if (lab && !g.options.includes(lab)) g.options.push(lab);
          if (el.checked || el.getAttribute("aria-checked") === "true") {
            g.answered = true;
            g.value = g.value ? `${g.value}, ${lab}` : lab;
          }
        } else if (el.tagName === "SELECT") {
          g.kind = "select";
          g.options = [...el.options].map((o: any) => clean(o.text)).filter(Boolean);
          const chosen = el.selectedIndex >= 0 ? clean(el.options[el.selectedIndex]?.text) : "";
          if (el.value && !/^(select|choose|--|please)/i.test(chosen)) { g.answered = true; g.value = chosen; }
        } else {
          const v = clean(el.value);
          // react-select style comboboxes keep the choice outside the input, in
          // a sibling of an ancestor. `closest()` would match the input itself
          // (class "select__input"), so walk the ancestors explicitly.
          const combo = el.getAttribute("role") === "combobox" || /select__input|react-select/.test(String(el.className ?? ""));
          let shown = "";
          let a = el.parentElement;
          // Only comboboxes render their value outside the input, and the walk
          // stops before an ancestor that holds another field — otherwise the
          // neighbouring Country choice "answers" an empty question below it.
          for (let i = 0; combo && i < 5 && a && !shown; i++, a = a.parentElement) {
            if (a.querySelectorAll("input:not([type=hidden]), select, textarea").length > 1) break;
            shown = clean(a.querySelector?.("[class*=single-value], [class*=singleValue], [class*=multi-value], [class*=multiValue]")?.innerText);
          }
          if (v || shown) {
            g.answered = true;
            // Identity numbers are recorded as present, never copied to disk.
            g.value = /\bcpf\b|passport number|national id|social security|address line|street|endere[çc]o|logradouro|postal|zip code|\bcep\b|bairro/i.test(question) ? "[redacted]" : (v || shown).slice(0, 160);
          }
          if (combo) g.kind = "combobox";
        }
      }
      // Yes/No rendered as a pair of buttons (Ashby). Found live: two required
      // questions of this shape were invisible to every input-based check, the
      // form was declared complete, and the board refused it.
      const pairs = doc.querySelectorAll(".ashby-application-form-input-yesno, [class*=yesno]");
      for (const box of pairs) {
        const buttons = [...box.querySelectorAll("button")].filter((b: any) => /^(yes|no|sim|não|sí)$/i.test(clean(b.innerText)));
        if (buttons.length < 2 || !visible(buttons[0])) continue;
        const question = questionOf(box);
        if (!question) continue;
        const key = question.slice(0, 300);
        if (groups.has(key)) continue;
        const g = { id: next++, question: key, kind: "yesno", options: buttons.map((b: any) => clean(b.innerText)), required: /\*|✱/.test(question), answered: false, value: "" };
        for (const b of buttons) {
          b.setAttribute("data-q", String(g.id));
          if (b.getAttribute("aria-pressed") === "true" || /_active|selected/.test(String(b.className))) {
            g.answered = true;
            g.value = clean(b.innerText);
          }
        }
        groups.set(key, g);
      }
      return [...groups.values()].map(({ field, ...g }: any) => g);
    })
    .catch(() => [])) as FormQuestion[];
}

/**
 * Per-application answers first, then the shared standard answers in
 * Corpus/form-answers.json (employer, nationality, English level, declined
 * demographics, consents …). The first answer applied owns a question, so a
 * form's own answers.json always wins. Shared entries are marked `shared` and
 * stay silent when their question is not on the page.
 */
export async function loadAnswerOverrides(
  cvPath: string,
  /** `certs`: the related-certifications text for this posting, "" when none relate. */
  /** `appliedBefore`: resolves `__APPLIED_BEFORE__` — Yes only after the pipeline sent one there. */
  /** `ownLevel`: resolves `__SENIORITY__` — the candidate's level in this posting's field. */
  opts: {
    cpf?: string; certs?: string; appliedBefore?: boolean; ownLevel?: "senior" | "pleno" | "junior";
    /** Profile facts for __LEGAL_NAME__, __PREFERRED_NAME__, __EMPLOYER__, __JOB_TITLE__. */
    profile?: { name: string; employer?: string; title?: string };
  } = {},
): Promise<AnswerOverride[]> {
  const read = async (path: string) => {
    const f = Bun.file(path);
    if (!(await f.exists())) return [] as AnswerOverride[];
    try {
      return (await f.json()) as AnswerOverride[];
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
  };
  // Placeholders, resolved per application. One that resolves to nothing drops
  // its answer: with no related certification, `__CERTS__` claims none.
  // Profile placeholders make the shared answers file reusable by any candidate.
  const facts: Record<string, string | undefined> = {
    __LEGAL_NAME__: opts.profile?.name,
    __PREFERRED_NAME__: opts.profile?.name.split(/\s+/)[0],
    __EMPLOYER__: opts.profile?.employer,
    __JOB_TITLE__: opts.profile?.title,
  };
  const fill = (v: string): string | null => (v in facts ? facts[v] ?? null : v);
  const withFacts = (a: AnswerOverride): AnswerOverride[] => {
    if (Array.isArray(a.a)) {
      const filled = a.a.map(fill).filter((v): v is string => v !== null);
      return filled.length ? [{ ...a, a: filled }] : [];
    }
    const v = fill(a.a);
    return v === null ? [] : [{ ...a, a: v }];
  };
  const resolve = (list: AnswerOverride[]) =>
    list.flatMap(withFacts).flatMap((a) => {
      if (a.requires === "certs" && !opts.certs) return [];
      if (a.a === "__CPF__") return opts.cpf ? [{ ...a, a: formatCpf(opts.cpf) }] : [];
      if (a.a === "__CERTS__") return opts.certs ? [{ ...a, a: opts.certs }] : [];
      if (a.a === "__SENIORITY__") return opts.ownLevel ? [{ ...a, a: SENIORITY_OPTIONS[opts.ownLevel] }] : [];
      if (a.a === "__APPLIED_BEFORE__") return [{ ...a, a: opts.appliedBefore ? ["Yes", "Sim", "Yes (Sim)"] : ["No", "Não", "No (Não)"] }];
      return [a];
    });
  const own = resolve(await read(join(dirname(cvPath), "answers.json")));
  const { CORPUS_DIR } = await import("../corpus/load.ts");
  // The CPF is filled from .env, never stored in the corpus.
  // The most specific fragment answers first. "Privacy Notice" otherwise took a
  // "Please confirm receipt of the above linked … Privacy Notice" question
  // (whose only option is "Confirmed"), and "necessidade de acessibilidad" took
  // an optional accommodations list ahead of the required question beside it.
  const shared = resolve((await read(join(CORPUS_DIR, "form-answers.json"))).map((a) => ({ ...a, shared: true })))
    .sort((x, y) => y.q.length - x.q.length);
  return [...own, ...shared];
}

/** 12345678901 → 123.456.789-01, the format Brazilian forms ask for. */
/** Option wordings for each level, Portuguese first (Brazilian forms ask this). */
const SENIORITY_OPTIONS: Record<"senior" | "pleno" | "junior", string[]> = {
  senior: ["Sênior", "Senior", "Sênior (Senior)", "Sr"],
  pleno: ["Pleno", "Pleno (Mid-level)", "Mid-level", "Mid Level", "Mid", "Intermediate", "Intermediário"],
  junior: ["Júnior", "Junior", "Júnior (Junior)", "Jr", "Entry level", "Entry-level"],
};

export function formatCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, "");
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.trim().toLowerCase());

/**
 * Does an OPTION label satisfy a wanted answer? Short answers ("Yes", "No",
 * "Sim") must lead the label as a whole word — found in a dry run:
 * containment let "No" match "Norway" in the phone-country list.
 */
const optionMatches = (label: string, want: string) => {
  const l = label.trim().toLowerCase();
  const w = want.trim().toLowerCase();
  if (!w) return false;
  if (l === w) return true;
  if (w.length <= 4) return new RegExp(`^${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|[^\\p{L}])`, "u").test(l);
  const at = l.indexOf(w);
  return at >= 0 && !NEGATED.test(l.slice(0, at));
};

/**
 * A negation earlier in the SAME clause flips what the matched word claims.
 * One English-level question offered both "I'm fluent: I can lead meetings…"
 * and "…but I don't speak English fluently"; containment on "fluent" picked the
 * second and sent an answer understating the candidate by two levels.
 */
const NEGATED = /\b(not|no|don'?t|doesn'?t|didn'?t|cannot|can'?t|won'?t|never|without|n[ãa]o|nem|sem|ni|sin)\b[^,;:.!?]*$/i;

/**
 * Index of the one option a wanted answer selects, or -1.
 *
 * A short answer that leads SEVERAL options is ambiguous and selects nothing.
 * Found in a dry run: "Yes" matched "Yes, I'm based in or near Paris
 * and can work hybrid" — a false statement — ahead of "I'm not currently in
 * Paris but would relocate". Such questions need the full option text.
 */
export function uniqueMatch(options: string[], want: string): number {
  const exact = options.findIndex((o) => same(o, want));
  if (exact >= 0) return exact;
  const hits = options.map((o, i) => (optionMatches(o, want) ? i : -1)).filter((i) => i >= 0);
  if (hits.length === 0) return -1;
  if (hits.length > 1 && want.trim().length <= 4) return -1;
  // A short answer that is only one clause of a longer option ("Yes, I'm based
  // in…") also says more than was decided; require the full text for those.
  if (want.trim().length <= 4 && options[hits[0]!]!.trim().length > want.trim().length + 12) return -1;
  return hits[0]!;
}

/** Apply per-application answers. Returns one report line per override. */
export async function applyAnswerOverrides(
  page: Page,
  overrides: AnswerOverride[],
  /** Returns a reason when a written answer fails the anti-fabrication gate. */
  gate: (text: string) => string | null = () => null,
): Promise<{ label: string; kind: string; action: "answered" | "SKIPPED-UNKNOWN" | "BLOCKED"; value: string }[]> {
  if (overrides.length === 0) return [];
  const out: { label: string; kind: string; action: "answered" | "SKIPPED-UNKNOWN" | "BLOCKED"; value: string }[] = [];
  const questions = await readQuestions(page);

  // One answer per question: the first override that answers a question owns
  // it. Found in a dry run: a shared "require visa" answer and the
  // company-specific "full working rights" answer both targeted one question.
  const owned = new Set<number>();

  for (const o of overrides) {
    // Prose written into answers.json is held to the same gate as generated text.
    const first = Array.isArray(o.a) ? o.a[0]! : o.a;
    if (first.length >= 40) {
      const reason = gate(first);
      if (reason) {
        out.push({ label: o.q.slice(0, 58), kind: "override", action: "BLOCKED", value: `anti-fabrication: ${reason.slice(0, 90)}` });
        continue;
      }
    }
    // The question text first; failing that, a question whose OPTION carries
    // the fragment — a consent checkbox can sit under a "question" that is
    // really the whole contact block, while its own label is unambiguous.
    const match = questions.find((x) => has(x.question, o.q)) ??
      questions.find((x) => (x.kind === "checkbox" || x.kind === "radio") && x.options.some((op) => has(op, o.q)));
    const label = (match?.question ?? o.q).slice(0, 58);
    const wanted = Array.isArray(o.a) ? o.a : [o.a];
    if (!match) {
      if (!o.shared) out.push({ label, kind: "override", action: "SKIPPED-UNKNOWN", value: `question not found on page: "${o.q}"` });
      continue;
    }
    // Fields that share a title are separate questions, and each takes the
    // answer (EBANX's two "Demographic Information*" consents).
    const targets = questions.filter((x) => x.id === match.id || (x.question === match.question && x.kind === match.kind));
    for (const q of targets) {
      if (owned.has(q.id)) continue;
      const controls = page.locator(`[data-q="${q.id}"]`);
      let picked = "";

      // Geocoding autocompletes are handled by their own adapter; typing into
      // them here would clear the suggestion it picked.
      if (await controls.first().evaluate((el: any) => /location-input/.test(String(el.className))).catch(() => false)) {
        continue;
      }

      if (q.kind === "yesno") {
        const n = await controls.count();
        for (const want of wanted) {
          let hit = -1;
          for (let i = 0; i < n && hit < 0; i++) {
            if (optionMatches((await controls.nth(i).innerText().catch(() => "")) as string, want)) hit = i;
          }
          if (hit < 0) continue;
          await controls.nth(hit).click({ timeout: 5000 }).catch(() => {});
          picked = ((await controls.nth(hit).innerText().catch(() => want)) as string).trim();
          break;
        }
      } else if (q.kind === "radio" || q.kind === "checkbox") {
        const n = await controls.count();
        const labels: string[] = [];
        for (let i = 0; i < n; i++) labels.push(await ownLabelOf(controls.nth(i)));
        const chosen: string[] = [];
        for (const want of wanted) {
          // Exact label first, then a whole-word / containment match.
          let target = labels.findIndex((l) => same(l, want));
          if (target < 0) target = uniqueMatch(labels, want);
          if (target < 0) continue;
          const c = controls.nth(target);
          const clicked = await c.check({ timeout: 5000, force: true }).then(() => true).catch(async () =>
            c.evaluate((el: any) => (el.closest("label") ?? el).click()).then(() => true).catch(() => false));
          if (clicked) chosen.push(labels[target]!);
          // A radio takes one answer; only checkbox groups take several.
          if (clicked && q.kind === "radio") break;
        }
        picked = chosen.join(", ");
      } else if (q.kind === "select") {
        const hit = (await controls.first().evaluate(
          (el: any, w: string[]) => {
            const opts = [...el.options].map((op: any) => ({ value: op.value, text: String(op.text).trim() }));
            for (const want of w) {
              const exact = opts.find((op) => op.text.toLowerCase() === want.trim().toLowerCase());
              if (exact) return exact;
            }
            return null;
          },
          wanted,
        )) as { value: string; text: string } | null;
        const loose = hit ?? (() => {
          for (const want of wanted) {
            const i = uniqueMatch(q.options, want);
            const t = i >= 0 ? q.options[i] : undefined;
            if (t) return { value: "", text: t };
          }
          return null;
        })();
        if (loose) {
          await controls.first().selectOption(loose.value ? loose.value : { label: loose.text }).catch(() => {});
          picked = loose.text;
        }
      } else if (q.kind === "combobox") {
        // Each candidate is typed to filter the list, and only an option of THIS
        // combobox whose text matches is clicked. The listbox is the one the input
        // controls; options elsewhere on the page (a phone-country list) are out
        // of scope. No match leaves the question unanswered — never Enter.
        const input = controls.first();
        const seen = new Set<string>();
        for (const want of wanted) {
          await input.click({ timeout: 5000 }).catch(() => {});
          await input.fill(want).catch(() => {});
          await page.waitForTimeout(1200);
          const listId = (await input.evaluate((el: any) => el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").catch(() => "")) as string;
          const options = listId
            ? page.locator(`[id="${listId}"] [role=option]`)
            : page.locator("[role=option]:visible");
          const n = await options.count();
          const texts: string[] = [];
          for (let i = 0; i < n; i++) {
            const t = ((await options.nth(i).innerText().catch(() => "")) as string).replace(/\s+/g, " ").trim();
            texts.push(t);
            seen.add(t);
          }
          let pick = texts.findIndex((t) => same(t, want));
          if (pick < 0) pick = uniqueMatch(texts, want);
          if (pick >= 0) {
            await options.nth(pick).click({ timeout: 5000 }).catch(() => {});
            picked = picked ? `${picked}, ${texts[pick]}` : texts[pick]!;
            if (!/multi|all that apply|select all|choose all/i.test(q.question)) break;
          } else {
            await input.fill("").catch(() => {});
            await input.press("Escape").catch(() => {});
          }
        }
        // Fallback: typing a long option label did not surface it on one board's
        // form, although the option exists. Open the menu empty and match against
        // the full list; close it afterwards so the next question is not blocked.
        if (!picked) {
          await input.fill("").catch(() => {});
          await input.click({ timeout: 5000 }).catch(() => {});
          await input.press("ArrowDown").catch(() => {});
          await page.waitForTimeout(1000);
          const listId = (await input.evaluate((el: any) => el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "").catch(() => "")) as string;
          const options = listId ? page.locator(`[id="${listId}"] [role=option]`) : page.locator("[role=option]:visible");
          const texts = ((await options.allInnerTexts().catch(() => [])) as string[]).map((t) => t.replace(/\s+/g, " ").trim());
          for (const t of texts) seen.add(t);
          for (const want of wanted) {
            let pick = texts.findIndex((t) => same(t, want));
            if (pick < 0) pick = uniqueMatch(texts, want);
            if (pick >= 0) {
              await options.nth(pick).click({ timeout: 5000 }).catch(() => {});
              picked = texts[pick]!;
              break;
            }
          }
        }
        await input.press("Escape").catch(() => {});
        if (!picked) q.options = [...seen].slice(0, 12);
      } else {
        // Candidate lists exist for option matching; a text field takes the first.
        await controls.first().fill(wanted[0]!).catch(() => {});
        picked = wanted[0]!;
      }

      if (picked) owned.add(q.id);
      out.push({
        label, kind: `override/${q.kind}`,
        action: picked ? "answered" : "SKIPPED-UNKNOWN",
        value: picked
          // Identity numbers never reach a report or log.
          ? `${/\bcpf\b|passport number|national id/i.test(q.question) ? "•••••••••••" : picked.slice(0, 48)}${o.why ? ` — ${o.why}` : ""}`
          : `no option matched "${wanted.join(" / ")}" in [${q.options.slice(0, 6).join(" | ")}]`,
      });
    }
  }
  return out;
}

async function ownLabelOf(loc: import("playwright").Locator): Promise<string> {
  return (await loc.evaluate((el: any) => {
    const l = el.closest("label") ?? (el.id ? (globalThis as any).document.querySelector(`label[for="${el.id}"]`) : null);
    if (l) {
      const c = l.cloneNode(true);
      c.querySelectorAll("input").forEach((i: any) => i.remove());
      return String(c.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    return String(el.getAttribute("aria-label") || el.value || el.innerText || "").trim();
  }).catch(() => "")) as string;
}
