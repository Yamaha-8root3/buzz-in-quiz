import { INTRO_MS, FreeQ, KanaStep, RunQ, scoreAt } from "../shared/quiz";

export const GRACE_MS = 300; // accept after deadline (latency)
const TOL_MS = 500; // client/server time gap tolerance

export interface Buzz {
  id: string;
  at: number;
}

export type CPhase = "ready" | "shown" | "streaming" | "answering" | "closed" | "revealed";

export interface KProg {
  step: number;
  keys: string[];
  ms: number;
  state: "play" | "done" | "fail";
  pos: number;
  t0: number;
  due: number;
  cur: string;
  forced?: boolean; // failed by host close (no penalty)
}

export interface ChoiceRun {
  q: RunQ;
  phase: CPhase;
  tStream: number;
  tAns: number;
  deadline: number;
  answers: Record<string, { choice: number; ms: number }>; // choice
  prog: Record<string, KProg>; // kana
  counts: number[];
  results: Record<string, { ok: boolean; ms: number; sc: number }>;
  stopPos?: number;
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const keysOf = (s: KanaStep) => shuffle([s.correct, ...s.dummies]);
const len = (s: string) => Array.from(s).length;

// client-measured ms is accepted only if consistent with server elapsed
function pickMs(d: number, e: number, limit: number) {
  const ms = typeof d === "number" && d <= e && d >= e - TOL_MS ? d : e;
  return Math.min(ms, limit);
}

export interface Game {
  n: number;
  phase: "idle" | "open";
  T: number;
  queue: Buzz[];
  answerer: string | null;
  locked: string[];
  pts: Record<string, number>;
  c: ChoiceRun | null;
  ms: Record<string, number>;
  res: { id: string; ok: boolean } | null;
  fq: FreeQ | null;
  order: Buzz[];
  sc: Record<string, number>;
  names: Record<string, string>;
}

export const initGame = (): Game => ({
  n: 0,
  phase: "idle",
  T: 0,
  queue: [],
  answerer: null,
  locked: [],
  pts: {},
  c: null,
  ms: {},
  res: null,
  fq: null,
  order: [],
  sc: {},
  names: {}
});

// new question
export function start(g: Game, now: number) {
  g.n++;
  g.phase = "open";
  g.T = now;
  g.queue = [];
  g.answerer = null;
  g.locked = [];
  g.c = null;
  g.res = null;
  g.fq = null;
  g.order = [];
}

function mark(g: Game, id: string, at: number) {
  if (g.order.some((b) => b.id === id)) return;
  const i = g.order.findIndex((b) => b.at > at);
  if (i < 0) g.order.push({ id, at });
  else g.order.splice(i, 0, { id, at });
}

// add buzz sorted by press time; false if rejected
export function buzz(g: Game, id: string, at: number): boolean {
  if (g.phase !== "open" || g.answerer === id || g.locked.includes(id) || g.queue.some((b) => b.id === id)) return false;
  if (!g.c && (g.answerer || g.queue.length > 0)) return false; // free-form: only one
  const i = g.queue.findIndex((b) => b.at > at);
  if (i < 0) g.queue.push({ id, at });
  else g.queue.splice(i, 0, { id, at });
  g.res = null;
  mark(g, id, at);
  return true;
}

// give answer right to queue head
export function grant(g: Game) {
  if (g.phase === "open" && !g.answerer && g.queue.length) {
    g.answerer = g.queue.shift()!.id;
    g.res = null;
  }
}

// judge current answerer
export function judge(g: Game, ok: boolean, score = 0) {
  const id = g.answerer;
  if (!id) return;
  g.answerer = null;
  g.res = { id, ok };
  if (ok) {
    g.pts[id] = (g.pts[id] ?? 0) + 1;
    g.sc[id] = Math.max(0, (g.sc[id] ?? 0) + score);
    g.phase = "idle";
    g.queue = [];
  } else {
    g.locked.push(id);
    grant(g);
  }
}

export function end(g: Game) {
  g.phase = "idle";
  g.queue = [];
  g.answerer = null;
  g.c = null;
  g.res = null;
  g.fq = null;
  g.order = [];
}

export function revive(g: Game) {
  if (g.phase === "open" && !g.c) g.locked = [];
}

export function reset(g: Game, all: boolean, alive: Set<string>) {
  end(g);
  g.n = 0;
  if (all) {
    g.pts = {};
    g.sc = {};
    g.ms = {};
    g.names = Object.fromEntries(Object.entries(g.names).filter(([id]) => alive.has(id))); // drop players who left
  }
}

// host edit of one player's score / correct count / total ms
export function setScore(g: Game, id: string, sc: number, pts: number, ms: number) {
  g.sc[id] = Math.max(0, sc);
  g.pts[id] = pts;
  g.ms[id] = ms;
}

// remove a leaving player
export function drop(g: Game, id: string) {
  g.queue = g.queue.filter((b) => b.id !== id);
  if (g.answerer === id) {
    g.answerer = null;
    grant(g);
  }
}

// free-form question from data
export function askFree(g: Game, q: FreeQ, now: number) {
  start(g, now);
  g.fq = q;
}

export function ask(g: Game, q: RunQ) {
  end(g);
  g.n++;
  g.order = [];
  g.c = { q, phase: "ready", tStream: 0, tAns: 0, deadline: 0, answers: {}, prog: {}, counts: [], results: {} };
  g.res = null;
}

function award(g: Game, r: ChoiceRun, id: string, ok: boolean, ms: number, best: number, gain: number) {
  const cur = g.sc[id] ?? 0;
  const d = Math.max(gain, -cur); // score never goes below 0
  r.results[id] = { ok, ms: ok ? ms : 0, sc: d };
  if (d) g.sc[id] = cur + d;
  if (ok) {
    g.pts[id] = (g.pts[id] ?? 0) + 1;
    g.ms[id] = (g.ms[id] ?? 0) + (ms - best);
  }
}

const fastest = (l: [string, boolean, number][]) => Math.min(...l.filter(([, ok]) => ok).map(([, , ms]) => ms), Infinity);

export function cmd(g: Game, c: "show" | "choices" | "close" | "reveal", now: number, correct?: number): boolean {
  const r = g.c;
  if (!r) return false;
  switch (c) {
    case "show":
      if (r.phase !== "ready") return false;
      if (r.q.type === "kana") {
        r.phase = "streaming";
        r.tStream = now + INTRO_MS;
        r.deadline = r.tStream + len(r.q.text) * r.q.intervalMs + r.q.startMs; // press window end
      } else r.phase = "shown";
      return true;
    case "choices": // choice: show choices / kana: skip stream
      if (r.phase !== "ready" && r.phase !== "shown" && r.phase !== "streaming") return false;
      r.phase = "answering";
      r.tAns = now;
      r.deadline = now + (r.q.type === "kana" ? r.q.startMs : r.q.limitMs);
      return true;
    case "close":
      if (r.q.type === "kana") {
        if (r.phase !== "streaming" && r.phase !== "answering") return false;
        for (const p of Object.values(r.prog))
          if (p.state === "play") {
            p.state = "fail";
            p.forced = true;
          }

        r.phase = "closed";
        return true;
      }
      if (r.phase !== "answering") return false;
      r.phase = "closed";
      r.counts = r.q.choices.map(() => 0);
      for (const a of Object.values(r.answers)) r.counts[a.choice]++;
      return true;
    case "reveal":
      if (r.phase !== "closed") return false;
      r.phase = "revealed";

      if (r.q.type === "choice" && typeof correct === "number" && correct >= 0 && correct < r.q.choices.length) r.q.correct = correct;
      {
        const q = r.q;
        const l: [string, boolean, number][] = q.type === "choice" ? Object.entries(r.answers).map(([id, a]) => [id, a.choice === q.correct, a.ms]) : Object.entries(r.prog).map(([id, p]) => [id, p.state === "done", p.ms]);
        const best = fastest(l);
        const oks = l.filter(([, ok]) => ok).sort((a, b) => a[2] - b[2]); // rank by time (ties share rank)
        const gainOf = (ms: number) =>
          q.type === "kana"
            ? scoreAt(
                q.scores,
                oks.findIndex((x) => x[2] === ms)
              )
            : q.score;
        // for (const [id, ok, ms] of l) award(g, r, id, ok, ms, best, gainOf(ms));

        const pen = (id: string) => (q.type === "kana" && r.prog[id]?.state === "fail" && !r.prog[id].forced ? -q.penalty : 0); // wrong answer penalty
        for (const [id, ok, ms] of l) award(g, r, id, ok, ms, best, ok ? gainOf(ms) : pen(id));
      }
      return true;
  }
}

// choice answer; d = client-measured ms since choices shown
export function answer(g: Game, id: string, choice: number, d: number, now: number): boolean {
  const r = g.c;
  if (!r || r.q.type !== "choice" || r.phase !== "answering" || id in r.answers) return false;
  if (!Number.isInteger(choice) || choice < 0 || choice >= r.q.choices.length) return false;
  if (now > r.deadline + GRACE_MS) return false;
  r.answers[id] = { choice, ms: pickMs(d, now - r.tAns, r.q.limitMs) };
  return true;
}

export const progOf = (g: Game, id: string): KProg | null => g.c?.prog?.[id] ?? null;

// kana: start answering (press); pos = chars the player saw
export function press(g: Game, id: string, pos: number, now: number): KProg | null {
  const r = g.c;

  if (!r || r.q.type !== "kana" || (r.phase !== "streaming" && r.phase !== "answering") || id in r.prog) return null;
  if (r.phase === "streaming" && now < r.tStream) return null;
  const q = r.q;
  if (now > r.deadline + GRACE_MS) return null;
  if (q.max !== undefined && Object.keys(r.prog).length >= q.max) return null;
  const maxPos = r.phase === "streaming" ? Math.min(len(q.text), Math.floor((now - r.tStream) / q.intervalMs) + 1) : len(q.text);
  const p: KProg = {
    step: 0,
    keys: keysOf(q.steps[0]),
    ms: now - (r.tStream || r.tAns),
    state: "play",
    pos: Number.isInteger(pos) ? Math.min(Math.max(pos, 0), maxPos) : maxPos,
    t0: now,
    due: now + q.firstMs,
    cur: ""
  };
  r.prog[id] = p;
  mark(g, id, now);
  if (q.max !== undefined && Object.keys(r.prog).length >= q.max && r.phase === "streaming") {
    r.phase = "answering";
    r.stopPos = maxPos; // slots full: stop the stream for everyone
  }
  return p;
}

// kana: one key press; progress or null if rejected
export function key(g: Game, id: string, step: number, k: string, d: number, now: number): KProg | null {
  const r = g.c;
  const p = r?.prog[id];
  if (!r || r.q.type !== "kana" || !p || p.state !== "play" || p.step !== step) return null;
  if (r.phase !== "streaming" && r.phase !== "answering") return null;
  const q = r.q;
  if (now > p.due + GRACE_MS || k !== q.steps[step].correct) {
    p.state = "fail";
    p.cur += k;
    return p;
  }
  p.cur += k;
  p.step++;
  p.t0 = now;
  if (p.step >= q.steps.length) p.state = "done";
  else {
    p.keys = keysOf(q.steps[p.step]);
    p.due = now + q.nextMs;
  }
  return p;
}

// one key press; progress or null if rejected
// export function key(g: Game, id: string, step: number, k: string, d: number, now: number): KProg | null {
//   const r = g.c;
//   const p = prog(g, id);
//   if (!r || r.q.type !== "kana" || !p || p.state !== "play" || p.step !== step) return null;
//   if (now > r.deadline + GRACE_MS) return null;
//   if (k !== r.q.steps[step].correct) { p.state = "fail"; return p; }
//   p.ms = pickMs(d, now - r.tAns, r.q.limitMs);
//   p.step++;
//   if (p.step >= r.q.steps.length) p.state = "done"; else p.keys = keysOf(r.q.steps[p.step]);
//   return p;
// }

// time-driven and completion-driven transitions; returns ids that timed out (kana)
export function sweep(g: Game, now: number, players: number): { failed: string[] } {
  const r = g.c;
  const failed: string[] = [];
  if (!r) return { failed };
  if (r.q.type === "choice") {
    const all = players > 0 && Object.keys(r.answers).length >= players;
    if (r.phase === "answering" && (all || now >= r.deadline + GRACE_MS)) cmd(g, "close", now);
    return { failed };
  }
  const q = r.q;
  if (r.phase === "streaming" && now >= r.tStream + len(q.text) * q.intervalMs) r.phase = "answering";
  if (r.phase !== "streaming" && r.phase !== "answering") return { failed };
  const progs = Object.entries(r.prog);
  for (const [id, p] of progs)
    if (p.state === "play" && now >= p.due + GRACE_MS) {
      p.state = "fail";
      failed.push(id);
    }
  const inPlay = progs.some(([, p]) => p.state === "play");
  const over = r.phase === "answering" && now >= r.deadline + GRACE_MS;
  const full = q.max !== undefined && progs.length >= q.max;
  const all = players > 0 && progs.length >= players;
  if (!inPlay && (over || full || all)) {
    r.phase = "closed";
    cmd(g, "reveal", now); // everyone finished: show answer now
  }

  return { failed };
}

// next time something changes by itself (null = none)
export function nextDue(g: Game): number | null {
  const r = g.c;
  if (!r) return null;
  if (r.q.type === "choice") return r.phase === "answering" ? r.deadline + GRACE_MS : null;
  if (r.phase !== "streaming" && r.phase !== "answering") return null;
  const t = [r.phase === "streaming" ? r.tStream + len(r.q.text) * r.q.intervalMs : r.deadline + GRACE_MS];
  for (const p of Object.values(r.prog)) if (p.state === "play") t.push(p.due + GRACE_MS);
  return Math.min(...t);
}
