# Companies — the persistent target set

This folder is the memory of *where to look*. It exists so that finding a company
is work done once: after a site lands here it gets re-scanned on every future
run, and new postings surface without anyone re-researching the company.

## The loop

```
  1. ADD       drop careers URLs into any .md file here
  2. INGEST    bun run scripts/companies.ts      → dedupe → registry.yaml
  3. RESOLVE   bun run scripts/resolve.ts        → find each company's job board
  4. SCAN      bun run src/cli.ts scan <ats>:<token>   → how many roles fit
  5. PREPARE   bun run src/cli.ts prepare --targets ...
```

Steps 2 and 3 are **idempotent and resumable**. Re-run them any time; already
resolved companies are skipped, and scan results and manual notes survive.

## Files

| file | what it is |
|---|---|
| `registry.yaml` | **The source of truth.** One entry per company: name, URL, domain, ATS, board token, job counts, last scan. Generated — but hand-edits to `notes` survive. |
| `companies.md` | Organized view, grouped by how targetable each company is. Regenerate with `scripts/organize.ts`. |
| `companies.raw.md.bak` | The original unsorted dump, preserved. |
| `finland-direct.md` | Finnish and Nordic company sites supplied directly. |
| `thehub-nordics.md` | Companies harvested from thehub.io across FI/SE/DK/NO + remote. |

Every `.md` file in this folder is read by the ingest step, so **adding a new
source is just dropping a new file in**. No wiring needed.

## Adding sources

Paste URLs in any shape — bare, markdown links, mixed with prose. The extractor
takes anything matching `https?://…` and the dedupe is canonical (scheme, `www.`
and trailing slashes ignored), so pasting the same company twice costs nothing.

## Harvesting an aggregator

`scripts/thehub.ts` is the worked example. thehub.io is a Nuxt app that ships its
full page state in `window.__NUXT__`; evaluating that expression yields each
job's company name *and website* — no headless browser, no DOM scraping. It
sweeps Finland, Sweden, Denmark, Norway, Iceland and remote, then writes
`thehub-nordics.md`.

Two national portals resist the same treatment and are recorded as sources
rather than targets: **workinfinland.com** (its `__NEXT_DATA__` carries only CMS
navigation; listings load from a separate API) and **tyomarkkinatori.fi**. Both
would need a Firecrawl or Playwright ingest tier.

## Why resolution is the bottleneck

Most careers URLs are corporate pages — `anthropic.com/careers` — that never name
the ATS behind them. `scripts/resolve.ts` derives candidate board tokens from the
company name and domain, then probes Greenhouse, Ashby, Lever, Workable and
SmartRecruiters in turn. Roughly one in four resolves; the rest are on Workday,
iCIMS, Taleo or a bespoke page and need an adapter that does not exist yet.

Use `--match <substring>` to resolve a specific company or region ahead of the
backlog, and `--limit N` to keep each run polite.

## Region and language

The pipeline reads region from each posting and picks the document language:
Brazil → Portuguese, Spanish-speaking LATAM and Mexico → Spanish, everything
else → English. Nordic and EU roles therefore render in English, which is what
those employers screen in.

Finland matters for a second reason: under the stated policy, hybrid and onsite
work is acceptable **in Europe and the US**, so Finnish roles qualify through the
`relocation-europe` path — flagged `requiresSponsorship` and kept in a separate
lane so they never distort the remote pipeline's response-rate measurement.
