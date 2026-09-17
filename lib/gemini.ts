import { GoogleGenAI } from "@google/genai";

// gemini-2.0-flash and gemini-1.5-flash were retired by Google — their API
// error now points directly at gemini-3.6-flash as the replacement.
const GEMINI_MODELS = ["gemini-3.6-flash", "gemini-2.5-flash"];

export const VISION_PROMPT = `You are a Vietnamese-to-English legal document translator for consular purposes.

Read this Vietnamese PDF and output an HTML fragment that:
1. Translates ALL Vietnamese text to English — nothing left in Vietnamese
2. Reproduces the EXACT same visual layout and structure as the original document
3. Uses inline CSS for all styling

Layout rules:
- Keep the same number of columns, same table structure, same field arrangement as the original
- Borderless layout tables (headers, 2-col fields, signatures): use <table style="width:100%;border-collapse:collapse;table-layout:fixed"> with <td style="border:none;word-wrap:break-word">
- Data tables with visible lines (grade tables, tax detail tables): use <table style="width:100%;border-collapse:collapse;table-layout:fixed"> with <td style="border:1px solid #666;padding:2px 4px;word-wrap:break-word">
- Table header row (<th>, first row of a data table): style="font-weight:bold;text-align:center" — bold black text on plain white/bordered background, no color fill
- Document title (e.g. BIRTH CERTIFICATE, STATE BUDGET PAYMENT SLIP): standalone <p style="text-align:center;font-size:14pt;font-weight:bold;color:#C00000;margin:8px 0"> — NOT inside a table cell, colored dark red like an official certificate title
- Section headings within the body (e.g. "I. Land plot", "Father's information"): <p style="font-size:11pt;font-weight:bold;color:#1F4E79;margin:6px 0 2px">
- "SOCIALIST REPUBLIC OF VIETNAM": font-size:10pt; font-weight:bold; text-align:center
- "Independence - Freedom - Happiness": font-size:9pt; font-style:italic; text-align:center
- Default text: font-size:9pt; line-height:1.5
- Labels bold, values normal
- Signatory/signer full names under a signature line, and any explicit warning or "must not alter/erase" notice: color:#FF0000 — matches how these are conventionally marked on the real certificate

Translation rules:
- Personal names → UPPERCASE Latin no diacritics (NGUYEN VAN AN)
- "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM" → "SOCIALIST REPUBLIC OF VIETNAM"
- "Độc lập - Tự do - Hạnh phúc" → "Independence - Freedom - Happiness"
- Dates: write as "August 12th, 2010" or "March 7th, 1968" (month name + ordinal day + year)
- Standard terms: Giấy khai sinh→Birth Certificate, Giấy đăng ký kết hôn→Marriage Certificate,
  Học bạ→School Report, Giấy nộp tiền vào ngân sách nhà nước→State Budget Payment Slip,
  Người nộp thuế→Taxpayer, Thuế GTGT→VAT, Tổng cộng→Total, Họ và tên→Full name,
  Ngày tháng năm sinh→Date of birth, Nơi sinh→Place of birth, Dân tộc→Ethnic group,
  Quốc tịch→Nationality, Chủ tịch→Chairman

Ignore circular stamps/seals — do not include their text.
Do NOT draw or reproduce any graphical/pictorial element — no national emblem, no flag icon (star, red background box, etc.), no logos, no decorative borders. These are graphics, not text — skip them entirely (leave that area blank) rather than approximating them with colored divs/shapes. Only output translated TEXT laid out in standard A4 paragraphs/tables at the correct position — same reading order and field placement as the original, not a pixel-accurate redraw.

Land-plot diagram (sơ đồ thửa đất) exception: if present, in addition to listing the side labels/lengths as normal text, also emit ONE extra hidden paragraph, exactly once per page, right after that section, with this exact format (edges listed in order walking around the polygon, closed loop, length in meters as a plain number; plotNo/area are the plot number and area normally written inside the sketch):
<p id="landplot-edges">EDGES:{"edges":[{"label":"1-2","length":12.5},{"label":"2-3","length":8.3},{"label":"3-4","length":12.5},{"label":"4-1","length":8.3}],"plotNo":"121","area":"27409.7"}</p>
Only emit this if a land-plot diagram is actually present on the page. Omit it entirely otherwise.

You MUST use inline color styling exactly like this example for titles/headings/signatures — do not output plain black-and-white text for those, that is treated as a failed translation. Table headers stay plain bold (no background color):

<p style="text-align:center;font-size:14pt;font-weight:bold;color:#C00000;margin:8px 0">BIRTH CERTIFICATE</p>
<p style="font-size:11pt;font-weight:bold;color:#1F4E79;margin:6px 0 2px">I. Child's information</p>
<table style="width:100%;border-collapse:collapse;table-layout:fixed">
  <tr>
    <th style="font-weight:bold;text-align:center;border:1px solid #666;padding:2px 4px">From month</th>
    <th style="font-weight:bold;text-align:center;border:1px solid #666;padding:2px 4px">To month</th>
  </tr>
  <tr><td style="border:1px solid #666;padding:2px 4px">07/2026</td><td style="border:1px solid #666;padding:2px 4px">09/2026</td></tr>
</table>
<p>Signed by: <span style="color:#FF0000;font-weight:bold">TRAN VAN AN</span></p>

Return ONLY the HTML fragment. No markdown, no explanation.`;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callGemini(model: string, apiKey: string, dataBase64: string, mimeType: string, retries = 3): Promise<string> {
  const client = new GoogleGenAI({ apiKey });
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await client.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [{ inlineData: { data: dataBase64, mimeType } }, { text: VISION_PROMPT }],
          },
        ],
        config: { temperature: 0.05, maxOutputTokens: 16384 },
      });
      return (response.text || "").trim();
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      if (msg.includes("400") || msg.includes("404") || msg.includes("INVALID_ARGUMENT")) throw err;
      if (attempt < retries - 1) await sleep(2 ** attempt * 1000);
    }
  }
  throw lastErr;
}

/**
 * Translates one page, given as a rendered JPEG/PNG image rather than a
 * PDF — Gemini's own PDF-parsing pipeline can silently downsample scanned
 * pages (photographed legal documents especially) below a legible
 * resolution, where a raster image we control the DPI for reads reliably.
 */
export async function translatePageToHtml(imageBase64: string, mimeType = "image/jpeg"): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY chưa được cấu hình");

  for (const model of GEMINI_MODELS) {
    try {
      const raw = await callGemini(model, apiKey, imageBase64, mimeType);
      const cleaned = raw.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/i, "").trim();
      if (cleaned && cleaned.length > 30) return cleaned;
    } catch (err) {
      console.warn(`Page translate model ${model} failed:`, err);
    }
  }
  return "";
}
