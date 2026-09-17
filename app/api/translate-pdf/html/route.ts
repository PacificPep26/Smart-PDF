import { NextRequest, NextResponse } from "next/server";
import { translatePageToHtml } from "@/lib/gemini";
import { loadPdfDocument, renderPageToJpeg, renderPageHalfToJpeg, getPageDimensions } from "@/lib/pdfRaster";
import { sanitizeTranslatedHtml } from "@/lib/sanitizeHtml";
import { injectLandDiagram } from "@/lib/landDiagram";
import { requireFile, assertMagicBytes, assertFileSize, handleApiError, ApiError, SIZE_LIMITS } from "@/lib/apiValidation";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_TRANSLATE_PAGES = 60;
// 2.5x scale (~180dpi) — sharp enough for Gemini to read dense legal-document
// text/stamps reliably, without the huge payloads full print-DPI would mean.
const RENDER_ZOOM = 2.5;

type TranslatedPage = {
  page_num: number;
  translated_html: string;
  group_id: number;
  is_group_lead: boolean;
  group_pages: number[];
};

// Runs `fn` over `items` with at most `limit` in flight at once.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = requireFile(formData, "file");

    assertFileSize(file, SIZE_LIMITS.pdf, "dịch PDF");
    const fileBuffer = await assertMagicBytes(file, "pdf");

    const bytes = new Uint8Array(fileBuffer);
    let pdfDoc;
    try {
      pdfDoc = await loadPdfDocument(bytes);
    } catch {
      throw new ApiError(`File "${file.name}" không phải PDF hợp lệ hoặc đã bị hỏng.`, 400);
    }
    const numPages = pdfDoc.numPages;
    if (numPages > MAX_TRANSLATE_PAGES) {
      throw new ApiError(`PDF có ${numPages} trang, vượt quá giới hạn ${MAX_TRANSLATE_PAGES} trang cho mỗi lần dịch.`, 400);
    }
    // A landscape sheet ~1.4x wider than tall (A4 rotated: 841.89x595.27pt) is
    // typically two A4 portrait halves glued together (Vietnamese land-title
    // booklets scan this way) — split it into two jobs so each half becomes
    // its own properly laid-out A4 output page instead of one cramped page.
    type RenderJob = { pageNum: number; half?: "left" | "right" };
    const jobs: RenderJob[] = [];
    for (let pageIndex = 0; pageIndex < numPages; pageIndex++) {
      const pageNum = pageIndex + 1;
      const { width, height } = await getPageDimensions(pdfDoc, pageNum);
      if (width / height > 1.3) {
        jobs.push({ pageNum, half: "left" }, { pageNum, half: "right" });
      } else {
        jobs.push({ pageNum });
      }
    }

    const translatedPages = await mapWithConcurrency(jobs, 4, async (job, jobIndex): Promise<TranslatedPage> => {
      let html = "";
      try {
        const { buffer } = job.half
          ? await renderPageHalfToJpeg(pdfDoc, job.pageNum, RENDER_ZOOM, job.half, 0.92)
          : await renderPageToJpeg(pdfDoc, job.pageNum, RENDER_ZOOM, 0.92);
        html = await translatePageToHtml(buffer.toString("base64"), "image/jpeg");
      } catch (err) {
        console.error(`Translate page ${job.pageNum}${job.half ? `(${job.half})` : ""} failed:`, err);
      }
      if (!html) html = "<p style='color:#e53e3e;text-align:center;'>Translation failed for this page.</p>";
      else html = injectLandDiagram(html);
      const outputPageNum = jobIndex + 1;
      return {
        page_num: outputPageNum,
        translated_html: sanitizeTranslatedHtml(html),
        group_id: job.pageNum,
        is_group_lead: !job.half || job.half === "left",
        group_pages: [outputPageNum],
      };
    });

    return NextResponse.json({
      original_filename: file.name || "document.pdf",
      total_pages: translatedPages.length,
      mode: "html",
      pages: translatedPages,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
