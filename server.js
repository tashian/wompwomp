#!/usr/bin/env node
import { createServer } from "node:http";
import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CACHE_PATH = join(homedir(), ".cache", "chat-bubbles", "summaries.json");
const PORT = Number(process.env.PORT) || 4711;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = 4;
// Cache schema v2: summaries store the title used at generation time and a
// version marker. v1 entries (no `v` field) are treated as stale and regen'd
// so the title-aware summaries take effect.
const SUMMARY_VERSION = 2;

let cache = { summaries: {}, groupTitles: {} };
try {
  const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  if (raw.summaries) cache = { groupTitles: {}, ...raw };
  else cache = { summaries: raw, groupTitles: {} };
} catch {}

async function saveCache() {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

let saveTimeout = null;
function scheduleSave() {
  if (saveTimeout) return;
  saveTimeout = setTimeout(() => {
    saveTimeout = null;
    saveCache().catch((e) => console.error("saveCache", e));
  }, 800);
}

// Convert project dir name like "-Users-carl-code-tsm" back to a friendly label.
function projectLabel(dirName) {
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length === 0) return dirName;
  const last = parts[parts.length - 1];
  if (parts.length <= 2 && parts[0] === "Users") return "~";
  return last;
}

function cwdPath(dirName) {
  return "/" + dirName.replace(/^-/, "").replace(/-/g, "/");
}

