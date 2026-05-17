#!/usr/bin/env node
import { createServer } from "node:http";
import { readdir, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const CACHE_PATH = join(homedir(), ".cache", "chat-bubbles", "summaries.json");
const PORT = Number(process.env.PORT) || 4711;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const CONCURRENCY = 4;

let cache = { summaries: {}, groupTitles: {} };
try {
  const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  if (raw.summaries) cache = { groupTitles: {}, ...raw };
  else cache = { summaries: raw, groupTitles: {} }; // migrate flat → nested
} catch {}

async function saveCache() {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Convert project dir name like "-Users-carl-code-tsm" back to a friendly label.
// The dir encoding replaces "/" with "-", so we can't perfectly invert, but the
// last segment is a good label.
function projectLabel(dirName) {
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length === 0) return dirName;
  const last = parts[parts.length - 1];
  // For "-Users-carl" → "~"
  if (parts.length <= 2 && parts[0] === "Users") return "~";
  return last;
}

function cwdPath(dirName) {
  // Best-effort reconstruction: turn "-Users-carl-code-tsm" into "/Users/carl/code/tsm"
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

// Walk a JSONL file, returning a compact transcript snippet and metadata.
async function readSession(path) {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineCount = 0;
  let firstUserMsg = null;
  const snippetParts = [];
  let snippetBudget = 4000;
  for await (const line of rl) {
    lineCount++;
    if (snippetBudget <= 0) continue;
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
        if (c && typeof c === "object" && c.type === "text" && c.text) {
          text += c.text + " ";
        }
      }
      text = text.trim();
    }
    if (!text) continue;
    // Skip slash-command plumbing
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
  };
}

async function generateHaikuSummary(snippet) {
  if (!API_KEY) return null;
  const body = {
    model: HAIKU_MODEL,
    max_tokens: 60,
    messages: [
      {
        role: "user",
        content: `Below is the start of a Claude Code chat session between Carl and Claude. Write a single concise phrase (max 16 words) describing what Carl is working on. Start with a verb in -ing form (e.g., "Building…", "Exploring…", "Designing…"). Do NOT start with a subject like "Carl", "Carl is", "The user", or "He"; the subject is implied. No preamble, no trailing period needed.\n\n<session>\n${snippet}\n</session>`,
      },
    ],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("Haiku error", res.status, t.slice(0, 300));
    return null;
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text?.trim();
  return text || null;
}

function stripSubject(s) {
  if (!s) return s;
  // Match "Carl is", "Carl's", "The user is", "User is", "He is", etc.
  const m = s.match(/^(?:Carl(?:'s)?|The user|User|He)\s+(?:is\s+|has\s+been\s+|wants\s+to\s+)?(.+)$/);
  if (!m) return s;
  const rest = m[1];
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function heuristicSummary(firstUserMsg) {
  if (!firstUserMsg) return "(empty session)";
  return firstUserMsg.replace(/\s+/g, " ").slice(0, 140);
}

async function ensureSummary(chat) {
  const cached = cache.summaries[chat.path];
  if (cached && cached.lineCount === chat._session.lineCount && cached.summary) {
    return cached.summary;
  }
  let summary = await generateHaikuSummary(chat._session.snippet);
  if (!summary) summary = heuristicSummary(chat._session.firstUserMsg);
  cache.summaries[chat.path] = {
    lineCount: chat._session.lineCount,
    summary,
    generatedAt: Date.now(),
  };
  return summary;
}

async function generateGroupTitle(summaries) {
  if (!API_KEY) return null;
  const joined = summaries.map((s, i) => `${i + 1}. ${s}`).join("\n");
  const prompt = summaries.length === 1
    ? `A Claude Code chat session has this summary:\n\n${summaries[0]}\n\nWrite a short 4-5 word title for this session. Title case. No quotes, no preamble.`
    : `These ${summaries.length} Claude Code chat sessions all happened in the same project directory:\n\n${joined}\n\nWrite a short 4-5 word title describing the overall project/topic the sessions share. Title case. No quotes, no preamble.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 40,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const text = data?.content?.[0]?.text?.trim().replace(/^["']|["']$/g, "");
  return text || null;
}

function hashContent(s) {
  // Cheap stable hash for cache keying.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

async function ensureGroupTitle(key, memberSummaries) {
  const contentKey = key + "|" + hashContent(memberSummaries.slice().sort().join(""));
  const cached = cache.groupTitles[contentKey];
  if (cached) return cached;
  const title = await generateGroupTitle(memberSummaries);
  if (title) cache.groupTitles[contentKey] = title;
  return title;
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

async function buildChatsPayload() {
  // No cap — return everything we can find.
  const candidates = await listRecentChats(Infinity);
  await mapLimit(candidates, 8, async (c) => {
    c._session = await readSession(c.path);
  });
  const chats = candidates.filter((c) => c._session.firstUserMsg);
  await mapLimit(chats, CONCURRENCY, async (c) => {
    c.summary = await ensureSummary(c);
  });
  // Group by cluster key (per-id for ~, per-cwd otherwise), then ensure title.
  const chatsOut = chats.map((c) => ({
    id: basename(c.path, ".jsonl"),
    project: c.project,
    cwd: c.cwd,
    mtimeMs: c.mtimeMs,
    lineCount: c._session.lineCount,
    summary: stripSubject(c.summary),
  }));
  const groups = new Map();
  for (const c of chatsOut) {
    const key = c.project === "~" ? `~:${c.id}` : c.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const titlesByKey = {};
  await mapLimit(Array.from(groups.entries()), CONCURRENCY, async ([key, members]) => {
    const title = await ensureGroupTitle(key, members.map((m) => m.summary || ""));
    if (title) titlesByKey[key] = title;
  });
  await saveCache();
  for (const c of chatsOut) {
    const key = c.project === "~" ? `~:${c.id}` : c.cwd;
    c.groupKey = key;
    c.groupTitle = titlesByKey[key] || null;
  }
  return chatsOut;
}

const INDEX_HTML = readFileSync(join(__dirname, "index.html"), "utf8");

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      return;
    }
    if (req.url === "/api/chats") {
      const payload = await buildChatsPayload();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ chats: payload, hasApiKey: Boolean(API_KEY) }));
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
  if (!API_KEY) console.log("(no ANTHROPIC_API_KEY — using heuristic summaries)");
});
