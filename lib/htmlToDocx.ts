import * as cheerio from "cheerio";
import type { Element, AnyNode } from "domhandler";
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, ImageRun, AlignmentType, WidthType, BorderStyle, ShadingType } from "docx";

/** data:image/png;base64,.... -> raw PNG bytes, or undefined if not a data URI we recognize. */
function decodeDataUriPng(src: string | undefined): Buffer | undefined {
  if (!src) return undefined;
  const m = src.match(/^data:image\/png;base64,([a-z0-9+/=]+)$/i);
  return m ? Buffer.from(m[1], "base64") : undefined;
}

function parseInlineStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!style) return out;
  for (const decl of style.split(";")) {
    const [k, v] = decl.split(":");
    if (k && v) out[k.trim().toLowerCase()] = v.trim().toLowerCase();
  }
  return out;
}

/** "#ff0000" / "#f00" / "red" / "rgb(255,0,0)" → "FF0000" (docx requires exactly 6 bare hex digits, no #, no named colors, no shorthand — anything that doesn't resolve to that is dropped rather than passed through and crashing the docx builder). */
const NAMED_COLORS: Record<string, string> = {
  red: "FF0000", blue: "0070C0", darkblue: "1F4E79", navy: "1F4E79", green: "006400",
  white: "FFFFFF", black: "000000", gray: "808080", grey: "808080", orange: "FFA500", yellow: "FFFF00",
};
function toDocxColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  let hex: string | undefined;
  if (v.startsWith("#")) {
    const body = v.slice(1);
    if (body.length === 3) hex = body.split("").map((c) => c + c).join("");
    else if (body.length === 6) hex = body;
  } else if (NAMED_COLORS[v]) {
    hex = NAMED_COLORS[v];
  } else {
    const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (rgb) hex = rgb.slice(1, 4).map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("");
  }
  return hex && /^[0-9a-f]{6}$/.test(hex) ? hex.toUpperCase() : undefined;
}

/** "10pt" / "14px" → half-points for docx's `size` (docx TextRun size is in half-points: 10pt = 20). */
function toDocxHalfPoints(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = raw.match(/^([\d.]+)(pt|px)?$/);
  if (!m) return undefined;
  const n = Number(m[1]);
  const pt = m[2] === "px" ? n * 0.75 : n;
  return Math.round(pt * 2);
}

const MAX_WALK_DEPTH = 50;

type RunStyle = { bold: boolean; italic: boolean; color?: string; size?: number };

function textRunsFromNode($: ReturnType<typeof cheerio.load>, el: Element, base: Partial<RunStyle> = {}): TextRun[] {
  const runs: TextRun[] = [];
  const node = $(el);

  const walk = (n: AnyNode, ctx: RunStyle, depth: number) => {
    if (depth > MAX_WALK_DEPTH) return;
    if (n.type === "text") {
      const text = $(n).text();
      if (text) runs.push(new TextRun({ text, bold: ctx.bold, italics: ctx.italic, color: ctx.color, size: ctx.size }));
      return;
    }
    if (n.type === "tag") {
      const el = n as Element;
      const tag = el.tagName?.toLowerCase();
      const style = parseInlineStyle($(el).attr("style"));
      const next: RunStyle = {
        bold: ctx.bold || tag === "b" || tag === "strong" || style["font-weight"] === "bold" || Number(style["font-weight"]) >= 600,
        italic: ctx.italic || tag === "i" || tag === "em" || style["font-style"] === "italic",
        color: toDocxColor(style["color"]) ?? ctx.color,
        size: toDocxHalfPoints(style["font-size"]) ?? ctx.size,
      };
      if (tag === "br") {
        runs.push(new TextRun({ text: "", break: 1 }));
        return;
      }
      el.children?.forEach((c) => walk(c as AnyNode, next, depth + 1));
    }
  };

  const baseCtx: RunStyle = { bold: base.bold ?? false, italic: base.italic ?? false, color: base.color, size: base.size };
  node.contents().each((_, c) => walk(c as AnyNode, baseCtx, 0));
  if (runs.length === 0) {
    const text = node.text();
    if (text.trim()) runs.push(new TextRun({ text, bold: baseCtx.bold, color: baseCtx.color, size: baseCtx.size }));
  }
  return runs;
}

function alignmentFromStyle(style: Record<string, string>): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  const align = style["text-align"];
  if (align === "center") return AlignmentType.CENTER;
  if (align === "right") return AlignmentType.RIGHT;
  if (align === "justify") return AlignmentType.JUSTIFIED;
  return undefined;
}

function imageParagraph($: ReturnType<typeof cheerio.load>, imgEl: Element): Paragraph | undefined {
  const png = decodeDataUriPng($(imgEl).attr("src"));
  if (!png) return undefined;
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({ data: png, type: "png", transformation: { width: 280, height: 280 } })],
  });
}

/** <tr> elements that belong directly to `tableEl` — not to any table nested inside one of its cells. */
function ownRows($: ReturnType<typeof cheerio.load>, tableEl: Element): Element[] {
  return $(tableEl)
    .find("tr")
    .filter((_, tr) => $(tr).closest("table").get(0) === tableEl)
    .toArray();
}

/** <td>/<th> elements that belong directly to `tr` — not to any table nested inside one of its cells. */
function ownCells($: ReturnType<typeof cheerio.load>, tr: Element): Element[] {
  return $(tr)
    .find("td, th")
    .filter((_, cell) => $(cell).closest("tr").get(0) === tr)
    .toArray();
}