async function listRecentChats(limit = Infinity) {
  const projectDirs = await readdir(PROJECTS_DIR, { withFileTypes: true });
  const files = [];
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

async function readSession(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  let firstUserMsg = null;
  const snippetParts = [];
  let snippetBudget = 4000;
  const filePaths = new Set();
  for await (const line of rl) {
    lineCount++;
    let d;
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
          for (const key of ["command", "pattern"]) {
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

async function callHaiku(prompt, maxTokens = 60) {
  if (!API_KEY) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("Haiku error", res.status, t.slice(0, 300));
    return null;
  }
  const data = await res.json();
  return data?.content?.[0]?.text?.trim() || null;
}

async function generateTitleFromSnippets(snippets, memberCount) {
  const sampled = snippets.map((s) => (s || "").slice(0, 1200));
  const joined = sampled.map((s, i) => `--- session ${i + 1} ---\n${s}`).join("\n\n");
  const prompt = memberCount === 1
    ? `Below is the start of a Claude Code chat session.\n\n${joined}\n\nWrite a short 4-5 word title for this session. Title Case. No quotes, no preamble, no period.`
    : `Below are excerpts from ${memberCount} Claude Code chat sessions that all happened in the same project directory.\n\n${joined}\n\nWrite a short 4-5 word title describing the overall project or topic the sessions share. Title Case. No quotes, no preamble, no period.`;
  const text = await callHaiku(prompt, 40);
  return text ? text.replace(/^["']|["']$/g, "") : null;
}

async function generateSummaryWithTitle(snippet, title) {
  const titleClause = title ? ` titled "${title}"` : "";
  const avoidanceClause = title
    ? ` Do NOT repeat information already conveyed by the title — focus on additional specifics, decisions, technologies, or context the title doesn't capture.`
    : "";
  const prompt = `Below is the start of a Claude Code chat session${titleClause} between Carl and Claude. Write a single concise phrase (max 16 words) describing what's happening in this session.${avoidanceClause} Start with a verb in -ing form (e.g., "Building…", "Exploring…", "Designing…"). Do NOT start with a subject like "Carl", "Carl is", "The user", or "He"; the subject is implied. No preamble, no trailing period needed.\n\n<session>\n${snippet}\n</session>`;
  return callHaiku(prompt, 60);
}

// Derive a project slug from the file paths touched in a session.
// More reliable than guessing from the session's encoded cwd (which can't
// disambiguate "/" from "-" in path names), and works without API access.
function deriveProjectFromPaths(filePaths) {
  if (!filePaths || filePaths.length === 0) return null;
  const userPaths = filePaths.filter(
    (p) => typeof p === "string" && (p.startsWith("/Users/") || p.startsWith("/home/")),
  );
  if (userPaths.length === 0) return null;
  const splits = userPaths.map((p) => p.split("/").filter(Boolean));
  const minLen = Math.min(...splits.map((s) => s.length));
  const common = [];
  for (let i = 0; i < minLen; i++) {
    const seg = splits[0][i];
    if (splits.every((s) => s[i] === seg)) common.push(seg);
    else break;
  }
  // Strip OS / home / "code" boilerplate at the head.
  const headerSkip = new Set([
    "Users", "home", "carl",
    "code", "src", "Projects", "projects", "Documents", "workspace", "work",
  ]);
  while (common.length && headerSkip.has(common[0])) common.shift();
  // Strip monorepo containers and language-conventional inner dirs so the
  // first 1-2 "real" segments are the project root + sub-project.
  const innerSkip = new Set([
    "packages", "apps", "services", "libs", "tools",
    "src", "lib", "test", "tests", "pkg", "cmd", "internal",
    ".github", "scripts", "node_modules", "dist", "build", "target",
  ]);
  const meaningful = common.filter((s) => !innerSkip.has(s));
  if (meaningful.length === 0) return null;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const a = slug(meaningful[0]);
  const raw1 = meaningful[1];
  const b = raw1 ? slug(raw1) : null;
  if (!b) return a || null;
  // Skip parent prefix when the sub-project name is already specific enough
  // on its own — a domain-style name ("packages.smallstep.com"), or one that
  // already incorporates the parent ("smallstep-cli").
  if (b === a || b.startsWith(a + "-") || raw1.includes(".")) return b;
  return `${a}-${b}` || null;
}

function stripSubject(s) {
  if (!s) return s;
  const m = s.match(/^(?:Carl(?:'s)?|The user|User|He)\s+(?:is\s+|has\s+been\s+|wants\s+to\s+)?(.+)$/);
  if (!m) return s;
  const rest = m[1];
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function heuristicSummary(firstUserMsg) {
  if (!firstUserMsg) return "(empty session)";
  return firstUserMsg.replace(/\s+/g, " ").slice(0, 140);
}

function hashContent(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

function titleCacheKey(groupKey, members) {
  const digest = members
    .map((m) => `${basename(m.path, ".jsonl")}:${m._session.lineCount}`)
    .sort()
    .join("|");
  return `${groupKey}|${hashContent(digest)}`;
}

// In-flight dedup so concurrent /api/chats requests share a single Haiku call.
const titleInFlight = new Map();
const summaryInFlight = new Map();

async function ensureTitleAsync(groupKey, members) {
  const tkey = titleCacheKey(groupKey, members);
  if (cache.groupTitles[tkey]) return cache.groupTitles[tkey];
  if (titleInFlight.has(tkey)) return titleInFlight.get(tkey);
  const p = (async () => {
    try {
      const snippets = members.map((m) => m._session.snippet || "");
      const title = await generateTitleFromSnippets(snippets, members.length);
      if (title) {
        cache.groupTitles[tkey] = title;
        scheduleSave();
      }
      return title;
    } finally {
      titleInFlight.delete(tkey);
    }
  })();
  titleInFlight.set(tkey, p);
  return p;
}

async function ensureSummaryAsync(chat, title) {
  const key = `${chat.path}|${chat._session.lineCount}`;
  if (summaryInFlight.has(key)) return summaryInFlight.get(key);
  const cached = cache.summaries[chat.path];
  if (
    cached &&
    cached.v === SUMMARY_VERSION &&
    cached.lineCount === chat._session.lineCount &&
    cached.summary
  ) {
    return cached.summary;
  }
  const p = (async () => {
    try {
      let summary = await generateSummaryWithTitle(chat._session.snippet, title);
      if (!summary) summary = heuristicSummary(chat._session.firstUserMsg);
      cache.summaries[chat.path] = {
        v: SUMMARY_VERSION,
        lineCount: chat._session.lineCount,
        summary,
        generationTitle: title || null,
        generatedAt: Date.now(),
      };
      scheduleSave();
      return summary;
    } finally {
      summaryInFlight.delete(key);
    }
  })();
  summaryInFlight.set(key, p);
  return p;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
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

// Snapshot of the last `/api/chats` walk so per-card requests don't have to
// re-scan the filesystem. Refreshed every /api/chats.
let lastChats = null;
let lastGroups = null;

// Build the response with cached state only. Per-card generation happens via
// `/api/chat/:id` requests fired by the frontend.
async function buildChatsPayload() {
  const candidates = await listRecentChats(Infinity);
  await mapLimit(candidates, 8, async (c) => {
    c._session = await readSession(c.path);
  });
  const chats = candidates.filter((c) => c._session.firstUserMsg);

  // Derive project tag from session file paths — more accurate than the
  // encoded directory name. Falls back to a per-id home label or the parent
  // dir's project label so every chat still gets a group key.
  for (const c of chats) {
    let tag = deriveProjectFromPaths(c._session.filePaths);
    if (!tag) {
      tag = c.project === "~"
        ? `home-${basename(c.path, ".jsonl").slice(0, 8)}`
        : c.project;
    }
    c.projectTag = tag;
  }

  const groups = new Map();
  for (const c of chats) {
    const key = c.projectTag || c.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  // Initial response: cached state only — no awaits on generation work.
  const out = chats.map((c) => {
    const id = basename(c.path, ".jsonl");
    const groupKey = c.projectTag || c.cwd;
    const members = groups.get(groupKey);
    const tkey = titleCacheKey(groupKey, members);
    const cachedSummary = cache.summaries[c.path];
    const summary =
      cachedSummary &&
      cachedSummary.v === SUMMARY_VERSION &&
      cachedSummary.lineCount === c._session.lineCount
        ? stripSubject(cachedSummary.summary)
        : null;
    return {
      id,
      project: c.project,
      projectTag: c.projectTag,
      cwd: c.cwd,
      mtimeMs: c.mtimeMs,
      lineCount: c._session.lineCount,
      groupKey,
      groupTitle: cache.groupTitles[tkey] || null,
      summary,
    };
  });

  lastChats = chats;
  lastGroups = groups;
  return out;
}

// Handle a per-card generation request: ensure the title for this chat's
// group (cached or generated), then ensure this chat's summary with the
// title in context. Returns { groupKey, title, summary }.
async function buildOneChatPayload(id) {
  if (!lastChats) await buildChatsPayload();
  const chat = lastChats.find((c) => basename(c.path, ".jsonl") === id);
  if (!chat) return null;
  const groupKey = chat.projectTag || chat.cwd;
  const members = lastGroups.get(groupKey) || [chat];
  const title = await ensureTitleAsync(groupKey, members);
  const rawSummary = await ensureSummaryAsync(chat, title);
  return { groupKey, title, summary: stripSubject(rawSummary) };
}

// Pick the terminal app for `claude --resume`. Set TERMINAL_APP=iterm|terminal|
// ghostty to override; otherwise prefer iTerm if installed, else Terminal.
const TERMINAL_APP = (() => {
  const requested = (process.env.TERMINAL_APP || "").trim().toLowerCase();
  if (requested) return requested;
  if (existsSync("/Applications/iTerm.app")) return "iterm";
  if (existsSync("/Applications/Ghostty.app")) return "ghostty";
  return "terminal";
})();

function appleScriptFor(app, shellCmd) {
  // Escape for embedding inside an AppleScript double-quoted string.
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escaped = esc(shellCmd);
  switch (app) {
    case "iterm":
    case "iterm2":
      return [
        'tell application "iTerm"',
        '  create window with default profile',
        '  tell current session of current window',
        `    write text "${escaped}"`,
        '  end tell',
        '  activate',
        'end tell',
      ].join("\n");
    case "ghostty":
      // Ghostty doesn't have rich AppleScript; open a new window and paste via
      // System Events. Fall back to Terminal-style script if user prefers.
      return [
        'tell application "Ghostty" to activate',
        'delay 0.4',
        'tell application "System Events" to keystroke "n" using {command down}',
        'delay 0.5',
        `tell application "System Events" to keystroke "${escaped}"`,
        'tell application "System Events" to key code 36',
      ].join("\n");
    case "terminal":
    default:
      return [
        `tell application "Terminal" to do script "${escaped}"`,
        'tell application "Terminal" to activate',
      ].join("\n");
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const INDEX_PATH = join(__dirname, "index.html");

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url === "/index.html") {
      // Read per request so HTML edits show up without restarting the server.
      const html = await readFile(INDEX_PATH, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.url === "/api/chats") {
      const payload = await buildChatsPayload();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ chats: payload, hasApiKey: Boolean(API_KEY) }));
      return;
    }
    if (req.url.startsWith("/api/chat/") && req.method === "GET") {
      const id = decodeURIComponent(req.url.slice("/api/chat/".length));
      if (!/^[a-zA-Z0-9-]+$/.test(id)) {
        res.writeHead(400); res.end("bad id");
        return;
      }
      const payload = await buildOneChatPayload(id);
      if (!payload) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === "/api/cache/clear" && req.method === "POST") {
      cache = { summaries: {}, groupTitles: {} };
      lastChats = null;
      lastGroups = null;
      titleInFlight.clear();
      summaryInFlight.clear();
      await saveCache();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/resume" && req.method === "POST") {
      const body = await readBody(req);
      const { id, cwd } = JSON.parse(body || "{}");
      if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) {
        res.writeHead(400); res.end("bad id");
        return;
      }
      const safeCwd = typeof cwd === "string" && existsSync(cwd) ? cwd : homedir();
      const shellCmd = `cd ${JSON.stringify(safeCwd)} && claude --resume ${JSON.stringify(id)}`;
      const script = appleScriptFor(TERMINAL_APP, shellCmd);
      spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
      res.writeHead(204); res.end();
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (err) {
    console.error(err);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(err?.stack || err));
  }
});

server.listen(PORT, () => {
  console.log(`chat-bubbles → http://localhost:${PORT}`);
  console.log(`resume target → ${TERMINAL_APP} (override with TERMINAL_APP=iterm|terminal|ghostty)`);
  if (!API_KEY) console.log("(no ANTHROPIC_API_KEY — using heuristic summaries)");
});
