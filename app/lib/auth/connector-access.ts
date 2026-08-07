import { NextResponse } from "next/server";

const CONNECTOR_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,79}$/;
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const rateWindowMs = 60_000;
const rateKey = "__AI_ATLAS_CONNECTOR_RATE_LIMITS__";

type RateEntry = { startedAt: number; count: number };

const rateStore = () => {
  const root = globalThis as typeof globalThis & { [rateKey]?: Map<string, RateEntry> };
  root[rateKey] ??= new Map();
  return root[rateKey];
};

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(bytes);
}

async function secureEqual(left: string, right: string) {
  const [a, b] = await Promise.all([digest(left), digest(right)]);
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

const bearerToken = (request: Request) => {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  return authorization.toLowerCase().startsWith("bearer ")
    ? authorization.slice(7).trim()
    : "";
};

export async function requireAtlasConnectorAccess(
  request: Request,
  options: { limitPerMinute?: number } = {},
): Promise<{ connectorId: string } | { response: NextResponse }> {
  const connectorId = request.headers.get("x-atlas-connector-id")?.trim() ?? "";
  if (!CONNECTOR_ID_PATTERN.test(connectorId)) {
    return {
      response: NextResponse.json(
        { error: "유효한 Connector ID가 필요합니다.", code: "ATLAS_CONNECTOR_ID_REQUIRED" },
        { status: 401 },
      ),
    };
  }

  const configuredToken = process.env.ATLAS_CONNECTOR_TOKEN?.trim();
  const url = new URL(request.url);
  const localDevelopment = process.env.NODE_ENV !== "production" && localHosts.has(url.hostname);
  if (configuredToken) {
    if (!(await secureEqual(bearerToken(request), configuredToken))) {
      return {
        response: NextResponse.json(
          { error: "Connector 인증에 실패했습니다.", code: "ATLAS_CONNECTOR_AUTH_REQUIRED" },
          { status: 401 },
        ),
      };
    }
  } else if (!localDevelopment) {
    return {
      response: NextResponse.json(
        {
          error: "호스팅 환경에는 ATLAS_CONNECTOR_TOKEN 설정이 필요합니다.",
          code: "ATLAS_CONNECTOR_AUTH_NOT_CONFIGURED",
        },
        { status: 503 },
      ),
    };
  }

  const now = Date.now();
  const limit = Math.max(1, options.limitPerMinute ?? 180);
  const store = rateStore();
  // Each API route declares its own rate budget. Keying only by Connector ID
  // made claim, heartbeat, capability, stage and result requests consume one
  // shared counter and could throttle a healthy sequential source sync.
  const rateLimitKey = `${connectorId}:${request.method}:${url.pathname}`;
  const entry = store.get(rateLimitKey);
  if (!entry || now - entry.startedAt >= rateWindowMs) {
    store.set(rateLimitKey, { startedAt: now, count: 1 });
  } else {
    entry.count += 1;
    if (entry.count > limit) {
      return {
        response: NextResponse.json(
          { error: "Connector 요청 한도를 초과했습니다.", code: "ATLAS_CONNECTOR_RATE_LIMITED" },
          { status: 429, headers: { "retry-after": "60" } },
        ),
      };
    }
  }

  return { connectorId };
}
