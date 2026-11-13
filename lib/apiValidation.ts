import { NextResponse } from "next/server";

/** Thrown for any client-input problem — caught by `handleApiError` and turned into a proper 4xx JSON response. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Single place every route's catch block should call. Logs the real error server-side, never leaks it to the client. */
export function handleApiError(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ detail: err.message }, { status: err.status });
  }
  console.error(err);
  return NextResponse.json({ detail: "Đã xảy ra lỗi máy chủ, vui lòng thử lại." }, { status: 500 });
}

export function requireFile(form: FormData, field: string): File {
  const file = form.get(field);
  if (!(file instanceof File) || file.size === 0) {
    throw new ApiError(`Không có file hợp lệ ở trường "${field}".`, 400);
  }
  return file;
}

export function requireFiles(form: FormData, field: string): File[] {
  const files = form.getAll(field).filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) {
    throw new ApiError("Không có file nào được gửi lên.", 400);
  }
  return files;
}

const SIGNATURES: Record<string, { bytes: number[]; offset?: number }[]> = {
  pdf: [{ bytes: [0x25, 0x50, 0x44, 0x46] }], // %PDF
  // docx/xlsx/zip-based Office formats all start with the local-file-header zip signature
  docx: [{ bytes: [0x50, 0x4b, 0x03, 0x04] }],
  image: [
    { bytes: [0xff, 0xd8, 0xff] }, // jpeg
    { bytes: [0x89, 0x50, 0x4e, 0x47] }, // png
    { bytes: [0x47, 0x49, 0x46, 0x38] }, // gif
    { bytes: [0x52, 0x49, 0x46, 0x46] }, // webp (RIFF....WEBP)
    { bytes: [0x42, 0x4d] }, // bmp
    { bytes: [0x49, 0x49, 0x2a, 0x00] }, // tiff (little-endian)
    { bytes: [0x4d, 0x4d, 0x00, 0x2a] }, // tiff (big-endian)
    { bytes: [0x00, 0x00, 0x01, 0x00] }, // ico (sometimes used for favicons/heic containers vary, best-effort)
  ],
};

const KIND_LABEL: Record<keyof typeof SIGNATURES, string> = {
  pdf: "PDF",
  docx: "Word (.docx)",
  image: "ảnh",
};

/** Reads the file once, checks its magic bytes, and returns the buffer so the caller doesn't re-read the stream. */
export async function assertMagicBytes(file: File, kind: keyof typeof SIGNATURES): Promise<Buffer> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const candidates = SIGNATURES[kind];
  const matches = candidates.some((sig) => {
    const offset = sig.offset ?? 0;
    if (buffer.length < offset + sig.bytes.length) return false;
    return sig.bytes.every((b, i) => buffer[offset + i] === b);
  });
  // HEIC/HEIF and some newer image containers don't have a simple fixed-offset
  // magic number check here; fall back to trusting the browser-reported MIME
  // type for images so those formats aren't rejected outright.
  const trustMime = kind === "image" && file.type.startsWith("image/") && !matches;
  if (!matches && !trustMime) {
    throw new ApiError(`Tệp "${file.name}" không phải định dạng ${KIND_LABEL[kind]} hợp lệ hoặc đã bị hỏng.`, 400);
  }
  return buffer;
}

export function assertFileSize(file: File, maxBytes: number, label: string): void {
  if (file.size > maxBytes) {
    const maxMb = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new ApiError(`Tệp "${file.name}" vượt quá dung lượng cho phép (tối đa ${maxMb}MB) cho ${label}.`, 400);
  }
}

export const SIZE_LIMITS = {
  pdf: 500 * 1024 * 1024,
  image: 500 * 1024 * 1024,
  docx: 500 * 1024 * 1024,
};

export function assertEnum<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
  label: string
): T {
  if (value === null || value === "") return fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ApiError(`Giá trị "${label}" không hợp lệ. Chỉ chấp nhận: ${allowed.join(", ")}.`, 400);
  }
  return value as T;
}

export function assertBoundedNumber(
  raw: string | null,
  opts: { min: number; max: number; default: number; integer?: boolean },
  label: string
): number {
  if (raw === null || raw === "") return opts.default;
  const n = Number(raw);
  if (!Number.isFinite(n) || (opts.integer && !Number.isInteger(n)) || n < opts.min || n > opts.max) {
    throw new ApiError(`Giá trị "${label}" không hợp lệ, phải trong khoảng ${opts.min}-${opts.max}.`, 400);
  }
  return n;
}

export function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError("Dữ liệu JSON gửi lên không hợp lệ.", 400);
  }
}

/**
 * Builds a Content-Disposition filename that's safe against header injection
 * (strips CR/LF/control chars) while preserving Vietnamese diacritics via the
 * RFC 5987 filename* parameter, with an ASCII-only fallback for older clients.
 */
export function sanitizeFilenameForHeader(name: string, fallback: string): string {
  const cleaned = (name || "").replace(/[\r\n"]/g, "").trim();
  const base = cleaned || fallback;
  const asciiFallback = base.replace(/[^\x20-\x7e]/g, "_") || fallback;
  const encoded = encodeURIComponent(base);
  return `filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}
