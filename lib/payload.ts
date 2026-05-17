import { basename } from "node:path";
import { cache, SUMMARY_VERSION } from "./cache";
import {
  listRecentChats,
  readSession,
  deriveProjectFromPaths,
  stripSubject,
  titleCacheKey,
  mapLimit,
  type ChatFile,
  type SessionRead,
} from "./chats";
import { ensureTitle, ensureSummary } from "./haiku";

export type EnrichedChat = ChatFile & {
  _session: SessionRead;
  projectTag: string;
};

export type ChatPayload = {
  id: string;
  project: string;
  projectTag: string;
  cwd: string;
  mtimeMs: number;
  lineCount: number;
  groupKey: string;
  groupTitle: string | null;
  summary: string | null | undefined;
};

// Snapshot of the last `/api/chats` walk so per-card requests don't have to
// re-scan the filesystem. Refreshed every /api/chats.
let lastChats: EnrichedChat[] | null = null;
let lastGroups: Map<string, EnrichedChat[]> | null = null;

export function invalidateSnapshot() {
  lastChats = null;
  lastGroups = null;
}

// Build the response with cached state only. Per-card generation happens via
// `/api/chat/:id` requests fired by the frontend.
export async function buildChatsPayload(): Promise<ChatPayload[]> {
  const candidates = (await listRecentChats(Infinity)) as EnrichedChat[];
  await mapLimit(candidates, 8, async (c) => {
    c._session = await readSession(c.path);
  });
  const chats = candidates.filter((c) => c._session.firstUserMsg);

  for (const c of chats) {
    let tag = deriveProjectFromPaths(c._session.filePaths);
    if (!tag) {
      tag = c.project === "~"
        ? `home-${basename(c.path, ".jsonl").slice(0, 8)}`
        : c.project;
    }
    c.projectTag = tag;
  }

  const groups = new Map<string, EnrichedChat[]>();
  for (const c of chats) {
    const key = c.projectTag || c.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  const out: ChatPayload[] = chats.map((c) => {
    const id = basename(c.path, ".jsonl");
    const groupKey = c.projectTag || c.cwd;
    const members = groups.get(groupKey)!;
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

export async function buildOneChatPayload(id: string) {
  if (!lastChats) await buildChatsPayload();
  const chat = lastChats!.find((c) => basename(c.path, ".jsonl") === id);
  if (!chat) return null;
  const groupKey = chat.projectTag || chat.cwd;
  const members = lastGroups!.get(groupKey) || [chat];
  const title = await ensureTitle(groupKey, members);
  const rawSummary = await ensureSummary(chat, title);
  return { groupKey, title, summary: stripSubject(rawSummary) };
}
