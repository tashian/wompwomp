"use client";

import { useEffect, useRef } from "react";

// The entire canvas + physics + hydrate pipeline lives in one client
// component. Logic is imperative and lives inside a single mount effect —
// React's role is just to mount the DOM nodes and forward refs.
export default function ChatBubbles() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const metaRef = useRef<HTMLSpanElement | null>(null);
  const refreshBtnRef = useRef<HTMLButtonElement | null>(null);
  const clearCacheBtnRef = useRef<HTMLButtonElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const meta = metaRef.current!;
    const header = headerRef.current!;
    const refreshBtn = refreshBtnRef.current!;
    const clearCacheBtn = clearCacheBtnRef.current!;
    const closeBtn = closeBtnRef.current!;

    // Curated herbarium palette: 8 muted inks. Cluster key → one entry.
    const PALETTE = [
      { name: "moss",    ink: "#5a6b3a" },
      { name: "terra",   ink: "#a85436" },
      { name: "indigo",  ink: "#3a4a73" },
      { name: "ochre",   ink: "#8e6420" },
      { name: "oxblood", ink: "#7a3034" },
      { name: "plum",    ink: "#6b3e5e" },
      { name: "slate",   ink: "#3f4a55" },
      { name: "sage",    ink: "#5e6e4e" },
    ];
    const PAPER_CARD = "#f1e8d2";
    const INK = "#1f1b15";
    const INK_MUTE = "#5b5444";
    const INK_FAINT = "#8a8270";

    type Bubble = {
      id: string;
      project: string;
      projectTag: string;
      cwd: string;
      groupTitle: string | null;
      summary: string | null;
      mtimeMs: number;
      lineCount: number;
      w: number; h: number; r: number;
      pal: { name: string; ink: string };
      x: number; y: number;
      vx: number; vy: number;
      alpha: number;
      targetX?: number; targetY?: number;
      targetW?: number; targetH?: number; targetR?: number;
      targetAlpha?: number;
    };
    type ChatData = {
      id: string;
      project: string;
      projectTag: string;
      cwd: string;
      mtimeMs: number;
      lineCount: number;
      groupKey: string;
      groupTitle: string | null;
      summary: string | null;
    };

    let bubbles: Bubble[] = [];
    let dpr = window.devicePixelRatio || 1;
    let W = 0, H = 0;
    let expandedKey: string | null = null;
    let savedOverview: Map<string, { x: number; y: number; w: number; h: number; r: number }> | null = null;
    let lastMeta = "";
    let expandedLayout: any = null;
    let expandedScrollOffset = 0;
    let expandedScrollMax = 0;
    let hoveredId: string | null = null;
    let fontsReady = false;

    function resize() {
      dpr = window.devicePixelRatio || 1;
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const b of bubbles) {
        b.x = Math.max(b.r, Math.min(W - b.r, b.x));
        b.y = Math.max(b.r + 50, Math.min(H - b.r - 20, b.y));
      }
    }
    const onResize = () => { resize(); draw(); };
    window.addEventListener("resize", onResize);

    function hash32(s: string) {
      let h = 2166136261 >>> 0;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h;
    }
    function rand01(seed: string) { return hash32(seed) / 0x100000000; }
    function halton(i: number, base: number) {
      let f = 1, r = 0;
      while (i > 0) {
        f /= base;
        r += f * (i % base);
        i = Math.floor(i / base);
      }
      return r;
    }
    function paletteFor(s: string) { return PALETTE[hash32(s) % PALETTE.length]; }
    function desaturateHex(hex: string, amt: number) {
      const h = hex.replace("#", "");
      const r = parseInt(h.slice(0, 2), 16);
      const g = parseInt(h.slice(2, 4), 16);
      const b = parseInt(h.slice(4, 6), 16);
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mix = (c: number) => Math.round(c + (y - c) * amt);
      const to = (v: number) => Math.max(0, Math.min(255, mix(v))).toString(16).padStart(2, "0");
      return "#" + to(r) + to(g) + to(b);
    }
    function mixHex(a: string, b: string, t: number) {
      const ch = (s: string, i: number) => parseInt(s.replace("#", "").slice(i, i + 2), 16);
      const m = (x: number, y: number) => Math.round(x + (y - x) * t);
      const to = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
      return "#"
        + to(m(ch(a, 0), ch(b, 0)))
        + to(m(ch(a, 2), ch(b, 2)))
        + to(m(ch(a, 4), ch(b, 4)));
    }
    function specimenNumberFor(id: string) {
      return String((hash32(id) % 999) + 1).padStart(3, "0");
    }
    function relTime(ms: number) {
      const d = (Date.now() - ms) / 1000;
      if (d < 60) return `${Math.floor(d)}s`;
      if (d < 3600) return `${Math.floor(d / 60)}m`;
      if (d < 86400) return `${Math.floor(d / 3600)}h`;
      const days = Math.floor(d / 86400);
      if (days < 14) return `${days}d`;
      return new Date(ms).toLocaleDateString();
    }
    function groupKey(b: Bubble) { return b.projectTag || b.cwd; }

    function buildBubbles(chats: ChatData[]) {
      const prev = new Map(bubbles.map((b) => [b.id, b]));
      const baseArea = 250 * 130;
      const budget = W * H * 0.55;
      const scale = Math.max(
        0.62,
        Math.min(1, Math.sqrt(budget / Math.max(1, chats.length) / baseArea)),
      );
      const seeds: Record<string, { x: number; y: number }> = {};
      const seedKey = (c: ChatData) => c.projectTag || c.cwd;
      const xMargin = 180, yTop = 90, yBottom = 80;
      const xRange = Math.max(100, W - xMargin * 2);
      const yRange = Math.max(100, H - yTop - yBottom);
      for (const c of chats) {
        if (prev.has(c.id)) continue;
        const k = seedKey(c);
        if (!seeds[k]) {
          const idx = (hash32(k) % 1024) + 1;
          seeds[k] = {
            x: xMargin + halton(idx, 2) * xRange,
            y: yTop + halton(idx, 3) * yRange,
          };
        }
      }
      const next: Bubble[] = chats.map((c) => {
        const w = (240 + Math.min(40, Math.log2((c.lineCount || 1) + 1) * 3)) * scale;
        const h = (118 + Math.min(60, Math.log2((c.lineCount || 1) + 1) * 6)) * scale;
        const r = (w + h) / 4;
        const existing = prev.get(c.id);
        const pal = paletteFor(seedKey(c));
        if (existing) {
          return Object.assign(existing, {
            project: c.project, projectTag: c.projectTag, cwd: c.cwd,
            summary: c.summary, groupTitle: c.groupTitle,
            mtimeMs: c.mtimeMs, lineCount: c.lineCount, w, h, r, pal,
          });
        }
        const seed = seeds[seedKey(c)];
        const jx = (rand01(`jitter-x:${c.id}`) - 0.5) * 30;
        const jy = (rand01(`jitter-y:${c.id}`) - 0.5) * 30;
        return {
          id: c.id,
          project: c.project,
          projectTag: c.projectTag,
          cwd: c.cwd,
          groupTitle: c.groupTitle,
          summary: c.summary,
          mtimeMs: c.mtimeMs,
          lineCount: c.lineCount,
          w, h, r, pal,
          x: seed.x + jx,
          y: seed.y + jy,
          vx: 0, vy: 0,
          alpha: 1,
        } satisfies Bubble;
      });
      next.sort((a, b) => a.mtimeMs - b.mtimeMs);
      bubbles = next;
    }

    function step() {
      const groups: Record<string, { x: number; y: number; n: number }> = {};
      for (const b of bubbles) {
        const k = groupKey(b);
        let g = groups[k];
        if (!g) g = groups[k] = { x: 0, y: 0, n: 0 };
        g.x += b.x; g.y += b.y; g.n++;
      }
      for (const k in groups) {
        groups[k].x /= groups[k].n;
        groups[k].y /= groups[k].n;
      }

      for (let i = 0; i < bubbles.length; i++) {
        const a = bubbles[i];
        const g = groups[groupKey(a)];
        if (g.n >= 2) {
          const dx = g.x - a.x, dy = g.y - a.y;
          const d = Math.hypot(dx, dy);
          if (d > 0.5) {
            const f = Math.min(0.25, d * 0.006);
            a.vx += (dx / d) * f;
            a.vy += (dy / d) * f;
          }
        }
        const aKey = groupKey(a);
        const PAD = 16;
        for (let j = i + 1; j < bubbles.length; j++) {
          const b = bubbles[j];
          const same = groupKey(b) === aKey;
          const dx = b.x - a.x, dy = b.y - a.y;
          if (same) {
            const min = Math.min(a.r, b.r) * 0.4;
            const d2 = dx * dx + dy * dy;
            if (d2 < min * min && d2 > 0.001) {
              const d = Math.sqrt(d2);
              const overlap = (min - d) / min;
              const fx = (dx / d) * overlap * 0.15;
              const fy = (dy / d) * overlap * 0.15;
              a.vx -= fx; a.vy -= fy;
              b.vx += fx; b.vy += fy;
            }
          } else {
            const overlapX = (a.w + b.w) / 2 + PAD - Math.abs(dx);
            const overlapY = (a.h + b.h) / 2 + PAD - Math.abs(dy);
            if (overlapX > 0 && overlapY > 0) {
              const strength = 0.55;
              if (overlapX < overlapY) {
                const f = (dx >= 0 ? 1 : -1) * overlapX * strength * 0.5;
                a.vx -= f; b.vx += f;
              } else {
                const f = (dy >= 0 ? 1 : -1) * overlapY * strength * 0.5;
                a.vy -= f; b.vy += f;
              }
            }
          }
        }
      }
      for (const a of bubbles) {
        a.vx *= 0.985; a.vy *= 0.985;
        const sp = Math.hypot(a.vx, a.vy);
        const cap = 1.4;
        if (sp > cap) { a.vx = (a.vx / sp) * cap; a.vy = (a.vy / sp) * cap; }
        a.x += a.vx; a.y += a.vy;
        const topMargin = 60, bottomMargin = 30, sideMargin = 10;
        if (a.x - a.r < sideMargin) { a.x = a.r + sideMargin; a.vx = Math.abs(a.vx) * 0.8; }
        if (a.x + a.r > W - sideMargin) { a.x = W - a.r - sideMargin; a.vx = -Math.abs(a.vx) * 0.8; }
        if (a.y - a.r < topMargin) { a.y = a.r + topMargin; a.vy = Math.abs(a.vy) * 0.8; }
        if (a.y + a.r > H - bottomMargin) { a.y = H - a.r - bottomMargin; a.vy = -Math.abs(a.vy) * 0.8; }
      }
    }

    function setLetterSpacing(v: string) {
      try { (ctx as any).letterSpacing = v; } catch { /* noop */ }
    }

    function draw() {
      ctx.clearRect(0, 0, W, H);
      const pad = 14;
      const cornerR = 4;
      const list = visibleBubbles().slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
      const now = Date.now();
      const FADE_DAYS = 21;
      const groupNewest = new Map<string, number>();
      for (const b of bubbles) {
        const k = groupKey(b);
        const cur = groupNewest.get(k) ?? 0;
        if (b.mtimeMs > cur) groupNewest.set(k, b.mtimeMs);
      }
      const groupInk = new Map<string, string>();
      for (const [k, newest] of groupNewest) {
        const ageDays = (now - newest) / 86400000;
        const groupSat = Math.min(1, Math.sqrt(Math.max(0, ageDays) / FADE_DAYS));
        const member = bubbles.find((b) => groupKey(b) === k);
        if (!member) continue;
        groupInk.set(k, desaturateHex(member.pal.ink, groupSat * 0.85));
      }

      for (const b of list) {
        ctx.globalAlpha = b.alpha ?? 1;
        const ageDays = (now - b.mtimeMs) / 86400000;
        const fade = Math.min(1, Math.sqrt(Math.max(0, ageDays) / FADE_DAYS));
        const x = b.x - b.w / 2;
        const y = b.y - b.h / 2;
        const hovered = hoveredId === b.id && !expandedKey;
        const ink = groupInk.get(groupKey(b)) || b.pal.ink;

        ctx.shadowColor = "rgba(40, 28, 10, 0.18)";
        ctx.shadowBlur = hovered ? 14 : 8;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = hovered ? 4 : 2;

        ctx.beginPath();
        ctx.roundRect(x, y, b.w, b.h, cornerR);
        ctx.fillStyle = mixHex(PAPER_CARD, ink, 0.22);
        ctx.fill();

        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;

        ctx.beginPath();
        ctx.roundRect(x + 0.5, y + 0.5, b.w - 1, b.h - 1, cornerR);
        ctx.lineWidth = hovered ? 1.6 : 1;
        ctx.strokeStyle = ink;
        ctx.globalAlpha = (b.alpha ?? 1) * (hovered ? 0.95 : 0.7) * (1 - fade * 0.55);
        ctx.stroke();
        ctx.globalAlpha = b.alpha ?? 1;

        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        const innerW = b.w - pad * 2;

        let cy = y + pad;
        ctx.font = "400 13px var(--font-fraunces), Georgia, serif";
        ctx.fillStyle = INK;
        const footerH = 16;
        const summaryArea = b.h - (cy - y) - pad - footerH;
        const lineH = 16;
        const maxLines = Math.max(1, Math.floor(summaryArea / lineH));
        const lines = wrapLines(b.summary || "", innerW, maxLines, false);
        for (let i = 0; i < lines.length; i++) {
          ctx.fillText(lines[i], x + pad, cy + i * lineH);
        }

        ctx.font = "500 9px var(--font-mono), ui-monospace, monospace";
        setLetterSpacing("0.14em");
        ctx.fillStyle = INK_FAINT;
        const footerY = y + b.h - pad - 8;
        const num = specimenNumberFor(b.id);
        const t = relTime(b.mtimeMs).toUpperCase();
        ctx.fillText(`№ ${num} · ${b.lineCount} MSG · ${t}`, x + pad, footerY);
        setLetterSpacing("0px");

        if (expandedKey) {
          const btn = resumeBtnRect(b);
          ctx.fillStyle = "rgba(255, 248, 230, 0.5)";
          ctx.strokeStyle = "rgba(42, 36, 26, 0.45)";
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 2);
          ctx.fill();
          ctx.stroke();
          ctx.font = "500 9px var(--font-mono), ui-monospace, monospace";
          setLetterSpacing("0.14em");
          ctx.fillStyle = INK_MUTE;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("↻ RESUME", btn.x + btn.w / 2, btn.y + btn.h / 2 + 1);
          ctx.textAlign = "left";
          ctx.textBaseline = "top";
          setLetterSpacing("0px");
        }
      }

      // One title per cluster, above the cluster's topmost bubble.
      if (!expandedKey) {
        type GB = { minX: number; maxX: number; minY: number; title: string | null; alphaSum: number; count: number };
        const groupBounds = new Map<string, GB>();
        for (const b of bubbles) {
          if ((b.alpha ?? 1) <= 0.01) continue;
          const k = groupKey(b);
          const top = b.y - b.h / 2;
          const left = b.x - b.w / 2;
          const right = b.x + b.w / 2;
          let g = groupBounds.get(k);
          if (!g) {
            g = { minX: left, maxX: right, minY: top, title: b.groupTitle, alphaSum: 0, count: 0 };
            groupBounds.set(k, g);
          }
          if (left < g.minX) g.minX = left;
          if (right > g.maxX) g.maxX = right;
          if (top < g.minY) g.minY = top;
          if (b.groupTitle && !g.title) g.title = b.groupTitle;
          g.alphaSum += b.alpha ?? 1;
          g.count++;
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        for (const [k, g] of groupBounds) {
          const title = g.title;
          if (!title) continue;
          const ink = groupInk.get(k) || INK;
          const cx = (g.minX + g.maxX) / 2;
          const cy = g.minY - 10;
          ctx.globalAlpha = (g.alphaSum / Math.max(1, g.count)) * 0.95;
          ctx.font = "600 16px var(--font-inter-tight), system-ui, sans-serif";
          setLetterSpacing("-0.005em");
          ctx.fillStyle = ink;
          ctx.fillText(title, cx, cy);
          setLetterSpacing("0px");
        }
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
      }

      ctx.globalAlpha = 1;
    }

    function resumeBtnRect(b: Bubble) {
      const w = 84, h = 20, pad = 10;
      return {
        x: b.x + b.w / 2 - pad - w,
        y: b.y + b.h / 2 - pad - h,
        w, h,
      };
    }
    function hitResumeBtn(px: number, py: number, b: Bubble) {
      const r = resumeBtnRect(b);
      return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
    }

    function wrapLines(text: string, maxWidth: number, maxLines: number, noEllipsis: boolean) {
      if (!text) return [];
      const words = String(text).split(/\s+/).filter(Boolean);
      const lines: string[] = [];
      let cur = "";
      for (const w of words) {
        const probe = cur ? cur + " " + w : w;
        if (ctx.measureText(probe).width <= maxWidth) {
          cur = probe;
        } else {
          if (cur) lines.push(cur);
          if (lines.length >= maxLines) break;
          if (ctx.measureText(w).width > maxWidth) {
            let chunk = w;
            while (chunk.length > 1 && ctx.measureText(chunk + "…").width > maxWidth) {
              chunk = chunk.slice(0, -1);
            }
            lines.push(chunk + "…");
            cur = "";
          } else {
            cur = w;
          }
        }
      }
      if (cur && lines.length < maxLines) lines.push(cur);
      if (lines.length > maxLines) lines.length = maxLines;
      const usedAll = lines.length === maxLines &&
        words.join(" ").length > lines.join(" ").length;
      if (usedAll && !noEllipsis) {
        let last = lines[maxLines - 1];
        while (last.length > 0 && ctx.measureText(last + "…").width > maxWidth) {
          last = last.slice(0, -1);
        }
        lines[maxLines - 1] = last.replace(/[\s,]+$/, "") + "…";
      }
      return lines;
    }

    function correctPositions(maxPasses = 40) {
      const PAD = 12;
      for (let pass = 0; pass < maxPasses; pass++) {
        let moved = 0;
        for (let i = 0; i < bubbles.length; i++) {
          const a = bubbles[i];
          const aKey = groupKey(a);
          for (let j = i + 1; j < bubbles.length; j++) {
            const b = bubbles[j];
            if (groupKey(b) === aKey) continue;
            const dx = b.x - a.x, dy = b.y - a.y;
            const overlapX = (a.w + b.w) / 2 + PAD - Math.abs(dx);
            const overlapY = (a.h + b.h) / 2 + PAD - Math.abs(dy);
            if (overlapX > 0 && overlapY > 0) {
              if (overlapX < overlapY) {
                const push = overlapX / 2 + 0.5;
                const sgn = dx >= 0 ? 1 : -1;
                a.x -= push * sgn; b.x += push * sgn;
              } else {
                const push = overlapY / 2 + 0.5;
                const sgn = dy >= 0 ? 1 : -1;
                a.y -= push * sgn; b.y += push * sgn;
              }
              moved++;
            }
          }
        }
        for (const b of bubbles) {
          const margin = 60;
          b.x = Math.max(b.w / 2 + 8, Math.min(W - b.w / 2 - 8, b.x));
          b.y = Math.max(b.h / 2 + margin, Math.min(H - b.h / 2 - 20, b.y));
        }
        if (moved === 0) break;
      }
    }

    function settle(iterations = 600) {
      for (let i = 0; i < iterations; i++) step();
      correctPositions();
      for (const b of bubbles) { b.vx = 0; b.vy = 0; }
    }

    function clusterMembers(key: string) {
      return bubbles.filter((b) => groupKey(b) === key);
    }
    function visibleBubbles() {
      return bubbles.filter((b) => (b.alpha ?? 1) > 0.01);
    }

    function rectHit(px: number, py: number) {
      const list = visibleBubbles().slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (
          px >= b.x - b.w / 2 && px <= b.x + b.w / 2 &&
          py >= b.y - b.h / 2 && py <= b.y + b.h / 2
        ) return b;
      }
      return null;
    }

    function expandGroup(key: string) {
      savedOverview = new Map(
        bubbles.map((b) => [b.id, { x: b.x, y: b.y, w: b.w, h: b.h, r: b.r }]),
      );
      expandedKey = key;
      const members = clusterMembers(key).slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
      const memberIds = new Set(members.map((m) => m.id));
      const n = members.length;
      const topPad = 90, bottomPad = 50, gap = 10;
      const availH = H - topPad - bottomPad;
      const bw = Math.min(560, W * 0.55);
      const idealH = (availH - gap * (n - 1)) / n;
      const bh = Math.max(78, Math.min(118, idealH));
      const startY = topPad;
      const cx = W / 2;
      const totalH = n * bh + Math.max(0, n - 1) * gap;
      expandedScrollOffset = 0;
      expandedScrollMax = Math.max(0, totalH - availH);
      expandedLayout = { members, memberIds, n, bh, gap, startY, cx, bw };
      applyExpandedLayout();
      for (const b of bubbles) {
        if (memberIds.has(b.id)) continue;
        b.targetX = b.x; b.targetY = b.y;
        b.targetW = b.w; b.targetH = b.h; b.targetR = b.r;
        b.targetAlpha = 0;
      }
      updateChrome();
      startAnim();
    }

    function applyExpandedLayout() {
      if (!expandedLayout) return;
      const { members, n, bh, gap, startY, cx, bw } = expandedLayout;
      for (let i = 0; i < n; i++) {
        const m = members[i] as Bubble;
        m.targetX = cx;
        m.targetY = startY + i * (bh + gap) + bh / 2 - expandedScrollOffset;
        m.targetW = bw;
        m.targetH = bh;
        m.targetR = (bw + bh) / 4;
        m.targetAlpha = 1;
      }
    }

    function collapse() {
      if (savedOverview) {
        for (const b of bubbles) {
          const s = savedOverview.get(b.id);
          if (s) {
            b.targetX = s.x; b.targetY = s.y;
            b.targetW = s.w; b.targetH = s.h; b.targetR = s.r;
          }
          b.targetAlpha = 1;
        }
        savedOverview = null;
      }
      expandedKey = null;
      expandedLayout = null;
      expandedScrollOffset = 0;
      expandedScrollMax = 0;
      updateChrome();
      startAnim();
    }

    const EASE = 0.22;
    let animRaf = 0;
    function tickAnim() {
      let stillAnimating = false;
      for (const b of bubbles) {
        const tx = b.targetX ?? b.x;
        const ty = b.targetY ?? b.y;
        const tw = b.targetW ?? b.w;
        const th = b.targetH ?? b.h;
        const tr = b.targetR ?? b.r;
        const ta = b.targetAlpha ?? (b.alpha ?? 1);
        b.x += (tx - b.x) * EASE;
        b.y += (ty - b.y) * EASE;
        b.w += (tw - b.w) * EASE;
        b.h += (th - b.h) * EASE;
        b.r += (tr - b.r) * EASE;
        b.alpha = (b.alpha ?? 1) + (ta - (b.alpha ?? 1)) * EASE;
        if (
          Math.abs(tx - b.x) > 0.4 || Math.abs(ty - b.y) > 0.4 ||
          Math.abs(tw - b.w) > 0.4 || Math.abs(th - b.h) > 0.4 ||
          Math.abs(ta - b.alpha) > 0.005
        ) {
          stillAnimating = true;
        } else {
          b.x = tx; b.y = ty; b.w = tw; b.h = th; b.r = tr; b.alpha = ta;
        }
      }
      draw();
      if (stillAnimating) {
        animRaf = requestAnimationFrame(tickAnim);
      } else {
        animRaf = 0;
      }
    }
    function startAnim() {
      if (!animRaf) animRaf = requestAnimationFrame(tickAnim);
    }

    function escapeHtml(s: string) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
      } as Record<string, string>)[c]);
    }

    function updateChrome() {
      if (expandedKey) {
        header.classList.add("expanded");
        const members = clusterMembers(expandedKey);
        const label = members[0]?.groupTitle || members[0]?.projectTag || members[0]?.cwd || members[0]?.project || expandedKey;
        meta.innerHTML =
          `<span style="color:var(--ink); letter-spacing:0.04em">${escapeHtml(label)}</span>` +
          `<span class="dot"></span>${members.length} chats`;
      } else {
        header.classList.remove("expanded");
        meta.innerHTML = lastMeta;
      }
    }

    async function load() {
      refreshBtn.disabled = true;
      const started = Date.now();
      meta.textContent = "gathering specimens…";
      try {
        const res = await fetch("/api/chats");
        const data = await res.json();
        buildBubbles(data.chats);
        settle();
        if (!fontsReady) {
          try { await document.fonts.ready; } catch {}
          fontsReady = true;
        }
        draw();
        const ms = Date.now() - started;
        const tag = data.hasApiKey
          ? "haiku summaries"
          : "heuristic summaries (set ANTHROPIC_API_KEY for haiku)";
        lastMeta =
          `${data.chats.length} specimens<span class="dot"></span>${tag}<span class="dot"></span>${ms}ms`;
        if (!expandedKey) updatePendingMeta(data.chats);
        hydrateAll();
      } catch (e: any) {
        meta.textContent = "error: " + e.message;
      } finally {
        refreshBtn.disabled = false;
      }
    }

    function pendingCounts(chats: { groupTitle: any; summary: any }[]) {
      let t = 0, s = 0;
      for (const c of chats) {
        if (!c.groupTitle) t++;
        if (!c.summary) s++;
      }
      return { t, s };
    }

    function updatePendingMeta(chats: { groupTitle: any; summary: any }[]) {
      const { t, s } = pendingCounts(chats);
      if (t === 0 && s === 0) {
        meta.innerHTML = lastMeta;
        return;
      }
      const parts = [];
      if (t > 0) parts.push(`${t} title${t === 1 ? "" : "s"}`);
      if (s > 0) parts.push(`${s} summar${s === 1 ? "y" : "ies"}`);
      meta.innerHTML =
        `${chats.length} specimens<span class="dot"></span>generating ${parts.join(" + ")}…`;
    }

    async function hydrateAll() {
      const queue = bubbles
        .filter((b) => !b.groupTitle || !b.summary)
        .map((b) => b.id);
      if (queue.length === 0) {
        if (!expandedKey) {
          updatePendingMeta(bubbles.map((b) => ({
            groupTitle: b.groupTitle,
            summary: b.summary,
          })));
        }
        return;
      }
      const WORKERS = 4;
      await Promise.all(Array.from({ length: WORKERS }, async () => {
        while (queue.length > 0) {
          const id = queue.shift()!;
          await hydrateOne(id);
        }
      }));
    }

    async function hydrateOne(id: string) {
      try {
        const res = await fetch(`/api/chat/${encodeURIComponent(id)}`);
        if (!res.ok) return;
        const data = await res.json();
        let changed = false;
        for (const b of bubbles) {
          if (data.groupKey && groupKey(b) === data.groupKey && data.title && b.groupTitle !== data.title) {
            b.groupTitle = data.title;
            changed = true;
          }
          if (b.id === id && data.summary && b.summary !== data.summary) {
            b.summary = data.summary;
            changed = true;
          }
        }
        if (changed) draw();
        if (!expandedKey) {
          updatePendingMeta(bubbles.map((b) => ({
            groupTitle: b.groupTitle,
            summary: b.summary,
          })));
        }
      } catch (e) {
        console.error("hydrate", id, e);
      }
    }

    const onWheel = (e: WheelEvent) => {
      if (!expandedKey || expandedScrollMax <= 0 || !expandedLayout) return;
      e.preventDefault();
      const prev = expandedScrollOffset;
      expandedScrollOffset = Math.max(
        0,
        Math.min(expandedScrollMax, expandedScrollOffset + e.deltaY),
      );
      if (expandedScrollOffset === prev) return;
      applyExpandedLayout();
      for (const m of expandedLayout.members) {
        m.y = m.targetY;
        m.vy = 0;
      }
      draw();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const onMouseMove = (e: MouseEvent) => {
      const hit = rectHit(e.clientX, e.clientY);
      canvas.classList.toggle("clickable", Boolean(expandedKey || hit));
      const newId = hit && !expandedKey ? hit.id : null;
      if (newId !== hoveredId) {
        hoveredId = newId;
        draw();
      }
    };
    canvas.addEventListener("mousemove", onMouseMove);

    const onMouseLeave = () => {
      if (hoveredId !== null) { hoveredId = null; draw(); }
    };
    canvas.addEventListener("mouseleave", onMouseLeave);

    const onClick = (e: MouseEvent) => {
      const hit = rectHit(e.clientX, e.clientY);
      if (expandedKey) {
        if (hit && hitResumeBtn(e.clientX, e.clientY, hit)) {
          resumeChat(hit);
          return;
        }
        collapse();
        return;
      }
      if (!hit) return;
      expandGroup(groupKey(hit));
    };
    canvas.addEventListener("click", onClick);

    async function resumeChat(b: Bubble) {
      try {
        await fetch("/api/resume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: b.id, cwd: b.cwd }),
        });
      } catch (e) {
        console.error("resume failed", e);
      }
    }

    const onClose = () => { if (expandedKey) collapse(); };
    closeBtn.addEventListener("click", onClose);

    const onRefresh = () => load();
    refreshBtn.addEventListener("click", onRefresh);

    const onClearCache = async () => {
      if (!confirm("Clear all cached titles and summaries? They'll be regenerated.")) return;
      clearCacheBtn.disabled = true;
      try {
        await fetch("/api/cache/clear", { method: "POST" });
        await load();
      } catch (e) {
        console.error("clear cache failed", e);
      } finally {
        clearCacheBtn.disabled = false;
      }
    };
    clearCacheBtn.addEventListener("click", onClearCache);

    resize();
    load();

    return () => {
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      canvas.removeEventListener("click", onClick);
      closeBtn.removeEventListener("click", onClose);
      refreshBtn.removeEventListener("click", onRefresh);
      clearCacheBtn.removeEventListener("click", onClearCache);
      if (animRaf) cancelAnimationFrame(animRaf);
    };
  }, []);

  return (
    <>
      <header id="header" ref={headerRef}>
        <span className="brand">wompwomp</span>
        <span className="mark">※</span>
        <span className="tagline">an archive of conversations</span>
        <span className="spacer"></span>
        <span className="status" id="meta" ref={metaRef}>gathering specimens…</span>
        <button id="refresh" ref={refreshBtnRef}>refresh</button>
        <button id="clear-cache" ref={clearCacheBtnRef} title="discard cached titles and summaries and regenerate">clear cache</button>
        <button id="close" ref={closeBtnRef} title="close">× close</button>
      </header>

      <div className="edition">
        vol. i &nbsp;·&nbsp; <em>local edition</em>
      </div>

      <canvas id="c" ref={canvasRef}></canvas>

      <div className="colophon">
        <span>chats from <em>~/.claude/projects</em></span>
        <span className="rule"></span>
        <span>click a specimen to inspect</span>
      </div>
    </>
  );
}
