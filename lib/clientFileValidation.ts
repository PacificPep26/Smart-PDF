export type FileValidationResult = { ok: true } | { ok: false; message: string };

export type FileValidationOptions = {
  maxSizeBytes: number;
  allowedExtensions: string[];
  label: string;
};

export const CLIENT_SIZE_LIMITS = {
  pdf: 500 * 1024 * 1024,
  image: 500 * 1024 * 1024,
  docx: 500 * 1024 * 1024,
};

/**
 * Single client-side check shared by all Workspace components — before this,
 * each component rolled its own (extension-only regex here, MIME check
 * there, nothing at all elsewhere). This is a UX convenience only: the real
 * gate is server-side magic-byte validation in lib/apiValidation.ts.
 */
export function validateFile(file: File, opts: FileValidationOptions): FileValidationResult {
  const name = file.name.toLowerCase();
  const hasAllowedExt = opts.allowedExtensions.some((ext) => name.endsWith(ext));
  if (!hasAllowedExt) {
    return {
      ok: false,
      message: `File "${file.name}" không đúng định dạng cho ${opts.label}. Chấp nhận: ${opts.allowedExtensions.join(", ")}.`,
    };
  }
  if (file.size === 0) {
    return { ok: false, message: `File "${file.name}" rỗng.` };
  }
  if (file.size > opts.maxSizeBytes) {
    const maxMb = (opts.maxSizeBytes / (1024 * 1024)).toFixed(0);
    return { ok: false, message: `File "${file.name}" vượt quá dung lượng cho phép (tối đa ${maxMb}MB).` };
  }
  return { ok: true };
}
