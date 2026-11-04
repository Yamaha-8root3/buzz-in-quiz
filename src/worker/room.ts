import {DurableObject} from "cloudflare:workers";
import {
  cleanNick,
  type ClientMsg,
  type ErrCode,
  type LogEntry,
  type Member,
  PublicChoice,
  type ServerMsg
} from "../shared/types";
import * as G from "./game";
import type {HelloMsg, PublicGame} from "../shared/types";
import { cleanQ, cleanScore } from "../shared/quiz";

const BUZZ_WINDOW_MS = 150;

interface Meta {
  hostKey: string;
  createdAt: number;
}

export class Room extends DurableObject<Env> {
  private g!: G.Game;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private async onWindow() {
    this.timer = null;
    G.grant(this.g);
    await this.commit();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private ctimer: ReturnType<typeof setTimeout> | null = null;

  private async commit() {
    const players = this.members().filter((x) => !x.host).length;
    const {failed} = G.sweep(this.g, Date.now(), players);
    for (const id of failed) this.sendKanaTo(id);
    await this.save();
    for (const s of this.sockets()) {
      this.send(s.ws, {type: "game", g: this.pub(s.me)});
    }
  }

  private async save() {
    await this.ctx.storage.put("game", this.g);
    this.schedule();
  }

  // one timer for the nearest self-driven change
  private schedule() {
    this.clearCTimer();
    const due = G.nextDue(this.g);
    if (due === null) return;
    this.ctimer = setTimeout(() => void this.onTick(), Math.max(0, due - Date.now()) + 5);
  }

  private async onTick() {
    this.ctimer = null;
    await this.commit();
  }

  private pub(me: Member): PublicGame {
    const g = this.g;
    return {
      n: g.n,
      phase: g.phase,
      T: g.T,
      answerer: g.answerer,
      queue: g.queue.map((b) => b.id),
      locked: g.locked,
      pts: g.pts,
      sc: g.sc,
      ms: g.ms,
      c: this.pubC(me),
      res: g.res,
      fq: me.host && g.fq ? {text: g.fq.text, answer: g.fq.ans} : null,
      order: g.order.map((b) => b.id)
    };
  }

  private clearCTimer() {
    if (this.ctimer) clearTimeout(this.ctimer);
    this.ctimer = null;
  }

  private sendKana(ws: WebSocket, p: G.KProg) {
    const r = this.g.c;
    if (!r || r.q.type !== "kana") return;
    this.send(ws, {
      type: "kana",
      qn: this.g.n,
      step: p.step,
      total: r.q.steps.length,
      keys: p.state === "play" ? p.keys : [],
      state: p.state,
      pos: p.pos,
      limitMs: p.step === 0 ? r.q.firstMs : r.q.nextMs,
      leftMs: p.state === "play" ? Math.max(0, p.due - Date.now()) : 0
    });
  }

  private sendKanaTo(id: string) {
    const s = this.sockets().find((x) => x.me.id === id);
    const p = G.progOf(this.g, id);
    if (s && p) this.sendKana(s.ws, p);
  }

  private sendKanaAll() {
    for (const id of Object.keys(this.g.c?.prog ?? {})) this.sendKanaTo(id);
  }

  private pubC(me: Member): PublicChoice | null {
    const r = this.g.c;
    if (!r) return null;
    const q = r.q;
    const done = r.phase === "closed" || r.phase === "revealed";
    const full = q.type === "kana" && q.max !== undefined && Object.keys(r.prog).length >= q.max;
    const text = q.type === "kana" && r.stopPos !== undefined && r.phase !== "revealed" ? Array.from(q.text).slice(0, r.stopPos).join("") : q.text;
    const seeV = me.host || r.phase === "revealed" || (full && !(me.id in r.prog));
    const counts = q.type === "choice" ? (r.phase === "answering" ? q.choices.map((_, i) => Object.values(r.answers).filter((a) => a.choice === i).length) : r.counts) : undefined;

    return {
      qn: this.g.n,
      kind: q.type,
      phase: r.phase,
      text: r.phase !== "ready" ? text : undefined,
      choices: q.type === "choice" && (r.phase === "answering" || done) ? q.choices : undefined,
      intervalMs: q.type === "kana" ? q.intervalMs : undefined,
      sMs: r.phase === "streaming" ? Date.now() - r.tStream : undefined,
      total: q.type === "kana" ? q.steps.length : undefined,
      limitMs: q.type === "choice" ? q.limitMs : 0,
      leftMs: q.type === "choice" && r.phase === "answering" ? Math.max(0, r.deadline - Date.now()) : 0,
      startLeftMs: q.type === "kana" && r.phase === "answering" ? Math.max(0, r.deadline - Date.now()) : undefined,
      max: q.type === "kana" ? q.max : undefined,
      ks: q.type === "kana" ? Object.fromEntries(Object.entries(r.prog).map(([id, p]) => [id, {
        s: p.state,
        p: p.step,
        total: q.steps.length,
        v: seeV ? p.cur : undefined
      }])) : undefined,
      answered:
        q.type === "kana"
          ? Object.entries(r.prog)
            .filter(([, p]) => p.state !== "play")
            .map(([id]) => id)
          : Object.keys(r.answers),
      counts: q.type === "choice" && (done || me.host) ? counts : undefined,
      correct: q.type === "choice" && (r.phase === "revealed" || me.host) ? q.correct : undefined,
      answer: r.phase === "revealed" ? (q.ans ?? (q.type === "kana" ? q.steps.map((s) => s.correct).join("") : undefined)) : undefined,
      results: r.phase === "revealed" ? r.results : undefined
    };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.g = (await ctx.storage.get<G.Game>("game")) ?? G.initGame();
      this.g.c ??= null;
      this.g.ms ??= {};
      this.g.fq ??= null;
      this.g.sc ??= {};
      this.g.order ??= [];
      const c = this.g.c;
      if (c) {
        if (c.q.type === "kana" && (c.q as { startMs?: number }).startMs === undefined)
          this.g.c = null; // old kana shape
        else {
          c.prog ??= {};
          c.answers ??= {};
          c.results ??= {};
          c.counts ??= [];
          c.tStream ??= 0;
        }
      }
      this.schedule();
    });
  }

  // accept WS (Hibernation API); attachment = Member | null (null = not joined)
  async fetch(_req: Request): Promise<Response> {
    const {0: client, 1: server} = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(null);
    return new Response(null, {status: 101, webSocket: client});
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let m: ClientMsg;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.fail(ws, "bad_msg");
    }
    const me = ws.deserializeAttachment() as Member | null;
    if (m.type === "hello") {
      if (!me) await this.hello(ws, m);
      return;
    }
    if (!me) return;
    const now = Date.now();
    switch (m.type) {
      case "ping":
        this.send(ws, {type: "pong", t0: m.t0, ts: now});
        return;
      case "start":
        if (!me.host) return;
        this.clearTimer();
        G.start(this.g, now);
        this.clearCTimer();
        break;
      case "end":
        if (!me.host) return;
        this.clearTimer();
        G.end(this.g);
        this.clearCTimer();
        break;
      case "judge":
        if (!me.host) return;
        G.judge(this.g, m.ok, cleanScore(m.score));
        break;
      case "ask": {
        if (!me.host) return;
        const q = cleanQ(m.q);
        if (!q) return;
        this.clearTimer();
        this.clearCTimer();
        if (q.type === "free") {
          G.askFree(this.g, q, now);
          break;
        }

        const isOx = q.type === "choice" && q.choices.length === 2 && ((q.choices[0] === "〇" && q.choices[1] === "×") || (q.choices[0] === "×" && q.choices[1] === "〇"));
        if (q.type === "choice" && !isOx) {
          const indices = q.choices.map((_, i) => i);
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          const oldCorrect = q.correct;
          q.choices = indices.map((i) => q.choices[i]);
          q.correct = indices.indexOf(oldCorrect);
        }
        this.clearCTimer();

        G.ask(this.g, q);
        break;
      }
      case "cmd":
        if (!me.host || !G.cmd(this.g, m.cmd, now)) return;
        if (m.cmd === "close") this.sendKanaAll();
        break;
      case "answer":
        if (me.host || !G.answer(this.g, me.id, m.choice, m.d, now)) return;
        break;
      case "press": {
        if (me.host) return;
        const p = G.press(this.g, me.id, m.pos, now);
        if (!p) {
          this.send(ws, { type: "game", g: this.pub(me) }); // rejected: resync
          return;
        }
        this.sendKana(ws, p);
        break;
      }
      case "key": {
        if (me.host || typeof m.key !== "string" || !Number.isInteger(m.step)) return;
        const p = G.key(this.g, me.id, m.step, m.key, m.d, now);
        if (!p) return;
        this.sendKana(ws, p);
        // if (p.state === "play") { await this.save(); return; } // no broadcast per step
        break;
      }
      case "buzz": {
        if (me.host || typeof m.at !== "number") return;
        const at = Math.min(Math.max(m.at, this.g.T), now); // clamp to [T, now]
        if (!G.buzz(this.g, me.id, at)) return;
        if (!this.g.c) {
          G.grant(this.g);
        } else if (!this.g.answerer && !this.timer) {
          this.timer = setTimeout(() => void this.onWindow(), BUZZ_WINDOW_MS);
        }
        break;
      }
      default:
        return;
    }
    await this.commit();
  }

  async webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
    }
    await this.leave(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.leave(ws);
  }

  // create/join handshake
  private async hello(ws: WebSocket, m: HelloMsg) {
    const nick = cleanNick(m.nick);
    if (!nick) return this.fail(ws, "bad_nick");
    if (typeof m.id !== "string" || m.id.length > 64) return this.fail(ws, "bad_msg");

    let meta = await this.ctx.storage.get<Meta>("meta");
    let newHostKey: string | undefined;
    if (m.mode === "create") {
      if (meta) return this.fail(ws, "exists");
      meta = {hostKey: crypto.randomUUID(), createdAt: Date.now()};
      await this.ctx.storage.put("meta", meta);
      newHostKey = meta.hostKey;
    } else if (!meta) return this.fail(ws, "no_room");

    const others = this.sockets().filter((s) => s.ws !== ws);
    if (others.some((s) => s.me.id !== m.id && s.me.nick === nick)) return this.fail(ws, "dup_nick");

    const old = others.filter((s) => s.me.id === m.id); // same device reconnect
    for (const s of old) {
      s.ws.serializeAttachment(null);
      s.ws.close(4000, "replaced");
    }

    const you: Member = {id: m.id, nick, host: m.mode === "create" || m.hostKey === meta.hostKey};
    ws.serializeAttachment(you);
    this.send(ws, {type: "welcome", you, members: this.members(), game: this.pub(you), hostKey: newHostKey});
    if (!you.host) {
      const p = G.progOf(this.g, you.id);
      if (p) this.sendKana(ws, p);
    }
    if (old.length === 0) this.broadcast({type: "join", member: you, t: Date.now()}, ws);
  }

  private async leave(ws: WebSocket) {
    const me = ws.deserializeAttachment() as Member | null;
    if (!me) return;
    ws.serializeAttachment(null);
    if (this.sockets().some((s) => s.me.id === me.id)) return;
    this.broadcast({type: "leave", id: me.id, nick: me.nick, t: Date.now()});
    G.drop(this.g, me.id);
    await this.commit();
  }

  private sockets() {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ws, me: ws.deserializeAttachment() as Member | null}))
      .filter((s): s is { ws: WebSocket; me: Member } => s.me !== null);
  }

  private members(): Member[] {
    return this.sockets().map((s) => s.me);
  }

  private send(ws: WebSocket, m: ServerMsg) {
    try {
      ws.send(JSON.stringify(m));
    } catch {
    }
  }

  private broadcast(m: ServerMsg, except?: WebSocket) {
    for (const s of this.sockets()) if (s.ws !== except) this.send(s.ws, m);
  }

  private fail(ws: WebSocket, code: ErrCode) {
    this.send(ws, {type: "error", code});
    ws.close(4001, code);
  }
}
