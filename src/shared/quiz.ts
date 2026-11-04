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
}
export type RunQ = ChoiceQ | KanaQ; // runs inside game.c
export type Q = FreeQ | RunQ;

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
  return { id: q.id.slice(0, 64), type: "free", text: str(q.text, 500), ans: str(q.ans, 200) };
}

export function cleanChoiceQ(x: unknown): ChoiceQ | null {
  const q = x as Partial<ChoiceQ> | null;
  if (!q || typeof q.id !== "string" || !Array.isArray(q.choices)) return null;
  const cs = q.choices;
  if (cs.length < 2 || cs.length > 6 || cs.some((s) => typeof s !== "string" || !s.trim() || s.length > 100)) return null;
  if (!Number.isInteger(q.correct) || q.correct! < 0 || q.correct! >= cs.length) return null;
  if (!ms(q.limitMs, 1000, 600000)) return null;
  return { id: q.id.slice(0, 64), type: "choice", text: str(q.text, 500), ans: str(q.ans, 200), choices: cs.map((s) => s.trim()), correct: q.correct!, limitMs: q.limitMs };
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
    steps.push({ correct: s.correct, dummies: [d[0], d[1], d[2]] });
  }
  return { id: q.id.slice(0, 64), type: "kana", text, ans: str(q.ans, 200), intervalMs: q.intervalMs, startMs: q.startMs, firstMs: q.firstMs, nextMs: q.nextMs, max: q.max, steps };
}

/* ---------- CSV import ----------
 cols: 0 type(free|choice|kana), 1 text, 2 answer(display), 3 choices(comma, first=correct),
       4 kana answer, 5 kana dummies(comma; 3 per char, in order),
       6 [opt] choice limit(sec, default 10), 7 [opt] kana max answerers */

// RFC4180-style: quoted fields, "" escape, CRLF, BOM
export function parseCsv(src: string): string[][] {
  const s = src.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    f = "",
    inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch !== '"') f += ch;
      else if (s[i + 1] === '"') {
        f += '"';
        i++;
      } else inQ = false;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      row.push(f);
      f = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(f);
      f = "";
      rows.push(row);
      row = [];
    } else f += ch;
  }
  if (f || row.length) {
    row.push(f);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

const TYPES = ["free", "choice", "kana"];
const list = (s: string) =>
  s
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);

export function csvToQs(src: string): { qs: Q[]; errs: string[] } {
  const qs: Q[] = [],
    errs: string[] = [];
  parseCsv(src).forEach((r, i) => {
    const c = (n: number) => (r[n] ?? "").trim();
    const t = c(0).toLowerCase();
    if (i === 0 && !TYPES.includes(t)) return; // header row
    const err = (m: string) => errs.push(`${i + 1}行目: ${m}`);
    const id = crypto.randomUUID(),
      text = c(1),
      ans = c(2);
    let raw: unknown;
    if (t === "free") raw = { id, type: "free", text, ans };
    else if (t === "choice") {
      const lim = c(6) ? Number(c(6)) : 10;
      raw = { id, type: "choice", text, ans, choices: list(c(3)), correct: 0, limitMs: lim * 1000 };
    } else if (t === "kana") {
      const chars = [...c(4).replace(/\s/g, "")];
      const dm = [...c(5).replace(/[,，\s]/g, "")];
      if (dm.length !== chars.length * 3) return err(`ダミー文字数が不一致 (必要 ${chars.length * 3} / 実際 ${dm.length})`);
      raw = {
        id,
        type: "kana",
        text,
        ans,
        intervalMs: 150,
        startMs: 5000,
        firstMs: 5000,
        nextMs: 3000,
        max: c(7) ? Number(c(7)) : undefined,
        steps: chars.map((k, j) => ({ correct: k, dummies: dm.slice(j * 3, j * 3 + 3) }))
      };
    } else return err(`形式が不正 "${c(0)}"`);
    const q = cleanQ(raw);
    if (q) qs.push(q);
    else err(`内容が不正 (${t})`);
  });
  return { qs, errs };
}

// export type Slots =
//   | { kind: "multi"; max: number } // first N buzzers may answer
//   | { kind: "single" } // one at a time, no queue
//   | { kind: "queue" }; // one at a time, in press order

// export type TextReveal =
//   | { kind: "none" } // no text (oral only)
//   | { kind: "manual" } // host shows it after reading
//   | { kind: "stream"; intervalMs: number }; // online, one char at a time

