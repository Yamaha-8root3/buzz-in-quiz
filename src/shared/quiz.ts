// src/shared/quiz.ts : replace whole file
export interface KanaStep {
  correct: string;
  dummies: [string, string, string];
}

// free: oral / free-form buzz (text & ans are host-only)
export interface FreeQ {
  id: string;
  type: "free";
  text?: string;
  ans?: string;
}

export interface ChoiceQ {
  id: string;
  type: "choice";
  text?: string;
  ans?: string;
  choices: string[];
  correct: number;
  limitMs: number;
  score: number;
}

export interface KanaQ {
  id: string;
  type: "kana";
  text: string;
  ans?: string;
  intervalMs: number;
  startMs: number;
  firstMs: number;
  nextMs: number;
  max?: number; // max answerers (undefined = unlimited)
  steps: KanaStep[];
  scores: number[]; // points by rank among correct answerers (out of range = last)
}

export type RunQ = ChoiceQ | KanaQ; // runs inside game.c
export type Q = FreeQ | RunQ;

export interface RoomSettings {
  intervalMs: number;
  startMs: number;
  firstMs: number;
  nextMs: number;
  max?: number;
  choiceMs: number;
  choiceScore: number;
  kanaScores: number[];
  freeScore: number
}

export const DEFAULT_SETTINGS: RoomSettings = {
  intervalMs: 100,
  startMs: 5000,
  firstMs: 5000,
  nextMs: 3000,
  choiceMs: 10000,
  choiceScore: 10,
  kanaScores: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
  freeScore: 10
};

const pt = (v: unknown, d: number) => (Number.isInteger(v) && Math.abs(v as number) <= 9999 ? (v as number) : d);
const pl = (v: unknown, d: number[]) => (Array.isArray(v) && v.length >= 1 && v.length <= 100 && v.every((n) => Number.isInteger(n) && Math.abs(n) <= 9999) ? (v as number[]) : d);
export const scoreAt = (a: number[], rank: number) => a[Math.min(rank, a.length - 1)];
export const cleanScore = (v: unknown) => pt(v, DEFAULT_SETTINGS.freeScore);

export function cleanSettings(x: Partial<Record<keyof RoomSettings, unknown>>): RoomSettings {
  const d = DEFAULT_SETTINGS;
  const c = (v: unknown, lo: number, hi: number, def: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def);
  return {
    intervalMs: c(x.intervalMs, 50, 2000, d.intervalMs),
    startMs: c(x.startMs, 1000, 600000, d.startMs),
    firstMs: c(x.firstMs, 1000, 600000, d.firstMs),
    nextMs: c(x.nextMs, 1000, 600000, d.nextMs),
    choiceMs: c(x.choiceMs, 1000, 600000, d.choiceMs),
    max: typeof x.max === "number" && Number.isFinite(x.max) ? c(x.max, 1, 100, 1) : undefined,
    choiceScore: pt(x.choiceScore, d.choiceScore),
    kanaScores: pl(x.kanaScores, d.kanaScores),
    freeScore: pt(x.freeScore, d.freeScore),
  };
}

// fill in timing / limits right before sending
export function applySettings(q: Q, s: RoomSettings): Q {
  if (q.type === "kana") return {
    ...q,
    intervalMs: s.intervalMs,
    startMs: s.startMs,
    firstMs: s.firstMs,
    nextMs: s.nextMs,
    max: s.max,
    scores: s.kanaScores
  };
  if (q.type === "choice") return {...q, limitMs: s.choiceMs, score: s.choiceScore};
  return q;
}

const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const one = (s: unknown): s is string => typeof s === "string" && [...s].length === 1 && !/\s/.test(s);
const ms = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

export function cleanQ(x: unknown): Q | null {
  const t = (x as { type?: unknown } | null)?.type;
  return t === "kana" ? cleanKanaQ(x) : t === "choice" ? cleanChoiceQ(x) : t === "free" ? cleanFreeQ(x) : null;
}

export function cleanFreeQ(x: unknown): FreeQ | null {
  const q = x as Partial<FreeQ> | null;
  if (!q || typeof q.id !== "string") return null;
  return {id: q.id.slice(0, 64), type: "free", text: str(q.text, 500), ans: str(q.ans, 200)};
}

