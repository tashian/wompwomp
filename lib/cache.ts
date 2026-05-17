import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export const CACHE_PATH = join(homedir(), ".cache", "chat-bubbles", "summaries.json");

// Cache schema v2: summaries store the title used at generation time and a
// version marker. v1 entries (no `v` field) are treated as stale and regen'd
// so the title-aware summaries take effect.
export const SUMMARY_VERSION = 2;

export type SummaryEntry = {
  v: number;
  lineCount: number;
  summary: string;
  generationTitle: string | null;
  generatedAt: number;
};

export type CacheShape = {
  summaries: Record<string, SummaryEntry>;
  groupTitles: Record<string, string>;
};

function loadInitial(): CacheShape {
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (raw.summaries) return { groupTitles: {}, ...raw };
    return { summaries: raw, groupTitles: {} };
  } catch {
    return { summaries: {}, groupTitles: {} };
  }
}

// Module-level cache instance. Next.js dev server re-uses this between
// requests within the same process — exactly the behavior we want.
export const cache: CacheShape = loadInitial();

let saveTimeout: ReturnType<typeof setTimeout> | null = null;
async function saveNow() {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}
export function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveNow().catch((e) => console.error("saveCache", e));
  }, 800);
}

export async function clearCache() {
  cache.summaries = {};
  cache.groupTitles = {};
  await saveNow();
}
