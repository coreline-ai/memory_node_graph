import { NextResponse } from "next/server";

type WriteAccessMode = "public" | "authenticated";
type AtlasExposureMode = "local" | "proxy";

const trustedIdentityHeaders = [
  "oai-authenticated-user-id",
  "x-openai-user-id",
  "cf-access-authenticated-user-email",
] as const;

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function exposureMode(): AtlasExposureMode {
  return process.env.ATLAS_EXPOSURE_MODE === "proxy" ? "proxy" : "local";
}

function writeAccessMode(): WriteAccessMode {
  if (exposureMode() === "proxy") return "authenticated";
  return process.env.ATLAS_WRITE_ACCESS === "authenticated" ? "authenticated" : "public";
}

function trustedIdentity(request: Request) {
  return trustedIdentityHeaders
    .map((header) => request.headers.get(header)?.trim())
    .find(Boolean);
}

function configuredAppOrigin() {
  const raw = process.env.ATLAS_APP_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function requestHostAllowed(request: Request) {
  const requestUrl = new URL(request.url);
  if (exposureMode() === "local") return localHosts.has(requestUrl.hostname);
  const appOrigin = configuredAppOrigin();
  return appOrigin !== null && requestUrl.origin === appOrigin;
}

function hostDeniedResponse() {
  return NextResponse.json(
    {
      error: "허용되지 않은 Atlas 호스트입니다.",
      code: "ATLAS_HOST_FORBIDDEN",
    },
    { status: 403 },
  );
}

function crossSiteMutationResponse(request: Request) {
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") {
    return NextResponse.json(
      { error: "외부 사이트의 변경 요청은 허용되지 않습니다.", code: "ATLAS_CROSS_SITE_FORBIDDEN" },
      { status: 403 },
    );
  }

  const suppliedOrigin = request.headers.get("origin")?.trim();
  if (!suppliedOrigin) return null;
  let origin: string;
  try {
    origin = new URL(suppliedOrigin).origin;
  } catch {
    return NextResponse.json(
      { error: "요청 Origin 형식이 올바르지 않습니다.", code: "ATLAS_ORIGIN_INVALID" },
      { status: 403 },
    );
  }

  const expectedOrigin = exposureMode() === "proxy"
    ? configuredAppOrigin()
    : new URL(request.url).origin;
  if (expectedOrigin === null || origin !== expectedOrigin) {
    return NextResponse.json(
      { error: "허용되지 않은 Origin의 변경 요청입니다.", code: "ATLAS_ORIGIN_FORBIDDEN" },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Keeps single-user loopback writes available while allowing the integrated
 * app to sit behind an OAuth/authentication proxy. Only enable remote proxy
 * exposure when it strips client identity headers and injects a trusted one.
 */
export function requireAtlasWriteAccess(request: Request) {
  if (!requestHostAllowed(request)) return hostDeniedResponse();
  const crossSite = crossSiteMutationResponse(request);
  if (crossSite) return crossSite;
  if (writeAccessMode() === "public") return null;

  if (trustedIdentity(request)) return null;

  return NextResponse.json(
    {
      error: "문서 변경 작업에는 로그인이 필요합니다.",
      code: "ATLAS_AUTH_REQUIRED",
    },
    { status: 401 },
  );
}

/**
 * Full D1 reads stay available to the single-user loopback app. Once an OAuth
 * proxy is explicitly enabled, those reads require the same trusted identity
 * as mutations; the public Vercel app continues to use static JSON instead.
 */
export function requireAtlasReadAccess(request: Request) {
  if (!requestHostAllowed(request)) return hostDeniedResponse();
  if (exposureMode() === "local") return null;
  if (trustedIdentity(request)) return null;
  return NextResponse.json(
    {
      error: "로컬 전체 그래프 조회에는 로그인이 필요합니다.",
      code: "ATLAS_AUTH_REQUIRED",
    },
    { status: 401 },
  );
}