export function cleanChoiceQ(x: unknown): ChoiceQ | null {
  const q = x as Partial<ChoiceQ> | null;
  if (!q || typeof q.id !== "string" || !Array.isArray(q.choices)) return null;
  const cs = q.choices;
  if (cs.length < 2 || cs.length > 6 || cs.some((s) => typeof s !== "string" || !s.trim() || s.length > 100)) return null;
  if (!Number.isInteger(q.correct) || q.correct! < 0 || q.correct! >= cs.length) return null;
  if (!ms(q.limitMs, 1000, 600000)) return null;
  return {
    id: q.id.slice(0, 64),
    type: "choice",
    text: str(q.text, 500),
    ans: str(q.ans, 200),
    choices: cs.map((s) => s.trim()),
    correct: q.correct!,
    limitMs: q.limitMs, score: pt(q.score, DEFAULT_SETTINGS.choiceScore)
  };
}

export function cleanKanaQ(x: unknown): KanaQ | null {
  const q = x as Partial<KanaQ> | null;
  if (!q || typeof q.id !== "string" || !Array.isArray(q.steps)) return null;
  const text = str(q.text, 500);
  if (!text) return null;
  if (!ms(q.intervalMs, 50, 2000) || !ms(q.startMs, 1000, 600000) || !ms(q.firstMs, 1000, 600000) || !ms(q.nextMs, 1000, 600000)) return null;
  if (q.max !== undefined && !ms(q.max, 1, 100)) return null;
  if (q.steps.length < 1 || q.steps.length > 20) return null;
  const steps: KanaStep[] = [];
  for (const s of q.steps) {
    const d = s?.dummies;
    if (!one(s?.correct) || !Array.isArray(d) || d.length !== 3 || !d.every(one)) return null;
    if (new Set([s.correct, ...d]).size !== 4) return null;
    steps.push({correct: s.correct, dummies: [d[0], d[1], d[2]]});
  }
  return {
    id: q.id.slice(0, 64),
    type: "kana",
    text,
    ans: str(q.ans, 200),
    intervalMs: q.intervalMs,
    startMs: q.startMs,
    firstMs: q.firstMs,
    nextMs: q.nextMs,
    max: q.max,
    steps,
    scores: pl(q.scores, DEFAULT_SETTINGS.kanaScores)
  };
}

/* ---------- CSV import (kana only) ----------
 row 1 = header (ignored)
 cols: 0 text, 1 answer(display) 2 kana answer (e.g. こたえ),3 unused
       4.. dummies: one column per answer char, 3 chars each (e.g. あいう,えおか,きくけ) */

// RFC4180-style: quoted fields, "" escape, CRLF, BOM

const TYPES = ["free", "choice", "kana"];
const list = (s: string) =>
  s
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);

export function parseCsv(src: string): string[][] {
  return src.replace(/^\uFEFF/, "").split(/\r\n|\n|\r/).map((line) => {
    const row: string[] = [];
    let f = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch !== '"') f += ch;
        else if (line[i + 1] === '"') {
          f += '"';
          i++;
        } else inQ = false;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") {
        row.push(f);
        f = "";
      } else f += ch;
    }
    row.push(f);
    return row;
  });
}

export function csvToQs(src: string): { qs: Q[]; errs: string[] } {
  const qs: Q[] = [], errs: string[] = [];
  parseCsv(src).forEach((r, i) => {
    if (i === 0 || !r.some((x) => x.trim())) return; // header / blank line
    const c = (n: number) => (r[n] ?? "").trim();
    const err = (m: string) => errs.push(`${i + 1}行目: ${m}`);
    const chars = [...c(2).replace(/\s/g, "")];
    if (!chars.length) return err("回答する文字が空");
    const d = DEFAULT_SETTINGS;
    const steps = [];
    for (let k = 0; k < chars.length; k++) {
      const dm = [...c(4 + k).replace(/\s/g, "")];
      if (dm.length !== 3) return err(`${k + 1}文字目のダミーが3文字ではありません`);
      if (new Set([chars[k], ...dm]).size !== 4) return err(`${k + 1}文字目「${chars[k]}」: ダミー「${dm.join("")}」に正解文字または重複があります`);
      steps.push({correct: chars[k], dummies: dm});
    }
    const q = cleanQ({
      id: crypto.randomUUID(),
      type: "kana",
      text: c(0),
      ans: c(1),
      intervalMs: d.intervalMs,
      startMs: d.startMs,
      firstMs: d.firstMs,
      nextMs: d.nextMs,
      steps
    });
    if (q) qs.push(q); else err("内容が不正 (問題文なし / 文字の重複)");
  });
  return {qs, errs};
}