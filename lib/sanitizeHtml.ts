import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p", "div", "span", "table", "thead", "tbody", "tr", "td", "th",
  "b", "strong", "i", "em", "br", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
  "img",
];

/**
 * Cleans HTML translated by Gemini before it's rendered by Puppeteer
 * (page.setContent) or walked by cheerio for DOCX export. Strips scripts,
 * event handlers, and any src/href — Gemini output has occasionally come
 * back malformed/unexpected, and an unsanitized page.setContent() would
 * execute whatever it contains inside the headless Chromium process.
 */
export function sanitizeTranslatedHtml(html: string): string {
  return sanitizeHtml(html || "", {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      "*": ["style"],
      img: ["src", "style"],
    },
    allowedSchemesAppliedToAttributes: ["src"],
    // Only our own server-generated data:image/png diagrams ever reach `src` —
    // it's set by injectLandDiagram(), never taken from Gemini's raw output.
    allowedSchemes: ["data"],
    allowedStyles: {
      "*": {
        "text-align": [/^left$|^right$|^center$|^justify$/],
        "font-weight": [/^\d+$/, /^bold$|^normal$/],
        "font-style": [/^italic$|^normal$/],
        "font-size": [/^\d+(\.\d+)?(pt|px)$/],
        width: [/^\d+(%|px)?$/],
        color: [/^#[0-9a-f]{3,6}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i, /^[a-z]+$/i],
        "background-color": [/^#[0-9a-f]{3,6}$/i, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/i, /^[a-z]+$/i],
        border: [/^\d+px solid #[0-9a-f]{3,6}$/i, /^none$/],
        "border-collapse": [/^collapse$|^separate$/],
        "table-layout": [/^fixed$|^auto$/],
        padding: [/^\d+px(\s+\d+px){0,3}$/],
        margin: [/^\d+px(\s+\d+px){0,3}$/],
        "line-height": [/^\d+(\.\d+)?$/],
      },
    },
    disallowedTagsMode: "discard",
    allowVulnerableTags: false,
  });
}