// interface QBase {
//   id: string; // auto "q1".. if omitted on import
//   text?: string; // omit for oral-only questions
//   reveal?: TextReveal; // default: text ? { kind: "manual" } : { kind: "none" }
//   limitMs?: number; // answer time limit (mode "all")
//   note?: string; // host-only memo
//   mode?: "buzz" | "all"; // buzz: answer right by press / all: everyone answers
//   slots?: Slots; // overrides quiz/room default (buzz only)
// }

// export interface KanaStep {
//   correct: string;
//   dummies: [string, string, string];
// }

// export type Question =
//   | (QBase & { type: "oral"; answer?: string }) // host judges
//   | (QBase & { type: "choice"; choices: string[]; correct: number })
//   | (QBase & { type: "kana"; steps: KanaStep[] }) // answer = steps' correct joined
//   | (QBase & { type: "input"; answers: string[] }); // accepted answers (auto-match)

// export interface QuizSet {
//   title?: string;
//   slots?: Slots;
//   questions: Question[];
// }

// // sent to players (no answers)
// interface PBase {
//   id: string;
//   text?: string;
//   mode: "buzz" | "all";
// }
// export type PublicQuestion = (PBase & { type: "oral" }) | (PBase & { type: "choice"; choices: string[] }) | (PBase & { type: "kana"; length: number }); // keys are sent per step by the DO

// const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
// const one = (s: unknown): s is string => typeof s === "string" && [...s].length === 1 && !/\s/.test(s);
// const ms = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// export function cleanQ(x: unknown): Q | null {
//   const t = (x as { type?: unknown } | null)?.type;
//   return t === "kana" ? cleanKanaQ(x) : t === "choice" ? cleanChoiceQ(x) : t === "free" ? cleanFreeQ(x) : null;
// }

// // strip answers
// export function toPublic(q: Question): PublicQuestion {
//   const b = { id: q.id, text: q.text, mode: modeOf(q) };
//   switch (q.type) {
//     case "oral":
//       return { ...b, type: "oral" };
//     case "choice":
//       return { ...b, type: "choice", choices: q.choices };
//     case "kana":
//       return { ...b, type: "kana", length: q.steps.length };
//     default:
//       return { ...b, type: "oral" };
//   }
// }

// export interface ChoiceQ {
//   id: string;
//   type: "choice";
//   text?: string;
//   choices: string[];
//   correct: number;
//   limitMs: number;
// }

// export function cleanChoiceQ(x: unknown): ChoiceQ | null {
//   const q = x as Partial<ChoiceQ> | null;
//   if (!q || typeof q.id !== "string" || !Array.isArray(q.choices)) return null;
//   const cs = q.choices;
//   if (cs.length < 2 || cs.length > 6 || cs.some((s) => typeof s !== "string" || !s.trim() || s.length > 100)) return null;
//   if (!Number.isInteger(q.correct) || q.correct! < 0 || q.correct! >= cs.length) return null;
//   if (!ms(q.limitMs, 1000, 600000)) return null;
//   return { id: q.id.slice(0, 64), type: "choice", text: str(q.text, 500), ans: str(q.ans, 200), choices: cs.map((s) => s.trim()), correct: q.correct!, limitMs: q.limitMs };
// }

// export function cleanKanaQ(x: unknown): KanaQ | null {
//   const q = x as Partial<KanaQ> | null;
//   if (!q || typeof q.id !== "string" || !Array.isArray(q.steps)) return null;
//   const text = str(q.text, 500);
//   if (!text) return null;
//   if (!ms(q.intervalMs, 50, 2000) || !ms(q.startMs, 1000, 600000) || !ms(q.firstMs, 1000, 600000) || !ms(q.nextMs, 1000, 600000)) return null;
//   if (q.max !== undefined && !ms(q.max, 1, 100)) return null;
//   if (q.steps.length < 1 || q.steps.length > 20) return null;
//   const steps: KanaStep[] = [];
//   for (const s of q.steps) {
//     const d = s?.dummies;
//     if (!one(s?.correct) || !Array.isArray(d) || d.length !== 3 || !d.every(one)) return null;
//     if (new Set([s.correct, ...d]).size !== 4) return null;
//     steps.push({ correct: s.correct, dummies: [d[0], d[1], d[2]] });
//   }
//   return { id: q.id.slice(0, 64), type: "kana", text, ans: str(q.ans, 200), intervalMs: q.intervalMs, startMs: q.startMs, firstMs: q.firstMs, nextMs: q.nextMs, max: q.max, steps };
// }

// export interface KanaStep {
//   correct: string;
//   dummies: [string, string, string];
// }
// export interface KanaQ {
//   id: string;
//   type: "kana";
//   text: string;
//   intervalMs: number;
//   steps: KanaStep[];
//   limitMs: number;
// }

