type TokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
};

type CachedToken = { accessToken: string; expiresAt: number };

let cachedToken: CachedToken | null = null;
let pendingToken: Promise<string> | null = null;

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 환경 변수가 필요합니다.`);
  return value;
};

export function getOAuthLlmConfig() {
  return {
    upstreamBaseUrl: required("LLM_UPSTREAM_BASE_URL").replace(/\/+$/, ""),
    tokenUrl: required("OAUTH_TOKEN_URL"),
    clientId: required("OAUTH_CLIENT_ID"),
    clientSecret: required("OAUTH_CLIENT_SECRET"),
    scope: process.env.OAUTH_SCOPE?.trim(),
    audience: process.env.OAUTH_AUDIENCE?.trim(),
    authMode: process.env.OAUTH_CLIENT_AUTH_MODE?.trim().toLowerCase() === "body" ? "body" : "basic",
    graphPath: process.env.LLM_GRAPH_ENRICHMENT_PATH?.trim() || "responses",
  } as const;
}

async function requestToken() {
  const config = getOAuthLlmConfig();
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (config.scope) body.set("scope", config.scope);
  if (config.audience) body.set("audience", config.audience);

  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  });
  if (config.authMode === "basic") {
    headers.set(
      "authorization",
      `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`,
    );
  } else {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
  }

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(`OAuth 토큰 발급 실패 (${response.status})`);
  }

  const expiresIn = Number(payload.expires_in);
  cachedToken = {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 300) * 1000,
  };
  return cachedToken.accessToken;
}

export async function getOAuthAccessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.accessToken;
  }
  if (!pendingToken) {
    pendingToken = requestToken().finally(() => {
      pendingToken = null;
    });
  }
  return pendingToken;
}
