export type Slots =
  | { kind: "multi"; max: number } // first N buzzers may answer
  | { kind: "single" }             // one at a time, no queue
  | { kind: "queue" };             // one at a time, in press order

export type TextReveal =
  | { kind: "none" }                        // no text (oral only)
  | { kind: "manual" }                      // host shows it after reading
  | { kind: "stream"; intervalMs: number }; // online, one char at a time

interface QBase {
  id: string;                      // auto "q1".. if omitted on import
  text?: string;                   // omit for oral-only questions
  reveal?: TextReveal;   // default: text ? { kind: "manual" } : { kind: "none" }
  limitMs?: number;      // answer time limit (mode "all")
  note?: string;                   // host-only memo
  mode?: "buzz" | "all";           // buzz: answer right by press / all: everyone answers
  slots?: Slots;                   // overrides quiz/room default (buzz only)
}
export interface KanaStep { correct: string; dummies: [string, string, string] }

export type Question =
  | (QBase & { type: "oral"; answer?: string })                  // host judges
  | (QBase & { type: "choice"; choices: string[]; correct: number })
  | (QBase & { type: "kana"; steps: KanaStep[] })             // answer = steps' correct joined
  | (QBase & { type: "input"; answers: string[] });  // accepted answers (auto-match)

export interface QuizSet { title?: string; slots?: Slots; questions: Question[] }

// sent to players (no answers)
interface PBase { id: string; text?: string; mode: "buzz" | "all" }
export type PublicQuestion =
  | (PBase & { type: "oral" })
  | (PBase & { type: "choice"; choices: string[] })
  | (PBase & { type: "kana"; length: number });                  // keys are sent per step by the DO

// default mode (assumption: oral=buzz, choice/kana=all)
export function modeOf(q: Question): "buzz" | "all" {
  return q.mode ?? (q.type === "oral" ? "buzz" : "all");
}

// strip answers
export function toPublic(q: Question): PublicQuestion {
  const b = { id: q.id, text: q.text, mode: modeOf(q) };
  switch (q.type) {
    case "oral": return { ...b, type: "oral" };
    case "choice": return { ...b, type: "choice", choices: q.choices };
    case "kana": return { ...b, type: "kana", length: q.steps.length };
    default: return { ...b, type: "oral" };
  }
}

export type Q = ChoiceQ | KanaQ;
export function cleanQ(x: unknown): Q | null {
  const t = (x as { type?: unknown } | null)?.type;
  return t === "kana" ? cleanKanaQ(x) : t === "choice" ? cleanChoiceQ(x) : null;
}

export interface ChoiceQ { id: string; type: "choice"; text?: string; choices: string[]; correct: number; limitMs: number }

export function cleanChoiceQ(x: unknown): ChoiceQ | null {
  const q = x as Partial<ChoiceQ> | null;
  if (!q || typeof q.id !== "string" || !Array.isArray(q.choices)) return null;
  const cs = q.choices;
  if (cs.length < 2 || cs.length > 6 || cs.some((s) => typeof s !== "string" || !s.trim() || s.length > 100)) return null;
  if (!Number.isInteger(q.correct) || q.correct! < 0 || q.correct! >= cs.length) return null;
  if (!Number.isInteger(q.limitMs) || q.limitMs! < 1000 || q.limitMs! > 600000) return null;
  const text = typeof q.text === "string" ? q.text.trim().slice(0, 500) : "";
  return { id: q.id.slice(0, 64), type: "choice", text: text || undefined, choices: cs.map((s) => s.trim()), correct: q.correct!, limitMs: q.limitMs! };
}

export interface KanaStep { correct: string; dummies: [string, string, string] }
export interface KanaQ { id: string; type: "kana"; text: string; intervalMs: number; steps: KanaStep[]; limitMs: number }
const one = (s: unknown): s is string => typeof s === "string" && [...s].length === 1 && !/\s/.test(s);

export interface KanaQ {
  id: string; type: "kana"; text: string; intervalMs: number;
  startMs: number; firstMs: number; nextMs: number; max?: number; // max answerers (undefined = unlimited)
  steps: KanaStep[];
}



export function cleanKanaQ(x: unknown): KanaQ | null {
  const q = x as Partial<KanaQ> | null;
  if (!q || typeof q.id !== "string" || typeof q.text !== "string" || !Array.isArray(q.steps)) return null;
  const text = q.text.trim().slice(0, 500);
  if (!text) return null;
  const ms = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
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
  return { id: q.id.slice(0, 64), type: "kana", text, intervalMs: q.intervalMs, startMs: q.startMs, firstMs: q.firstMs, nextMs: q.nextMs, max: q.max, steps,limitMs: q.limitMs ?? 3000 };
}