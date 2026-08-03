import { NextResponse } from "next/server";
import {
  EnrichmentRepositoryError,
} from "../storage/enrichment-job-repository";
import { EnrichmentValidationError } from "../llm/enrichment-result-validator";

export class RequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestBodyError";
  }
}

export async function readLimitedJson(
  request: Request,
  maximumBytes = 256_000,
): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maximumBytes) throw new RequestBodyError("요청 본문이 너무 큽니다.");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new RequestBodyError("요청 본문이 너무 큽니다.");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RequestBodyError("요청 본문이 유효한 JSON이 아닙니다.");
  }
}

export function enrichmentApiError(error: unknown) {
  if (error instanceof RequestBodyError || error instanceof EnrichmentValidationError) {
    return NextResponse.json({ error: error.message, code: "invalid_result" }, { status: 400 });
  }
  if (error instanceof EnrichmentRepositoryError) {
    const status = error.code === "lease_conflict" || error.code === "lease_expired" ? 409 : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "보강 작업 요청을 처리하지 못했습니다.", code: "unknown" },
    { status: 500 },
  );
}

export const asObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