// export interface KanaQ {
//   id: string;
//   type: "kana";
//   text: string;
//   intervalMs: number;
//   startMs: number;
//   firstMs: number;
//   nextMs: number;
//   max?: number; // max answerers (undefined = unlimited)
//   steps: KanaStep[];
// }

// export interface FreeQ {
//   id: string;
//   type: "free";
//   text?: string;
//   ans?: string;
// }
// export interface ChoiceQ {
//   id: string;
//   type: "choice";
//   text?: string;
//   ans?: string;
//   choices: string[];
//   correct: number;
//   limitMs: number;
// }
// export interface KanaQ {
//   id: string;
//   type: "kana";
//   text: string;
//   ans?: string;
//   intervalMs: number;
//   startMs: number;
//   firstMs: number;
//   nextMs: number;
//   max?: number; // max answerers (undefined = unlimited)
//   steps: KanaStep[];
// }
// export type RunQ = ChoiceQ | KanaQ; // runs inside game.c
// export type Q = FreeQ | RunQ;

// /* ---------- CSV import ----------
//  cols: 0 type(free|choice|kana), 1 text, 2 answer(display), 3 choices(comma, first=correct),
//        4 kana answer, 5 kana dummies(comma; 3 per char, in order),
//        6 [opt] choice limit(sec, default 10), 7 [opt] kana max answerers */

// // RFC4180-style: quoted fields, "" escape, CRLF, BOM

// export function parseCsv(src: string): string[][] {
//   const s = src.replace(/^\uFEFF/, "");
//   const rows: string[][] = [];
//   let row: string[] = [],
//     f = "",
//     inQ = false;
//   for (let i = 0; i < s.length; i++) {
//     const ch = s[i];
//     if (inQ) {
//       if (ch !== '"') f += ch;
//       else if (s[i + 1] === '"') {
//         f += '"';
//         i++;
//       } else inQ = false;
//     } else if (ch === '"') inQ = true;
//     else if (ch === ",") {
//       row.push(f);
//       f = "";
//     } else if (ch === "\n" || ch === "\r") {
//       if (ch === "\r" && s[i + 1] === "\n") i++;
//       row.push(f);
//       f = "";
//       rows.push(row);
//       row = [];
//     } else f += ch;
//   }
//   if (f || row.length) {
//     row.push(f);
//     rows.push(row);
//   }
//   return rows.filter((r) => r.some((c) => c.trim()));
// }

// const TYPES = ["free", "choice", "kana"];
// const list = (s: string) =>
//   s
//     .split(/[,，]/)
//     .map((t) => t.trim())
//     .filter(Boolean);

// export function csvToQs(src: string): { qs: Q[]; errs: string[] } {
//   const qs: Q[] = [],
//     errs: string[] = [];
//   parseCsv(src).forEach((r, i) => {
//     const c = (n: number) => (r[n] ?? "").trim();
//     const t = c(0).toLowerCase();
//     if (i === 0 && !TYPES.includes(t)) return; // header row
//     const err = (m: string) => errs.push(`${i + 1}行目: ${m}`);
//     const id = crypto.randomUUID(),
//       text = c(1),
//       ans = c(2);
//     let raw: unknown;
//     if (t === "free") raw = { id, type: "free", text, ans };
//     else if (t === "choice") {
//       const lim = c(6) ? Number(c(6)) : 10;
//       raw = { id, type: "choice", text, ans, choices: list(c(3)), correct: 0, limitMs: lim * 1000 };
//     } else if (t === "kana") {
//       const chars = [...c(4).replace(/\s/g, "")];
//       const dm = [...c(5).replace(/[,，\s]/g, "")];
//       if (dm.length !== chars.length * 3) return err(`ダミー文字数が不一致 (必要 ${chars.length * 3} / 実際 ${dm.length})`);
//       raw = {
//         id,
//         type: "kana",
//         text,
//         ans,
//         intervalMs: 150,
//         startMs: 5000,
//         firstMs: 5000,
//         nextMs: 3000,
//         max: c(7) ? Number(c(7)) : undefined,
//         steps: chars.map((k, j) => ({ correct: k, dummies: dm.slice(j * 3, j * 3 + 3) }))
//       };
//     } else return err(`形式が不正 "${c(0)}"`);
//     const q = cleanQ(raw);
//     if (q) qs.push(q);
//     else err(`内容が不正 (${t})`);
//   });
//   return { qs, errs };
// }
