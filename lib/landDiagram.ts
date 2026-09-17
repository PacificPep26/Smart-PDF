import { createCanvas } from "@napi-rs/canvas";

export type LandEdge = { label: string; length: number };
export type LandDiagramData = { edges: LandEdge[]; plotNo?: string; area?: string };

const MAX_SIDE = 480;
const SIDE_PADDING = 50;
const TOP_PADDING = 90; // extra headroom for the compass arrow + plot label

/**
 * Renders an approximate land-plot polygon sketch (not to exact scale/angle,
 * which Gemini can't reliably read off a scanned diagram) — walks the given
 * edges in order with equal turning angle (regular-polygon approximation).
 * Styled like a real cadastral hand-sketch: plain outline (no fill), a north
 * compass arrow, and each side's length rotated to follow its edge — rather
 * than a colored/filled shape with axis-aligned labels. The canvas is sized
 * to the polygon's own aspect ratio (not forced square) so narrow/elongated
 * plots don't end up surrounded by a lot of blank space.
 */
export function renderLandDiagram(data: LandDiagramData): Buffer | null {
  const edges = data.edges;
  if (!edges || !edges.length || edges.length > 20) return null;

  const n = edges.length;
  const exteriorTurn = (2 * Math.PI) / n;

  const points: { x: number; y: number }[] = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  points.push({ x, y });
  for (const e of edges) {
    const len = e.length || 1;
    x += Math.cos(heading) * len;
    y += Math.sin(heading) * len;
    points.push({ x, y });
    heading += exteriorTurn;
  }

  const minX = Math.min(...points.map((p) => p.x));
  const maxX = Math.max(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxY = Math.max(...points.map((p) => p.y));
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const fit = MAX_SIDE / Math.max(w, h);

  const canvasW = Math.round(w * fit + SIDE_PADDING * 2);
  const canvasH = Math.round(h * fit + TOP_PADDING + SIDE_PADDING);
  const offX = SIDE_PADDING - minX * fit;
  const offY = TOP_PADDING - minY * fit;
  const norm = points.map((p) => ({ x: p.x * fit + offX, y: p.y * fit + offY }));

  const canvas = createCanvas(canvasW, canvasH);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvasW, canvasH);

  // Plot outline — plain black, no fill, like a real cadastral sketch.
  ctx.beginPath();
  ctx.moveTo(norm[0].x, norm[0].y);
  for (let i = 1; i < norm.length; i++) ctx.lineTo(norm[i].x, norm[i].y);
  ctx.closePath();
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // North compass arrow, top-right.
  const cx = canvasW - 30;
  const cyTop = 20;
  const cyBottom = 55;
  ctx.beginPath();
  ctx.moveTo(cx, cyBottom);
  ctx.lineTo(cx, cyTop);
  ctx.moveTo(cx - 6, cyTop + 10);
  ctx.lineTo(cx, cyTop);
  ctx.lineTo(cx + 6, cyTop + 10);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.font = "bold 14px serif";
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText("N", cx, cyTop - 6);

  // Plot number / area, centered inside the polygon (centroid).
  if (data.plotNo || data.area) {
    const cxCentroid = norm.reduce((s, p) => s + p.x, 0) / norm.length;
    const cyCentroid = norm.reduce((s, p) => s + p.y, 0) / norm.length;
    ctx.font = "bold 13px serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#000000";
    if (data.plotNo) ctx.fillText(data.plotNo, cxCentroid, cyCentroid - 8);
    ctx.font = "12px serif";
    if (data.area) ctx.fillText(data.area, cxCentroid, cyCentroid + 10);
  }

  // Side length labels, rotated to run along their edge.
  ctx.font = "12px serif";
  ctx.fillStyle = "#000000";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  for (let i = 0; i < edges.length; i++) {
    const a = norm[i];
    const b = norm[i + 1];
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    let angle = Math.atan2(b.y - a.y, b.x - a.x);
    if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;

    const labelStr = String(edges[i].label ?? "").trim();
    const isRedundant = !labelStr || Math.abs(parseFloat(labelStr) - edges[i].length) < 0.01;
    const text = isRedundant ? `${edges[i].length}` : `${labelStr}: ${edges[i].length}`;

    ctx.save();
    ctx.translate(midX, midY);
    ctx.rotate(angle);
    ctx.fillText(text, 0, -4);
    ctx.restore();
  }

  return canvas.toBuffer("image/png");
}

const EDGES_MARKER_RE = /<p[^>]*id="landplot-edges"[^>]*>\s*EDGES:(\{[\s\S]*?\})\s*<\/p>/i;

/** Replaces the hidden EDGES:{...} marker paragraph (if present) with a rendered <img> diagram. */
export function injectLandDiagram(html: string): string {
  const match = html.match(EDGES_MARKER_RE);
  if (!match) return html;
  try {
    const data: LandDiagramData = JSON.parse(match[1]);
    const png = renderLandDiagram(data);
    if (!png) return html.replace(match[0], "");
    const dataUri = `data:image/png;base64,${png.toString("base64")}`;
    const img = `<p style="text-align:center;margin:2px 0"><img src="${dataUri}" style="width:360px" /></p>`;
    return html.replace(match[0], img);
  } catch {
    return html.replace(match[0], "");
  }
}
