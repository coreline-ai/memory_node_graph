import aliasCatalog from "./entity-aliases.json" with { type: "json" };

type AliasCatalogEntry = {
  canonicalId: string;
  type: string;
  label: string;
  aliases: string[];
  caseSensitive: boolean;
};

const ecosystemEntries: AliasCatalogEntry[] = [
  { canonicalId: "technology:typescript", type: "technology", label: "TypeScript", aliases: ["typescript"], caseSensitive: false },
  { canonicalId: "technology:javascript", type: "technology", label: "JavaScript", aliases: ["javascript"], caseSensitive: false },
  { canonicalId: "technology:node-js", type: "technology", label: "Node.js", aliases: ["node.js", "nodejs"], caseSensitive: false },
  { canonicalId: "technology:react", type: "technology", label: "React", aliases: ["react", "react.js", "reactjs"], caseSensitive: false },
  { canonicalId: "technology:next-js", type: "technology", label: "Next.js", aliases: ["next.js", "nextjs"], caseSensitive: false },
  { canonicalId: "technology:vinext", type: "technology", label: "Vinext", aliases: ["vinext"], caseSensitive: false },
  { canonicalId: "technology:vite", type: "technology", label: "Vite", aliases: ["vite"], caseSensitive: false },
  { canonicalId: "technology:d3-force-3d", type: "technology", label: "d3-force-3d", aliases: ["d3-force-3d"], caseSensitive: false },
  { canonicalId: "technology:tailwind-css", type: "technology", label: "Tailwind CSS", aliases: ["tailwind css", "tailwindcss"], caseSensitive: false },
  { canonicalId: "technology:cloudflare", type: "technology", label: "Cloudflare", aliases: ["cloudflare"], caseSensitive: false },
  { canonicalId: "technology:sqlite", type: "storage", label: "SQLite", aliases: ["sqlite"], caseSensitive: false },
  { canonicalId: "technology:drizzle-orm", type: "technology", label: "Drizzle ORM", aliases: ["drizzle orm", "drizzle"], caseSensitive: false },
  { canonicalId: "technology:postgresql", type: "storage", label: "PostgreSQL", aliases: ["postgresql", "postgres"], caseSensitive: false },
  { canonicalId: "technology:python", type: "technology", label: "Python", aliases: ["python"], caseSensitive: false },
  { canonicalId: "technology:fastapi", type: "technology", label: "FastAPI", aliases: ["fastapi"], caseSensitive: false },
  { canonicalId: "technology:redis", type: "storage", label: "Redis", aliases: ["redis"], caseSensitive: false },
  { canonicalId: "technology:docker", type: "technology", label: "Docker", aliases: ["docker", "docker-compose"], caseSensitive: false },
  { canonicalId: "technology:rust", type: "technology", label: "Rust", aliases: ["rust"], caseSensitive: false },
  { canonicalId: "technology:github-actions", type: "technology", label: "GitHub Actions", aliases: ["github actions"], caseSensitive: false },
  { canonicalId: "technology:openai-codex", type: "technology", label: "OpenAI Codex", aliases: ["openai codex"], caseSensitive: false },
];

const confirmedEntries = aliasCatalog.canonicalEntities as AliasCatalogEntry[];
const entries = [...confirmedEntries, ...ecosystemEntries]
  .filter((entry, index, values) => values.findIndex((candidate) => candidate.canonicalId === entry.canonicalId) === index);

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type ResolvedEntityAlias = {
  canonicalId: string;
  type: string;
  label: string;
  matchedAlias: string;
};

export function resolveEntityAlias(value: string): ResolvedEntityAlias | null {
  const normalized = normalize(value);
  for (const entry of entries) {
    for (const alias of [entry.label, ...entry.aliases]) {
      const matches = entry.caseSensitive
        ? normalized === normalize(alias)
        : normalized.toLocaleLowerCase("en-US") === normalize(alias).toLocaleLowerCase("en-US");
      if (matches) return {
        canonicalId: entry.canonicalId,
        type: entry.type,
        label: entry.label,
        matchedAlias: alias,
      };
    }
  }
  return null;
}

export function entityAliasesIn(value: string): ResolvedEntityAlias[] {
  const normalized = normalize(value.replace(/[`*_()[\]{}]/g, " "));
  const found = new Map<string, ResolvedEntityAlias>();
  for (const entry of entries) {
    const aliases = [entry.label, ...entry.aliases]
      .sort((left, right) => right.length - left.length || left.localeCompare(right));
    for (const alias of aliases) {
      const flags = entry.caseSensitive && alias !== entry.label ? "u" : "iu";
      const pattern = new RegExp(
        `(^|[^\\p{L}\\p{N}])${escaped(normalize(alias))}(?=$|[^\\p{L}\\p{N}]|[은는이가을를에와과의](?:$|[^\\p{L}\\p{N}]))`,
        flags,
      );
      if (!pattern.test(normalized)) continue;
      found.set(entry.canonicalId, {
        canonicalId: entry.canonicalId,
        type: entry.type,
        label: entry.label,
        matchedAlias: alias,
      });
      break;
    }
  }
  if (found.has("technology:cloudflare-d1")) found.delete("technology:cloudflare");
  return [...found.values()].sort((left, right) =>
    left.label.localeCompare(right.label) || left.canonicalId.localeCompare(right.canonicalId));
}

export function canonicalEntityId(type: string, label: string, repositoryId?: string) {
  const alias = resolveEntityAlias(label);
  if (alias && (alias.type === type || type === "technology")) return alias.canonicalId;
  const key = normalize(label).toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  const localTypes = new Set(["api", "file", "storage", "phase", "task", "component"]);
  return localTypes.has(type) && repositoryId
    ? `${type}:github:${repositoryId}:${key}`
    : `${type}:${key}`;
}

export const entityAliasCatalogVersion = aliasCatalog.version;
