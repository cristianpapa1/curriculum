/**
 * HTML -> plain text conversion for job descriptions.
 *
 * The hard case is Greenhouse: its `content` field arrives with the markup itself
 * entity-escaped (`&lt;p&gt;`), while ampersands that were already entities in the
 * source HTML arrive escaped twice (`&amp;amp;`, `&amp;nbsp;`). Verified live against
 * boards-api.greenhouse.io/v1/boards/stripe: `&amp;amp;` occurs, `&amp;lt;` does not.
 *
 * So the pipeline is: decode until markup is real -> strip structurally -> decode again.
 */

/** Named entities we resolve. Numeric (`&#8217;`) and hex (`&#x2019;`) forms are handled separately. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  shy: '',
  zwj: '',
  zwnj: '',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  sbquo: '‚',
  bdquo: '„',
  ndash: '–',
  mdash: '—',
  minus: '−',
  hellip: '…',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  plusmn: '±',
  frac12: '½',
  times: '×',
  divide: '÷',
  laquo: '«',
  raquo: '»',
  dagger: '†',
  permil: '‰',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  eacute: 'é',
  egrave: 'è',
  ecirc: 'ê',
  agrave: 'à',
  aacute: 'á',
  acirc: 'â',
  atilde: 'ã',
  ccedil: 'ç',
  iacute: 'í',
  oacute: 'ó',
  ocirc: 'ô',
  otilde: 'õ',
  uacute: 'ú',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  ntilde: 'ñ',
  szlig: 'ß',
};

const ENTITY_PATTERN = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/** Code points below this that are not tab/newline are control characters we drop. */
const MIN_PRINTABLE = 0x20;

/** Resolve a single numeric entity body (`#8217` or `#x2019`) to its character. */
function decodeNumericEntity(body: string): string | null {
  const isHex = body[1] === 'x' || body[1] === 'X';
  const digits = isHex ? body.slice(2) : body.slice(1);
  if (digits.length === 0) return null;

  const code = Number.parseInt(digits, isHex ? 16 : 10);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  // Surrogate halves are not standalone characters; emitting them corrupts the string.
  if (code >= 0xd800 && code <= 0xdfff) return null;
  if (code === 0) return '';

  return String.fromCodePoint(code);
}

/**
 * Decode HTML entities exactly once.
 * Unknown entities are left verbatim so nothing is silently destroyed.
 */
export function decodeEntitiesOnce(input: string): string {
  return input.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body.startsWith('#')) {
      return decodeNumericEntity(body) ?? match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Reveal markup that arrived entity-escaped, without harming literal code samples.
 *
 * Applied only when the input contains escaped tags and no real ones — the exact
 * signature of a Greenhouse `content` field. Exactly one pass runs, so a description
 * that legitimately shows `&amp;lt;div&amp;gt;` to the reader survives as the text
 * `<div>` instead of being decoded into a tag and stripped away.
 */
function revealEscapedMarkup(input: string): string {
  const hasRealTags = /<[a-zA-Z/!]/.test(input);
  const hasEscapedTags = /&lt;\s*\/?[a-zA-Z]/i.test(input);

  return !hasRealTags && hasEscapedTags ? decodeEntitiesOnce(input) : input;
}

/** Replace block-level markup with the newlines and list bullets it implies. */
function applyStructuralBreaks(html: string): string {
  return (
    html
      // Non-content elements: drop tag AND body, or their text leaks into the output.
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      // Explicit line breaks.
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<hr\s*\/?>/gi, '\n\n')
      // List items become "- " bullets.
      .replace(/<li\b[^>]*>/gi, '\n- ')
      // No newline here: the next <li> contributes its own, and </ul> closes the block.
      // Emitting one would put a blank line between every bullet.
      .replace(/<\/li\s*>/gi, '')
      // Paragraph- and section-level blocks become blank-line separated.
      .replace(/<\/(p|div|section|article|header|footer|blockquote|ul|ol|table|h[1-6])\s*>/gi, '\n\n')
      .replace(/<(p|div|section|article|header|footer|blockquote|ul|ol|h[1-6])\b[^>]*>/gi, '\n\n')
      // Table rows and cells.
      .replace(/<\/tr\s*>/gi, '\n')
      .replace(/<\/(td|th)\s*>/gi, '\t')
      // Everything else is inline: drop the tag, keep the text.
      .replace(/<[^>]+>/g, '')
  );
}

/** Strip control characters that survive decoding, preserving tab and newline. */
function stripControlCharacters(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n' || char === '\t') {
      out += char;
      continue;
    }
    if (code < MIN_PRINTABLE || code === 0x7f) {
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

/** Normalize whitespace: trim each line, collapse 3+ blank lines down to 2. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert an HTML (or entity-escaped HTML) job description into readable plain text.
 *
 * Handles: Greenhouse double-escaping, `<br>`/`<p>`/`<li>` line breaks, `<li>` bullets,
 * named/numeric/hex entities, control-character scrubbing, and blank-line collapsing.
 * Returns `''` for empty or non-string input rather than throwing — callers normalize
 * many payload shapes and a missing description is data, not an error.
 */
export function htmlToText(html: string): string {
  if (typeof html !== 'string' || html.length === 0) return '';

  const markupRevealed = revealEscapedMarkup(html);
  const structured = applyStructuralBreaks(markupRevealed);
  // Second decode: resolves entities that were escaped twice (`&amp;amp;` -> `&amp;` -> `&`)
  // and any entity that only became visible once tags were removed.
  const decoded = decodeEntitiesOnce(structured);

  return normalizeWhitespace(stripControlCharacters(decoded));
}
