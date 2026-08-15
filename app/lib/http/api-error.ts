import { NextResponse } from "next/server";

const SECRET_TEXT_PATTERNS = [
  /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/gi,
  /\b(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
  /\/(?:Users|Volumes|private\/var\/folders)\/[^\s"']+/g,
] as const;

export function redactInternalError(error: unknown) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error";
  return SECRET_TEXT_PATTERNS
    .reduce((message, pattern) => message.replace(pattern, "[redacted]"), raw)
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function internalApiError(
  error: unknown,
  options: {
    message: string;
    code?: string;
    headers?: HeadersInit;
    scope?: string;
  },
) {
  const requestId = crypto.randomUUID();
  console.error(
    `[atlas-api] scope=${options.scope ?? "unknown"} requestId=${requestId} error=${redactInternalError(error)}`,
  );
  return NextResponse.json(
    {
      error: options.message,
      code: options.code ?? "internal_error",
      requestId,
    },
    {
      status: 500,
      headers: options.headers,
    },
  );
}
