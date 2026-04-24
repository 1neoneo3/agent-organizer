import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
    if (policy.match(trimmed)) {
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

export function computeFingerprint(
  command: string,
  cwd: string,
): string | null {
  const depFiles = detectDependencyFiles(command);
  if (!depFiles) return null;

  const hash = createHash("sha256");
  hash.update(command);

  for (const file of depFiles) {
    const filePath = join(cwd, file);
    if (existsSync(filePath)) {
      hash.update(readFileSync(filePath));
    } else {
      hash.update(`MISSING:${file}`);
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