/** Flattens <div> wrappers so their <p>/<img>/<table> children become direct block-level items (a <div> itself isn't a paragraph — it's just a grouping wrapper). */
function flattenBlockChildren($: ReturnType<typeof cheerio.load>, parent: Element): Element[] {
  const out: Element[] = [];
  $(parent)
    .children()
    .each((_, c) => {
      const tag = c.tagName?.toLowerCase();
      if (tag === "div") out.push(...flattenBlockChildren($, c));
      else if (["p", "img", "table"].includes(tag ?? "")) out.push(c);
    });
  return out;
}

/** A table cell's content, as Paragraphs/nested Tables — handles plain inline text, <p>/<img> children (e.g. a heading followed by a diagram image), and a <table> nested inside the cell. */
function cellContent($: ReturnType<typeof cheerio.load>, td: Element, base: Partial<RunStyle>, alignment: ReturnType<typeof alignmentFromStyle>): (Paragraph | Table)[] {
  const blockChildren = flattenBlockChildren($, td);

  if (blockChildren.length === 0) {
    const runs = textRunsFromNode($, td, base);
    return [new Paragraph({ children: runs.length ? runs : [new TextRun("")], alignment })];
  }

  const out: (Paragraph | Table)[] = [];
  for (const child of blockChildren) {
    const tag = child.tagName?.toLowerCase();
    if (tag === "table") {
      out.push(buildTable($, child));
      continue;
    }
    const imgEl = tag === "img" ? child : $(child).find("img").get(0);
    if (imgEl) {
      const p = imageParagraph($, imgEl);
      if (p) out.push(p);
      continue;
    }
    const childStyle = parseInlineStyle($(child).attr("style"));
    const runs = textRunsFromNode($, child, { ...base, color: toDocxColor(childStyle["color"]) ?? base.color });
    if (runs.length) out.push(new Paragraph({ children: runs, alignment: alignmentFromStyle(childStyle) ?? alignment }));
  }
  return out.length ? out : [new Paragraph({ children: [new TextRun("")], alignment })];
}

function buildTable($: ReturnType<typeof cheerio.load>, tableEl: Element): Table {
  const style = parseInlineStyle($(tableEl).attr("style"));
  const rows: TableRow[] = [];
  for (const tr of ownRows($, tableEl)) {
    const cells: TableCell[] = [];
    for (const td of ownCells($, tr)) {
      const cellStyle = parseInlineStyle($(td).attr("style"));
      const borderless = cellStyle["border"] === "none" || style["border"] === "none";
      const isHeaderCell = td.tagName?.toLowerCase() === "th";
      const cellColor = toDocxColor(cellStyle["color"]);
      const alignment = alignmentFromStyle(cellStyle);
      const fill = toDocxColor(cellStyle["background-color"] ?? cellStyle["background"]);
      const content = cellContent($, td, isHeaderCell ? { bold: true, color: cellColor } : { color: cellColor }, alignment);
      cells.push(
        new TableCell({
          children: content,
          shading: fill ? { type: ShadingType.CLEAR, color: "auto", fill } : undefined,
          borders: borderless
            ? {
                top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
                bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
                left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
                right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
              }
            : undefined,
        })
      );
    }
    if (cells.length) rows.push(new TableRow({ children: cells }));
  }

  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
}

/** Converts a translated HTML fragment (one page) into docx paragraphs/tables. */
function htmlToDocxElements(html: string): (Paragraph | Table)[] {
  const $ = cheerio.load(`<div id="root">${html}</div>`);
  const root = $("#root")[0];
  const elements: (Paragraph | Table)[] = [];

  flattenBlockChildren($, root).forEach((el) => {
      const tag = el.tagName?.toLowerCase();
      if (tag === "table") {
        elements.push(buildTable($, el));
        return;
      }
      const style = parseInlineStyle($(el).attr("style"));
      const imgEl = tag === "img" ? el : $(el).find("img").get(0);
      if (imgEl) {
        const png = decodeDataUriPng($(imgEl).attr("src"));
        if (png) {
          elements.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new ImageRun({ data: png, type: "png", transformation: { width: 280, height: 280 } })],
            })
          );
        }
        return;
      }
      const bold = style["font-weight"] === "bold" || Number(style["font-weight"]) >= 600;
      const runs = textRunsFromNode($, el, { bold, color: toDocxColor(style["color"]), size: toDocxHalfPoints(style["font-size"]) });
      if (runs.length === 0) return;
      elements.push(
        new Paragraph({
          children: runs,
          alignment: alignmentFromStyle(style),
        })
      );
    });

  if (elements.length === 0) {
    const text = $(root).text().trim();
    if (text) elements.push(new Paragraph({ children: [new TextRun(text)] }));
  }

  return elements;
}

type TranslationPage = { translated_html?: string };
type TranslationResult = { pages?: TranslationPage[] };

export async function buildDocxFromTranslation(result: TranslationResult): Promise<Buffer> {
  const pages = result.pages || [];
  const children: (Paragraph | Table)[] = [];

  pages.forEach((page, idx) => {
    const html = page.translated_html || "";
    if (!html.trim()) return;
    children.push(...htmlToDocxElements(html));
    if (idx < pages.length - 1) {
      children.push(new Paragraph({ children: [], pageBreakBefore: true }));
    }
  });

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: children.length ? children : [new Paragraph("")],
      },
    ],
    styles: {
      default: {
        document: {
          run: { font: "Times New Roman", size: 20 },
        },
      },
    },
  });

  return Packer.toBuffer(doc);
}
