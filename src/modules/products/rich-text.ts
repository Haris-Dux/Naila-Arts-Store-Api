import sanitizeHtml from 'sanitize-html';

/**
 * A product description is rich text: HTML written by the dashboard's editor.
 *
 * It is stored already sanitised, so every client can render it as HTML
 * without each one having to get sanitising right. The allowlist is exactly
 * what the editor's toolbar can produce and nothing more — anything else in a
 * submitted description (a script, an event handler, an iframe, arbitrary
 * inline style) was not typed by a merchant into that editor, and is dropped.
 */
const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'h1', 'h2', 'h3', 'strong', 'em', 'u', 's',
    'blockquote', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'hr',
  ],
  allowedAttributes: {
    a: ['href', 'target', 'rel'],
    p: ['style'],
    h1: ['style'],
    h2: ['style'],
    h3: ['style'],
  },
  // Alignment is the one formatting the editor expresses as a style. Allowing
  // `style` in general would let colours, sizes and positioning back in.
  allowedStyles: {
    '*': { 'text-align': [/^(left|right|center|justify)$/] },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
  transformTags: {
    // A link in a description always opens away from the storefront, and never
    // hands the storefront's window to the page it opens.
    a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
    b: 'strong',
    i: 'em',
    strike: 's',
    del: 's',
  },
};

/**
 * Empty paragraphs at the very end. The editor always keeps one after the last
 * block so the caret has somewhere to go; it is not content, and stored it
 * would render as a stray blank line under every description.
 */
const TRAILING_EMPTY = /(?:<p>(?:\s|<br\s*\/?>)*<\/p>)+$/i;

/** Closing block tags and line breaks — where words would otherwise run together once tags go. */
const BLOCK_BOUNDARY = /<\/(p|h[1-6]|li|blockquote|pre)>|<br\s*\/?>/gi;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export interface Description {
  /** Sanitised HTML, or null when the description has no text in it. */
  html: string | null;
  /** The words alone — what the full-text index searches. */
  text: string | null;
}

/**
 * Sanitise a submitted description and derive its searchable text.
 *
 * The text is kept separately because indexing the HTML would index markup:
 * a search for "strong" would match every product with a bold word in it.
 * An editor left empty still submits `<p></p>`, which is stored as no
 * description at all rather than as an empty paragraph.
 */
export function toDescription(input: string | null | undefined): Description {
  if (!input) return { html: null, text: null };

  const html = sanitizeHtml(input, OPTIONS).trim().replace(TRAILING_EMPTY, '');
  const text = toPlainText(html);

  return text ? { html, text } : { html: null, text: null };
}

export function toPlainText(html: string): string {
  const stripped = sanitizeHtml(html.replace(BLOCK_BOUNDARY, '$& '), {
    allowedTags: [],
    allowedAttributes: {},
  });

  return stripped
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/\s+/g, ' ')
    .trim();
}
