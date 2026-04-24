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

const INSTALL_PATTERNS: ReadonlyArray<{
  match: (cmd: string) => boolean;
  files: readonly string[];
}> = [
  {
    match: (cmd) => /^pnpm\s+(install|i)(\s|$)/.test(cmd),
    files: ["pnpm-lock.yaml", "package.json"],
  },
  {
    match: (cmd) => /^npm\s+(ci|install|i)(\s|$)/.test(cmd),
    files: ["package-lock.json", "package.json"],
  },
  {
    match: (cmd) => /^yarn\s+(install)(\s|$)/.test(cmd),
    files: ["yarn.lock", "package.json"],
  },
  {
    match: (cmd) => /^pip\s+install(\s|$)/.test(cmd),
    files: ["requirements.txt", "setup.py", "pyproject.toml"],
  },
  {
    match: (cmd) => /^poetry\s+install(\s|$)/.test(cmd),
    files: ["poetry.lock", "pyproject.toml"],
  },
  {
    match: (cmd) => /^bundle\s+install(\s|$)/.test(cmd),
    files: ["Gemfile.lock", "Gemfile"],
  },
];

export function detectDependencyFiles(command: string): string[] | null {
  const trimmed = command.trim();
  for (const pattern of INSTALL_PATTERNS) {
    if (pattern.match(trimmed)) {
      return [...pattern.files];
    }
  }
  return null;
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
