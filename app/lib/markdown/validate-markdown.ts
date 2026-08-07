export const MAX_MARKDOWN_FILE_SIZE = 2 * 1024 * 1024;
export const MAX_MARKDOWN_FILES = 20;

const MARKDOWN_EXTENSION = /\.(md|mdx)$/i;
const BINARY_SIGNATURES = [
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0x25, 0x50, 0x44, 0x46], // PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP / DOCX / JAR
  [0x7f, 0x45, 0x4c, 0x46], // ELF
] as const;

export function validateMarkdownFileName(fileName: string) {
  if (!MARKDOWN_EXTENSION.test(fileName)) {
    throw new Error(`${fileName}: .md 또는 .mdx 파일만 지원합니다.`);
  }
}

function hasBinarySignature(bytes: Uint8Array) {
  return BINARY_SIGNATURES.some(
    (signature) =>
      bytes.length >= signature.length &&
      signature.every((value, index) => bytes[index] === value),
  );
}

function looksBinary(bytes: Uint8Array) {
  if (hasBinarySignature(bytes)) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  let controls = 0;
  for (const value of sample) {
    if (value === 0) return true;
    if (value < 0x20 && value !== 0x09 && value !== 0x0a && value !== 0x0d) {
      controls += 1;
    }
  }
  return sample.length > 0 && controls / sample.length > 0.01;
}

export function decodeMarkdownBytes(fileName: string, input: ArrayBuffer) {
  validateMarkdownFileName(fileName);
  const bytes = new Uint8Array(input);
  if (bytes.byteLength > MAX_MARKDOWN_FILE_SIZE) {
    throw new Error(`${fileName}: 파일 크기는 2MB 이하여야 합니다.`);
  }
  if (looksBinary(bytes)) {
    throw new Error(`${fileName}: Markdown으로 위장한 바이너리 파일은 처리할 수 없습니다.`);
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    validateDecodedMarkdown(fileName, source, bytes.byteLength);
    return source;
  } catch {
    throw new Error(`${fileName}: UTF-8로 인코딩된 문서만 지원합니다.`);
  }
}

export function validateDecodedMarkdown(
  fileName: string,
  source: string,
  byteLength: number,
) {
  validateMarkdownFileName(fileName);
  if (byteLength > MAX_MARKDOWN_FILE_SIZE) {
    throw new Error(`${fileName}: 파일 크기는 2MB 이하여야 합니다.`);
  }
  const sample = source.slice(0, 8192);
  const knownBinaryText =
    sample.startsWith("%PDF") ||
    sample.startsWith("PK\u0003\u0004") ||
    sample.includes("\u0000") ||
    /^[\uFFFD]?PNG[\r\n\u001a]/.test(sample);
  const controls = [...sample].filter((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 && character !== "\t" && character !== "\n" && character !== "\r";
  }).length;
  if (knownBinaryText || (sample.length > 0 && controls / sample.length > 0.01)) {
    throw new Error(`${fileName}: Markdown으로 위장한 바이너리 파일은 처리할 수 없습니다.`);
  }
}
