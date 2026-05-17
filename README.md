# wompwomp

A local visualization of your Claude Code chat history as floating bubbles, grouped by project, with Haiku-generated summaries and titles.

Reads JSONL session files from `~/.claude/projects/` directly — no Claude Code instrumentation needed.

## What it does

- Renders one bubble per chat session (filtered to non-empty sessions)
- Clusters bubbles by the project's `cwd`. Each cluster shares a colour; sessions stack newest-on-top within the cluster
- `~` (home-directory) sessions are treated as individual groups — each gets its own colour and its own title
- Bubble label: a 4-5 word Haiku-generated title for the cluster (cached)
- Bubble body: a one-sentence Haiku-generated summary of the session (cached)
- Click a cluster → drill-down view: vertical list of its sessions
- Click the × button or anywhere in the drill-down to collapse back

## Architecture

Two files, no dependencies:

- **`server.js`** — Node stdlib HTTP server on port `4711`. Walks `~/.claude/projects/**/*.jsonl`, reads each session, generates/caches Haiku summaries + group titles via the Anthropic API, serves `/api/chats` (JSON) and `/` (the static HTML)
- **`index.html`** — Canvas-based UI. Deterministic Halton-distributed cluster seeds + force-based physics settle + position-correction pass for inter-cluster collision avoidance

Summary cache lives at `~/.cache/chat-bubbles/summaries.json`, keyed so resumed sessions only re-summarize when their line count grows.

## Running it

Needs `ANTHROPIC_API_KEY` in the environment for Haiku summaries (falls back to a heuristic — first user message truncated — if unset). Carl uses `tsm` to inject the key from his keychain:

```fish
tsm run --env ANTHROPIC_API_KEY=anthropic-api-key-carl-claude-tashian-com -- node server.js
```

Or plain:

```fish
ANTHROPIC_API_KEY=sk-… node server.js
```

Then open http://localhost:4711.

## Determinism

Layout is deterministic given (set of chats, window size). Cluster seed positions come from `hash32(cwd)` → Halton(idx, 2) for x, Halton(idx, 3) for y. Per-bubble jitter inside a cluster comes from `hash32(chat_id)`. The physics step has no `Math.random()` — only deterministic forces. Adding a new chat slots it into its hash-defined spot without disturbing existing bubbles.

## Caches

- `~/.cache/chat-bubbles/summaries.json` — `{ summaries: { [path]: { lineCount, summary, generatedAt } }, groupTitles: { [groupKey|contentHash]: title } }`
- Group title cache invalidates when the set of member summaries changes
- Summary cache invalidates when a session's line count grows

To force a full regen: `rm ~/.cache/chat-bubbles/summaries.json` and restart the server.

## Notes for future agents

- `index.html` is read once at server startup with `readFileSync`. Frontend changes require a server restart, not just a browser reload.
- The cache file is loaded once at startup; clearing the cache file while the server is running has no effect until restart.
- Bubble layout: `cluster attraction (per-frame velocity) + AABB inter-cluster repulsion + final position-correction pass` (in `correctPositions()`). The position-correction pass is what guarantees no inter-cluster overlap; the force-based step alone tends to leave residual touches.
- The `~` project label corresponds to chats from `/Users/carl` (Claude Code's project dirname encoding turns `/` into `-` then strips the leading `-`). These are deliberately treated as singletons rather than one big cluster.
