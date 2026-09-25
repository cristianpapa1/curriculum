/**
 * Print styling for generated documents.
 *
 * Deliberately conservative. ATS parsers (Greenhouse, Workday, Lever, Taleo)
 * extract text from the PDF layer and routinely mangle multi-column layouts,
 * text inside tables, and anything in a PDF header/footer region. A CV that
 * looks striking and parses into garbage scores zero before a human sees it —
 * so this is single-column, real text, standard section headings, no tables,
 * no images, no icons, generous margins.
 */

export const PRINT_CSS = `
  @page { size: A4; margin: 14mm 14mm 14mm 14mm; }

  * { box-sizing: border-box; }

  body {
    font-family: "Source Serif Pro", Georgia, "Times New Roman", serif;
    font-size: 10.2pt;
    line-height: 1.42;
    color: #1a1a1a;
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  h1 {
    font-size: 19pt;
    letter-spacing: 0.2px;
    margin: 0 0 2px 0;
    font-weight: 700;
  }

  .subtitle {
    font-size: 11.2pt;
    font-weight: 600;
    color: #2c4a6e;
    margin: 0 0 6px 0;
    letter-spacing: 0.2px;
  }

  .workauth {
    font-size: 9.4pt;
    font-weight: 600;
    color: #1d5c2f;
    margin: 0 0 6px 0;
    letter-spacing: 0.1px;
  }

  .contact {
    font-size: 8.9pt;
    color: #3d3d3d;
    margin: 0 0 12px 0;
  }
  .contact a { color: #2c4a6e; text-decoration: none; }
  .contact .sep { color: #9aa5b1; padding: 0 5px; }

  h2 {
    font-size: 9.6pt;
    text-transform: uppercase;
    letter-spacing: 1.1px;
    color: #2c4a6e;
    border-bottom: 0.8pt solid #c7d2de;
    padding-bottom: 2.5px;
    margin: 13px 0 7px 0;
    font-weight: 700;
    /* Never orphan a heading at the foot of a page. */
    break-after: avoid;
    page-break-after: avoid;
  }

  .summary { margin: 0 0 2px 0; text-align: justify; }

  .role { margin: 0 0 9px 0; break-inside: avoid; page-break-inside: avoid; }
  .role-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 10px;
    margin-bottom: 1px;
  }
  .role-title { font-weight: 700; font-size: 10.6pt; }
  .role-org { font-style: italic; color: #333; }
  .role-dates { font-size: 8.9pt; color: #5a5a5a; white-space: nowrap; }

  ul { margin: 3px 0 0 0; padding-left: 15px; }
  li { margin-bottom: 2.6px; }

  ul.highlights { margin: 2px 0 0 0; padding-left: 15px; }
  ul.highlights li { margin-bottom: 3.2px; }
  .metric {
    font-weight: 700;
    color: #1d3f66;
    white-space: nowrap;
  }

  .skills-row { margin-bottom: 3.5px; }
  .skills-label { font-weight: 700; }

  .edu-item, .cert-item { margin-bottom: 3px; }
  .edu-inst { font-weight: 600; }
  .muted { color: #5a5a5a; font-size: 9.2pt; }

  .cols2 { column-count: 2; column-gap: 18px; }

  /* Cover letter */
  .letter p { margin: 0 0 9px 0; text-align: justify; }
  .letter .salutation { margin-bottom: 10px; }
  .letter .signoff { margin-top: 14px; }
`;

export function htmlDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export function escapeHtml(value: unknown): string {
  // Coerced rather than typed-strict: YAML happily hands back numbers for
  // date-ish fields, and a template should never crash on one.
  const s = typeof value === "string" ? value : String(value ?? "");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
