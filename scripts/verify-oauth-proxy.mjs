#!/usr/bin/env node

const argument = process.argv.find((value) => value.startsWith("--base-url="));
const baseUrl = (argument?.slice("--base-url=".length) || process.env.ATLAS_RUNTIME_ORIGIN || "").replace(/\/+$/, "");

if (!baseUrl) {
  console.error("사용법: npm run verify:oauth -- --base-url=https://staging.example.com");
  process.exit(2);
}

const checks = [];
const record = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

try {
  const graph = await fetch(`${baseUrl}/api/graph`, { redirect: "manual" });
  record("public graph read", graph.status === 200, `HTTP ${graph.status}`);

  const unauthenticated = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    body: new FormData(),
    redirect: "manual",
  });
  record(
    "unauthenticated write blocked",
    unauthenticated.status === 401,
    `HTTP ${unauthenticated.status}`,
  );

  const spoofed = await fetch(`${baseUrl}/api/documents`, {
    method: "POST",
    headers: {
      "oai-authenticated-user-id": "spoofed-user",
      "x-openai-user-id": "spoofed-user",
      "cf-access-authenticated-user-email": "spoofed@example.invalid",
    },
    body: new FormData(),
    redirect: "manual",
  });
  record(
    "client identity headers stripped",
    spoofed.status === 401,
    `HTTP ${spoofed.status}; trusted proxy must remove client-supplied identity headers`,
  );
} catch (error) {
  record("staging reachable", false, error instanceof Error ? error.message : String(error));
}

if (checks.some((check) => !check.ok)) process.exit(1);
console.log("\nOAuth proxy boundary verification passed.");
