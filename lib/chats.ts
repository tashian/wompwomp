import { readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export type ChatFile = {
  path: string;
  projectDir: string;
  project: string;
  cwd: string;
  mtimeMs: number;
  sizeBytes: number;
};

export type SessionRead = {
  lineCount: number;
  firstUserMsg: string | null;
  snippet: string;
  filePaths: string[];
};

// Convert project dir name like "-Users-carl-code-tsm" back to a friendly label.
function projectLabel(dirName: string): string {
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length === 0) return dirName;
  const last = parts[parts.length - 1];
  if (parts.length <= 2 && parts[0] === "Users") return "~";
  return last;
}

function cwdPath(dirName: string): string {
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/");
}

export async function listRecentChats(limit = Infinity): Promise<ChatFile[]> {
  const projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  const files: ChatFile[] = [];
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dirPath = join(PROJECTS_DIR, d.name);
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const fullPath = join(dirPath, e.name);
      const s = await stat(fullPath);
      files.push({
        path: fullPath,
        projectDir: d.name,
        project: projectLabel(d.name),
        cwd: cwdPath(d.name),
        mtimeMs: s.mtimeMs,
        sizeBytes: s.size,
      });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, limit);
}

export async function readSession(path: string): Promise<SessionRead> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  let firstUserMsg: string | null = null;
  const snippetParts: string[] = [];
  let snippetBudget = 4000;
  const filePaths = new Set<string>();
  for await (const line of rl) {
    lineCount++;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const role = d.type;
    const content = d.message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "text" && c.text) {
          text += c.text + " ";
        } else if (c.type === "tool_use" && c.input && filePaths.size < 60) {
          const fp = c.input.file_path || c.input.path;
          if (typeof fp === "string" && fp.length > 0 && fp.length < 300) {
            filePaths.add(fp);
          }
          // Bash commands & search patterns often reveal subprojects via `cd
          // /Users/.../sub` even when no file is edited — pull paths out of them.
          for (const key of ["command", "pattern"] as const) {
            const v = c.input[key];
            if (typeof v !== "string") continue;
            const matches = v.match(/\/(?:Users|home)\/[A-Za-z0-9._/-]+/g);
            if (!matches) continue;
            for (const m of matches) {
              if (m.length < 300 && filePaths.size < 60) filePaths.add(m);
            }
          }
        }
      }
      text = text.trim();
    }
    if (!text) continue;
    if (snippetBudget <= 0) continue;
    if (
      text.includes("<local-command-caveat>") ||
      text.includes("<local-command-stdout>") ||
      text.startsWith("<command-name>") ||
      text.startsWith("[Request interrupted") ||
      text.startsWith("Base directory for this skill:")
    )
      continue;
    if (role === "user" && !firstUserMsg) firstUserMsg = text.slice(0, 400);
    const label = role === "user" ? "USER" : role === "assistant" ? "ASST" : null;
    if (!label) continue;
    const piece = `${label}: ${text.slice(0, 600)}\n`;
    snippetParts.push(piece);
    snippetBudget -= piece.length;
  }
  return {
    lineCount,
    firstUserMsg,
    snippet: snippetParts.join("").slice(0, 4000),
    filePaths: Array.from(filePaths),
  };
}

// Derive a project slug from the file paths touched in a session. More
// reliable than guessing from the session's encoded cwd (which can't
// disambiguate "/" from "-" in path names), and works without API access.
export function deriveProjectFromPaths(filePaths: string[] | undefined): string | null {
  if (!filePaths || filePaths.length === 0) return null;
  const userPaths = filePaths.filter(
    (p) => typeof p === "string" && (p.startsWith("/Users/") || p.startsWith("/home/")),
  );
  if (userPaths.length === 0) return null;
  const splits = userPaths.map((p) => p.split("/").filter(Boolean));
  const minLen = Math.min(...splits.map((s) => s.length));
  const common: string[] = [];
  for (let i = 0; i < minLen; i++) {
    const seg = splits[0][i];
    if (splits.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  const headerSkip = new Set([
    "Users", "home", "carl",
    "code", "src", "Projects", "projects", "Documents", "workspace", "work",
  ]);
  while (common.length && headerSkip.has(common[0])) common.shift();
  const innerSkip = new Set([
    "packages", "apps", "services", "libs", "tools",
    "src", "lib", "test", "tests", "pkg", "cmd", "internal",
    ".github", "scripts", "node_modules", "dist", "build", "target",
  ]);
  const meaningful = common.filter((s) => !innerSkip.has(s));
  if (meaningful.length === 0) return null;
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const a = slug(meaningful[0]);
  const raw1 = meaningful[1];
  const b = raw1 ? slug(raw1) : null;
  if (!b) return a || null;
  if (b === a || b.startsWith(a + "-") || raw1.includes(".")) return b;
  return `${a}-${b}` || null;
}

export function stripSubject(s: string | null | undefined): string | null | undefined {
  if (!s) return s;
  const m = s.match(/^(?:Carl(?:'s)?|The user|User|He)\s+(?:is\s+|has\s+been\s+|wants\s+to\s+)?(.+)$/);
  if (!m) return s;
  const rest = m[1];
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

export function heuristicSummary(firstUserMsg: string | null): string {
  if (!firstUserMsg) return "(empty session)";
  return firstUserMsg.replace(/\s+/g, " ").slice(0, 140);
}

export function hashContent(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

export function titleCacheKey(
  groupKey: string,
  members: { path: string; _session: { lineCount: number } }[],
): string {
  const digest = members
    .map((m) => `${basename(m.path, ".jsonl")}:${m._session.lineCount}`)
    .sort()
    .join("|");
  return `${groupKey}|${hashContent(digest)}`;
}

export async function mapLimit<T, U>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}
