import { cache, scheduleSave, SUMMARY_VERSION } from "./cache";
import { titleCacheKey, heuristicSummary, type SessionRead } from "./chats";
import { basename } from "node:path";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

function apiKey() {
  return process.env.ANTHROPIC_API_KEY;
}
export function hasApiKey() {
  return Boolean(apiKey());
}

async function callHaiku(prompt: string, maxTokens = 60): Promise<string | null> {
  const key = apiKey();
  if (!key) return null;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
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

async function generateTitleFromSnippets(snippets: string[], memberCount: number) {
  const sampled = snippets.map((s) => (s || "").slice(0, 1200));
  const joined = sampled.map((s, i) => `--- session ${i + 1} ---\n${s}`).join("\n\n");
  const prompt = memberCount === 1
    ? `Below is the start of a Claude Code chat session.\n\n${joined}\n\nWrite a short 4-5 word title for this session. Title Case. No quotes, no preamble, no period.`
    : `Below are excerpts from ${memberCount} Claude Code chat sessions that all happened in the same project directory.\n\n${joined}\n\nWrite a short 4-5 word title describing the overall project or topic the sessions share. Title Case. No quotes, no preamble, no period.`;
  const text = await callHaiku(prompt, 40);
  return text ? text.replace(/^["']|["']$/g, "") : null;
}

async function generateSummaryWithTitle(snippet: string, title: string | null) {
  const titleClause = title ? ` titled "${title}"` : "";
  const avoidanceClause = title
    ? ` Do NOT repeat information already conveyed by the title — focus on additional specifics, decisions, technologies, or context the title doesn't capture.`
    : "";
  const prompt = `Below is the start of a Claude Code chat session${titleClause} between Carl and Claude. Write a single concise phrase (max 16 words) describing what's happening in this session.${avoidanceClause} Start with a verb in -ing form (e.g., "Building…", "Exploring…", "Designing…"). Do NOT start with a subject like "Carl", "Carl is", "The user", or "He"; the subject is implied. No preamble, no trailing period needed.\n\n<session>\n${snippet}\n</session>`;
  return callHaiku(prompt, 60);
}

// In-flight dedup so concurrent requests share a single Haiku call.
const titleInFlight = new Map<string, Promise<string | null>>();
const summaryInFlight = new Map<string, Promise<string>>();

export async function ensureTitle(
  groupKey: string,
  members: { path: string; _session: SessionRead }[],
): Promise<string | null> {
  const tkey = titleCacheKey(groupKey, members);
  if (cache.groupTitles[tkey]) return cache.groupTitles[tkey];
  if (titleInFlight.has(tkey)) return titleInFlight.get(tkey)!;
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

export async function ensureSummary(
  chat: { path: string; _session: SessionRead },
  title: string | null,
): Promise<string> {
  const key = `${chat.path}|${chat._session.lineCount}`;
  if (summaryInFlight.has(key)) return summaryInFlight.get(key)!;
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

export function clearInFlight() {
  titleInFlight.clear();
  summaryInFlight.clear();
}
