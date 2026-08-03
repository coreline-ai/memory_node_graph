import { NextResponse } from "next/server";

type WriteAccessMode = "public" | "authenticated";

const trustedIdentityHeaders = [
  "oai-authenticated-user-id",
  "x-openai-user-id",
  "cf-access-authenticated-user-email",
] as const;

function writeAccessMode(): WriteAccessMode {
  return process.env.ATLAS_WRITE_ACCESS === "authenticated" ? "authenticated" : "public";
}

/**
 * Keeps graph reads public while allowing mutations to sit behind the hosting
 * platform's OAuth/authentication proxy. Only enable `authenticated` when that
 * proxy strips client-supplied identity headers and injects its own trusted one.
 */
export function requireAtlasWriteAccess(request: Request) {
  if (writeAccessMode() === "public") return null;

  const identity = trustedIdentityHeaders
    .map((header) => request.headers.get(header)?.trim())
    .find(Boolean);

  if (identity) return null;

  return NextResponse.json(
    {
      error: "문서 변경 작업에는 로그인이 필요합니다.",
      code: "ATLAS_AUTH_REQUIRED",
    },
    { status: 401 },
  );
}
