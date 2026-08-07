import { NextResponse } from "next/server";
import { GitHubSourceContractError } from "../github/source-job-contracts";
import { GitHubSourceRepositoryError } from "../storage/github-source-job-repository";
import { RequestBodyError } from "./enrichment-api";

export function githubSourceApiError(error: unknown) {
  if (error instanceof RequestBodyError || error instanceof GitHubSourceContractError) {
    return NextResponse.json(
      { error: error.message, code: "invalid_input" },
      { status: 400 },
    );
  }
  if (error instanceof GitHubSourceRepositoryError) {
    const status = error.code === "lease_conflict" || error.code === "lease_expired"
      ? 409
      : error.code === "retry_exhausted"
        ? 429
        : 400;
    return NextResponse.json({ error: error.message, code: error.code }, { status });
  }
  console.error(
    "[github-source-api] unhandled",
    error instanceof Error ? `${error.name}: ${error.message}` : "unknown error",
  );
  return NextResponse.json(
    { error: "GitHub source 작업 요청을 처리하지 못했습니다.", code: "unknown" },
    { status: 500 },
  );
}
