import type {Q} from "./quiz";

export const ROOM_ID_RE = /^[A-Z0-9]{4,8}$/;
export const ROOM_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const NICK_MAX = 12;

export type Mode = "create" | "join";

export interface Member {
  id: string;
  nick: string;
  host: boolean
}

export interface LogEntry {
  t: number;
  type: "join" | "leave";
  nick: string
}

export type ErrCode = "no_room" | "exists" | "bad_nick" | "dup_nick" | "bad_msg";

export interface PublicGame {
  n: number;
  phase: "idle" | "open";
  T: number;
  answerer: string | null;
  queue: string[];
  locked: string[];
  ms: Record<string, number>;
  c: PublicChoice | null;
  res: { id: string; ok: boolean } | null;
  fq: { text?: string; answer?: string } | null; // free question (host only)
  order: string[]; // press order (scoreboard pin)
  pts: Record<string, number>; // correct count (tiebreak)
  sc: Record<string, number>;  // score
}

export type ClientMsg =
  | { type: "hello"; mode: Mode; id: string; nick: string; hostKey?: string }
  | { type: "ping"; t0: number }
  | { type: "start" }
  | { type: "end" }
  | { type: "buzz"; at: number }
  | { type: "judge"; ok: boolean; score?: number }
  | { type: "ask"; q: Q }
  | { type: "cmd"; cmd: "show" | "choices" | "close" | "reveal"; correct?: number }
  | { type: "answer"; choice: number; d: number }
  | { type: "key"; step: number; key: string; d: number }
  | { type: "press"; pos: number }
export type HelloMsg = Extract<ClientMsg, { type: "hello" }>;
export type ServerMsg =
  | { type: "welcome"; you: Member; members: Member[]; game: PublicGame; hostKey?: string }
  | { type: "join"; member: Member; t: number }
  | { type: "leave"; id: string; nick: string; t: number }
  | { type: "game"; g: PublicGame }
  | { type: "pong"; t0: number; ts: number }
  | { type: "error"; code: ErrCode }
  | { type: "kana"; qn: number; step: number; total: number; keys: string[]; state: "play" | "done" | "fail"; pos: number; limitMs: number; leftMs: number }

// normalize/validate nickname (full-width OK; length by code points)
export function cleanNick(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const n = s.normalize("NFC").trim();
  const len = [...n].length;
  if (len < 1 || len > NICK_MAX || /\p{Cc}/u.test(n)) return null;
  return n;
}

export interface PublicChoice {
  qn: number; kind: "choice" | "kana";
  phase: "ready" | "shown" | "streaming" | "answering" | "closed" | "revealed";
  text?: string; choices?: string[];
  intervalMs?: number; sMs?: number; total?: number; // kana
  limitMs: number; leftMs: number;
  answered: string[];
  counts?: number[]; correct?: number; answer?: string;
  results?: Record<string, { ok: boolean; ms: number; sc?: number }>;
  startLeftMs?: number; max?: number; ks?: Record<string, { s: "play" | "done" | "fail"; p: number; total: number; v?: string }>;
}