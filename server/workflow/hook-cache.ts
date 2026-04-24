import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";

interface CacheEntry {
  command: string;
  fingerprint: string;
  timestamp: number;
}

export interface HookCachePolicy {
  id: string;
  match: (cmd: string) => boolean;
  files: string[];
}

interface ResolvedPolicyMatch {
  cwd: string;
  policy: HookCachePolicy;
}

function splitShellCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      pushCurrent();
      index += 1;
      continue;
    }

    if (char === ";" || char === "\n") {
      pushCurrent();
      continue;
    }

    current += char;
  }

  pushCurrent();
  return segments;
}

function stripLeadingShellEnv(segment: string): string {
  let normalized = segment.trimStart();

  if (normalized.startsWith("env ")) {
    normalized = normalized.slice(4).trimStart();
  }

  while (true) {
    const next = normalized.replace(
      /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+/,
      "",
    );
    if (next === normalized) {
      return normalized;
    }
    normalized = next.trimStart();
  }
}

function commandMatchesPolicy(
  command: string,
  match: (cmd: string) => boolean,
): boolean {
  for (const segment of splitShellCommandSegments(command)) {
    const normalized = stripLeadingShellEnv(segment);
    if (normalized.length > 0 && match(normalized)) {
      return true;
    }
  }
  return false;
}

function parseCdTarget(segment: string): string | null {
  const match = /^cd\s+(.+)$/.exec(segment.trim());
  if (!match) return null;

  const rawTarget = match[1].trim();
  if (rawTarget.length === 0) return null;

  if (
    (rawTarget.startsWith('"') && rawTarget.endsWith('"')) ||
    (rawTarget.startsWith("'") && rawTarget.endsWith("'"))
  ) {
    return rawTarget.slice(1, -1);
  }

  return rawTarget;
}

const CACHE_POLICIES: ReadonlyArray<HookCachePolicy> = [
  {
    id: "pnpm-install",
    match: (cmd) => /^pnpm\s+(install|i)(\s|$)/.test(cmd),
    files: ["pnpm-lock.yaml", "package.json"],
  },
  {
    id: "npm-install",
    match: (cmd) => /^npm\s+(ci|install|i)(\s|$)/.test(cmd),
    files: ["package-lock.json", "package.json"],
  },
  {
    id: "yarn-install",
    match: (cmd) => /^yarn\s+(install)(\s|$)/.test(cmd),
    files: ["yarn.lock", "package.json"],
  },
  {
    id: "pip-install",
    match: (cmd) => /^pip\s+install(\s|$)/.test(cmd),
    files: ["requirements.txt", "setup.py", "pyproject.toml"],
  },
  {
    id: "poetry-install",
    match: (cmd) => /^poetry\s+install(\s|$)/.test(cmd),
    files: ["poetry.lock", "pyproject.toml"],
  },
  {
    id: "bundle-install",
    match: (cmd) => /^bundle\s+install(\s|$)/.test(cmd),
    files: ["Gemfile.lock", "Gemfile"],
  },
  {
    id: "codegen",
    match: (cmd) =>
      /^(?:pnpm|npm|yarn)\s+(?:run\s+)?codegen(\s|$)/.test(cmd) ||
      /^graphql-codegen(\s|$)/.test(cmd),
    files: [
      "package.json",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
      "codegen.yml",
      "codegen.yaml",
      "codegen.ts",
      "codegen.js",
      "graphql.config.ts",
      "graphql.config.js",
      "schema.graphql",
      "schema.json",
      "openapi.yaml",
      "openapi.yml",
      "openapi.json",
    ],
  },
];

export function detectHookCachePolicy(
  command: string,
): HookCachePolicy | null {
  const trimmed = command.trim();
  for (const policy of CACHE_POLICIES) {
    if (commandMatchesPolicy(trimmed, policy.match)) {
      return {
        id: policy.id,
        match: policy.match,
        files: [...policy.files],
      };
    }
  }
  return null;
}

export function detectDependencyFiles(
  command: string,
): readonly string[] | null {
  return detectHookCachePolicy(command)?.files ?? null;
}

function resolvePolicyMatches(
  command: string,
  cwd: string,
): ResolvedPolicyMatch[] {
  const policy = detectHookCachePolicy(command);
  if (!policy) return [];

  const matches: ResolvedPolicyMatch[] = [];
  let currentCwd = cwd;

  // Track `cd <subdir> && ...` so cache keys follow the directory that the hook
  // actually mutates, rather than always reading dependency files at the root.
  for (const segment of splitShellCommandSegments(command)) {
    const normalized = stripLeadingShellEnv(segment);
    if (normalized.length === 0) continue;

    const cdTarget = parseCdTarget(normalized);
    if (cdTarget) {
      currentCwd = resolve(currentCwd, cdTarget);
      continue;
    }

    if (policy.match(normalized)) {
      matches.push({ cwd: currentCwd, policy });
    }
  }

  if (matches.length === 0) {
    matches.push({ cwd, policy });
  }

  return matches;
}

export function computeFingerprint(
  command: string,
  cwd: string,
): string | null {
  const matches = resolvePolicyMatches(command, cwd);
  if (matches.length === 0) return null;

  const hash = createHash("sha256");
  hash.update(command);

  for (const match of matches) {
    const baseDir = relative(cwd, match.cwd) || ".";
    hash.update(`CWD:${baseDir}`);

    for (const file of match.policy.files) {
      const filePath = join(match.cwd, file);
      const fileKey = `${baseDir}/${file}`;
      if (existsSync(filePath)) {
        hash.update(fileKey);
        hash.update(readFileSync(filePath));
      } else {
        hash.update(`MISSING:${fileKey}`);
      }
    }
  }

  return hash.digest("hex");
}

function cacheKeyFor(command: string, cwd: string): string {
  return createHash("sha256")
    .update(`${command}:${cwd}`)
    .digest("hex");
}

function readCacheEntry(
  cacheDir: string,
  key: string,
): CacheEntry | null {
  const filePath = join(cacheDir, `${key}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

export function shouldSkipHook(
  command: string,
  cwd: string,
  cacheDir: string,
): boolean {
  const fingerprint = computeFingerprint(command, cwd);
  if (!fingerprint) return false;

  const key = cacheKeyFor(command, cwd);
  const entry = readCacheEntry(cacheDir, key);
  if (!entry) return false;

  return entry.fingerprint === fingerprint;
}

export function recordHookSuccess(
  command: string,
  cwd: string,
  cacheDir: string,
): void {
  const fingerprint = computeFingerprint(command, cwd);
  if (!fingerprint) return;

  mkdirSync(cacheDir, { recursive: true });

  const key = cacheKeyFor(command, cwd);
  const entry: CacheEntry = {
    command,
    fingerprint,
    timestamp: Date.now(),
  };

  writeFileSync(
    join(cacheDir, `${key}.json`),
    JSON.stringify(entry),
    "utf-8",
  );
}

export function invalidateHookCache(cacheDir: string): void {
  if (!existsSync(cacheDir)) return;

  for (const file of readdirSync(cacheDir)) {
    if (file.endsWith(".json")) {
      rmSync(join(cacheDir, file), { force: true });
    }
  }
}
