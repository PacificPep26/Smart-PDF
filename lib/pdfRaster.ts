import { createCanvas, DOMMatrix, Path2D, Image, ImageData } from "@napi-rs/canvas";
import path from "path";
import { pathToFileURL } from "url";

// pdfjs-dist's legacy build expects a DOM-like environment; @napi-rs/canvas
// provides Node-native implementations of the pieces it actually touches.
const g = globalThis as unknown as Record<string, unknown>;
if (!g.DOMMatrix) g.DOMMatrix = DOMMatrix;
if (!g.Path2D) g.Path2D = Path2D;
if (!g.Image) g.Image = Image;
if (!g.ImageData) g.ImageData = ImageData;

async function getPdfjs() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(process.cwd(), "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")
  ).href;
  return pdfjs;
}

export async function loadPdfDocument(bytes: Uint8Array) {
  const pdfjs = await getPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: true,
  });
  return loadingTask.promise;
}

/**
 * Renders a single PDF page to a JPEG buffer at the given zoom factor (1.0 == 72dpi).
 */
export async function renderPageToJpeg(
  pdfDoc: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  pageNum: number,
  zoom: number,
  quality = 0.8
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: zoom });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");

  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;

  const buffer = canvas.toBuffer("image/jpeg", Math.round(quality * 100));
  return { buffer, width: canvas.width, height: canvas.height };
}

/**
 * Renders one half (left/right) of a PDF page as its own JPEG — for landscape
 * A4 sheets that are really two A4 portrait halves glued together (common in
 * Vietnamese land-title booklets: 841.89x595.27pt, i.e. A4 rotated). Splitting
 * before translation lets each half become its own properly-laid-out A4 output
 * page instead of forcing both into one cramped 2-column page.
 */
export async function renderPageHalfToJpeg(
  pdfDoc: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  pageNum: number,
  zoom: number,
  half: "left" | "right",
  quality = 0.92
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: zoom });
  const fullCanvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const fullCtx = fullCanvas.getContext("2d");
  await page.render({ canvasContext: fullCtx as unknown as CanvasRenderingContext2D, viewport }).promise;

  const halfWidth = Math.ceil(fullCanvas.width / 2);
  const srcX = half === "left" ? 0 : fullCanvas.width - halfWidth;
  const canvas = createCanvas(halfWidth, fullCanvas.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(fullCanvas, srcX, 0, halfWidth, fullCanvas.height, 0, 0, halfWidth, fullCanvas.height);

  const buffer = canvas.toBuffer("image/jpeg", Math.round(quality * 100));
  return { buffer, width: canvas.width, height: canvas.height };
}

/** Cheap check of a PDF page's raw dimensions (no rendering) — used to detect landscape A4-x2 sheets. */
export async function getPageDimensions(pdfDoc: any, pageNum: number): Promise<{ width: number; height: number }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1 });
  return { width: viewport.width, height: viewport.height };
}

export async function renderPageToPng(
  pdfDoc: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  pageNum: number,
  zoom: number
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: zoom });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");

  await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport }).promise;

  const buffer = canvas.toBuffer("image/png");
  return { buffer, width: canvas.width, height: canvas.height };
}
