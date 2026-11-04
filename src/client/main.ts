import { cleanNick, ROOM_ALPHABET, ROOM_ID_RE, type ErrCode, type LogEntry, type Member, type Mode, type ServerMsg, ClientMsg, PublicGame, PublicChoice } from "../shared/types";
import { type Q } from "../shared/quiz";
import { connect } from "./net";
import { initQList, removeQ, addQ } from "./qlist";

const ERR: Record<ErrCode, string> = {
  no_room: "ルームが存在しません",
  exists: "そのRoom IDは使用中です",
  bad_nick: "ニックネームが不正です",
  dup_nick: "同名の参加者がいます",
  bad_msg: "通信エラー"
};

let ws: WebSocket | null = null;
let joined = false;

const LOG_KEEP = 200;
let logRoom = "";
let logs: LogEntry[] = [];
const roster = new Map<string, Member>();
let stepBase = 0,
  winEnd = 0;

let game: PublicGame | null = null;
let me: Member | null = null;
let offset = 0;
const offs: number[] = [];
const now = () => performance.timeOrigin + performance.now();
let myChoice: number | null = null;
let lastQn = -1,
  ansQn = -1,
  ansBase = 0; // ansBase: performance.now() when choices were shown
let kst: Extract<ServerMsg, { type: "kana" }> | null = null;
let ngDelayUntil = 0;
const askedQs: Q[] = [];
let kTyped = "";
let kPending = false;
let streamQn = -1,
  streamBase = 0; // streamBase: performance.now() at stream start
const PHASE: Record<string, string> = {
  ready: "準備中",
  shown: "問題表示中",
  streaming: "表示中",
  closed: "締切",
  revealed: "正解発表"
};
interface View {
  no: string;
  phase: string;
  text: string;
  timer: string;
  foot: string[];
  ratio: number | null;
}

function send(m: ClientMsg) {
  ws?.send(JSON.stringify(m));
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const btn = (id: string) => $<HTMLButtonElement>(id);

const E = {
  room: $<HTMLInputElement>("room"),
  nick: $<HTMLInputElement>("nick"),
  join: $("join"),
  create: $("create"),
  err: $("err"),
  top: $("top"),
  roomView: $("room-view"),
  roomTitle: $("room-title"),
  roleBadge: $("role-badge"),
  log: $("log"),
  question: $("question"),
  hQuestion: $("h-question"),
  choices: $("choices"),
  hChoices: $("h-choices"),
  hProg: $("h-prog"),
  members: $("members"),
  qAsked: $("q-asked"),
  copyLink: $("copy-link"),
  hStart: btn("h-start"),
  hOk: btn("h-ok"),
  hNg: btn("h-ng"),
  hShowQ: btn("h-show-q"),
  hShowC: btn("h-show-c"),
  hReveal: btn("h-reveal"),
  hNext: btn("h-next"),
  // hOx: btn("h-ox"),
  buzz: btn("buzz")
};

const q = new URLSearchParams(location.search).get("room");
if (q) E.room.value = q.toUpperCase();
E.nick.value = localStorage.getItem("nick") ?? "";

$("join").onclick = () => onSubmit("join");
$("create").onclick = () => onSubmit("create");
btn("h-start").onclick = () => send({ type: "start" });
btn("h-ok").onclick = () => send({ type: "judge", ok: true });
btn("h-ng").onclick = () => send({ type: "judge", ok: false });
btn("h-show-q").onclick = () => send({ type: "cmd", cmd: "show" });
btn("h-show-c").onclick = () => send({ type: "cmd", cmd: "choices" });
btn("h-reveal").onclick = () => send({ type: "cmd", cmd: "reveal" });
btn("h-next").onclick = () => {
  const g = game;
  if (g?.phase === "open" && !g.c && !g.answerer && ngDelayUntil > performance.now()) {
    return; // NG delay in free-form
  }
  const c = g?.c;
  if (!g) return;
  const canClose = (g.phase === "open" && (!!g.queue.length || !!g.answerer)) || c?.phase === "answering" || c?.phase === "streaming";
  if (canClose && c) send({ type: "cmd", cmd: "close" });
  else send({ type: "end" });
};
// btn("h-ox").onclick = () => send({
//     type: "ask",
//     q: {
//         id: crypto.randomUUID(),
//         type: "choice",
//         text: "",
//         choices: ["〇", "×"],
//         correct: 0,
//         limitMs: 20000
//     }
// });

try {
  initQList((q: Q) => {
    askedQs.push(q);
    if (q.id) removeQ(q.id);
    send({ type: "ask", q });
  });
} catch (e) {
  console.error("initQList failed", e);
}

function renderAll() {
  renderMembers();
  renderStatus();
  updateButtons();
  renderChoices($("choices"));
  renderChoices($("h-choices"));
  renderAsked();
}

function renderAsked() {
  const el = $("q-asked");
  if (!el) return;
  el.replaceChildren(
    ...askedQs.map((q, idx) => {
      const li = document.createElement("li");
      li.className = "asked-item";
      const span = document.createElement("span");
      span.textContent = q.text || (q.type === "choice" ? q.choices.join("/") : "");
      span.title = span.textContent;

      const b = document.createElement("button");
      b.textContent = "戻す";
      b.className = "ghost";
      b.style.padding = "2px 8px";
      b.style.fontSize = "0.75rem";
      b.style.marginLeft = "auto";
      b.onclick = () => {
        askedQs.splice(idx, 1);
        addQ(q);
        renderAsked();
      };
      li.append(span, b);
      return li;
    })
  );
}

function showTop(msg = "") {
  joined = false;
  game = null;
  me = null;
  roster.clear();
  logRoom = "";
  $("room-view").hidden = true;
  $("top").hidden = false;
  $("err").textContent = msg;
}

function validate(room: string, nick: string, mode: Mode): string | null {
  if ((mode === "join" || room) && !ROOM_ID_RE.test(room)) return "Room IDが不正です";
  if (!cleanNick(nick)) return ERR.bad_nick;
  return null;
}

// persistent device id
function deviceId(): string {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("deviceId", id);
  }
  return id;
}

function genRoomId(): string {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(a, (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join("");
}

function onSubmit(mode: Mode) {
  if (ws) return;
  let room = $<HTMLInputElement>("room").value.trim().toUpperCase();
  const raw = $<HTMLInputElement>("nick").value;
  const err = validate(room, raw, mode);
  $("err").textContent = err ?? "";
  if (err) return;
  if (!room) room = genRoomId();
  const nick = cleanNick(raw)!;
  localStorage.setItem("nick", nick);
  const sock = connect(
    room,
    { type: "hello", mode, id: deviceId(), nick, hostKey: localStorage.getItem(`hostKey:${room}`) ?? undefined },
    (m) => onServerMsg(room, m),
    (e) => {
      if (ws !== sock) return; // closed on purpose
      ws = null;
      if (joined) showTop(e.code === 4000 ? "別の接続に置き換えられました" : "切断されました");
    }
  );
  ws = sock;
}

function leaveRoom() {
  const s = ws;
  ws = null;
  s?.close(1000);
  showTop();
}

// load saved logs for the room and render
function loadLogs(room: string) {
  logRoom = room;
  try {
    logs = JSON.parse(localStorage.getItem(`log:${room}`) ?? "[]");
  } catch {
    logs = [];
  }
  $("log").replaceChildren(...logs.map(logLi));
}

function logLi(e: LogEntry): HTMLLIElement {
  const li = document.createElement("li");
  li.textContent = `${new Date(e.t).toLocaleTimeString()} ${e.type} ${e.nick}`;
  return li;
}

// append, cap, persist (skip persist before room is set)
function addLog(e: LogEntry) {
  logs.push(e);
  if (logs.length > LOG_KEEP) logs.shift();
  if (logRoom) localStorage.setItem(`log:${logRoom}`, JSON.stringify(logs));
  $("log").append(logLi(e));
}

function onServerMsg(room: string, m: ServerMsg) {
  switch (m.type) {
    case "welcome":
      console.log("welcome", m.you.host ? "host" : "player");
      if (m.hostKey) localStorage.setItem(`hostKey:${room}`, m.hostKey);
      joined = true;
      history.pushState({ view: "room" }, "");
      me = m.you;
      game = m.game;
      offs.length = 0;
      $("top").hidden = true;
      $("room-view").hidden = false;
      $("room-view").dataset.role = m.you.host ? "host" : "player";
      $("room-title").textContent = room;
      $("role-badge").textContent = m.you.host ? "出題者" : "参加者";

      roster.clear();
      m.members.forEach((x) => roster.set(x.id, x));
      loadLogs(room);
      syncChoice();
      renderAll();
      addLog({ t: Date.now(), type: "join", nick: m.you.nick });
      send({ type: "ping", t0: now() });
      break;
    case "join":
      roster.set(m.member.id, m.member);
      renderAll();
      addLog({ t: m.t, type: "join", nick: m.member.nick });
      break;
    case "leave":
      roster.delete(m.id);
      renderAll();
      addLog({ t: m.t, type: "leave", nick: m.nick });
      break;
    case "game":
      const oldRes = game?.res;
      game = m.g;
      if (game.res && (!oldRes || oldRes.id !== game.res.id || oldRes.ok !== game.res.ok)) {
        showResultOverlay(game.res.ok);
        if (!game.res.ok && game.phase === "open" && !game.c) {
          // Free-form NG: set 1sec delay
          ngDelayUntil = performance.now() + 1000;
        }
      }
      syncChoice();
      renderAll();
      break;
    case "pong": {
      const t1 = now();
      console.log("rtt", (t1 - m.t0).toFixed(1));
      offs.push(m.ts - (m.t0 + t1) / 2);
      if (offs.length < 5) send({ type: "ping", t0: now() });
      else {
        offs.sort((a, b) => a - b);
        offset = offs[2];
        console.log("offset", offset.toFixed(1));
      }
      break;
    }
    case "kana":
      if (m.qn !== game?.c?.qn) break;
      kst = m;
      kPending = false;
      stepBase = performance.now() - (m.limitMs - m.leftMs);
      renderAll();
      break;
    case "error":
      $("err").textContent = ERR[m.code];
      break;
  }
}

function paint(root: HTMLElement, v: View) {
  const q = (s: string) => root.querySelector<HTMLElement>(s)!;
  q(".q-no").textContent = v.no;
  q(".q-phase").textContent = v.phase;
  q(".q-timer").textContent = v.timer;

  const txt = q(".q-text");
  if (v.text.startsWith("<div")) {
    txt.innerHTML = v.text;
  } else if (txt.textContent !== v.text) {
    txt.textContent = v.text;
  }

  const qf = q(".q-foot");
  const children = qf.children;
  if (v.foot.length !== children.length) {
    qf.innerHTML = "";
    v.foot.forEach((f) => {
      const s = document.createElement("div");
      s.textContent = f;
      s.className = "animate-in";
      qf.append(s);
    });
  } else {
    v.foot.forEach((f, i) => {
      const s = children[i] as HTMLElement;
      if (s.textContent !== f) s.textContent = f;
    });
  }
  const bar = q(".bar");
  bar.hidden = v.ratio === null;
  if (v.ratio !== null) q(".bar i").style.width = `${Math.max(0, Math.min(1, v.ratio)) * 100}%`;
}

function showResultOverlay(ok: boolean) {
  const res = document.createElement("div");
  res.className = `big-result ${ok ? "ok" : "ng"}`;
  res.textContent = ok ? "◎" : "×";
  document.body.append(res);
  setTimeout(() => {
    res.style.opacity = "0";
    res.style.transition = "opacity 0.3s";
    setTimeout(() => res.remove(), 300);
  }, 1200);
}

function renderStatus() {
  const g = game;
  if (!g) return;
  const c = g.c;
  const v: View = { no: g.n ? `Q${g.n}` : "", phase: "", text: "", timer: "", foot: [], ratio: null };
  const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);
  if (c) {
    const kindName = c.kind === "choice" ? "4択クイズ" : c.kind === "kana" ? "文字入力クイズ" : "早押しクイズ";
    const rules = [];
    // if (c.kind === "kana" && c.max) rules.push(`先着${c.max}名`);

    // v.foot.push(`${kindName}${rules.length ? ` (${rules.join(", ")})` : ""}`);
    v.foot.push(kindName);
    if (c.kind === "kana" && c.max) {
      const used = Object.keys(c.ks ?? {}).length;
      v.foot.push(`回答枠 ${Math.min(used, c.max)}/${c.max}${used >= c.max ? "  満員" : ""}`);
    }

    v.text = shownText(c) ?? "";
    const mine = c.kind === "kana" && me && !me.host && kst?.qn === c.qn ? kst : null;
    if (c.kind === "choice" && c.phase === "answering") {
      const left = c.limitMs - (performance.now() - ansBase);
      v.phase = "回答中";
      v.timer = sec(left);
      v.ratio = left / c.limitMs;
    } else if (mine?.state === "play") {
      const left = mine.limitMs - (performance.now() - stepBase);
      v.phase = "回答中";
      v.timer = sec(left);
      v.ratio = left / mine.limitMs;
    } else if (c.kind === "kana" && c.phase === "answering") {
      v.phase = "回答受付";
      v.timer = sec(winEnd - performance.now());
    } else v.phase = PHASE[c.phase] ?? "";
    if (mine) v.foot.push(`入力 ${kTyped || "–"}  (${mine.step}/${mine.total})${mine.state === "done" ? "  完了" : mine.state === "fail" ? "  不正解" : ""}`);
    if (c.phase === "revealed" && me && !me.host) {
      const r = c.results?.[me.id];
      // v.foot.push(r ? (r.ok ? `正解  ${(r.ms / 1000).toFixed(2)}s` : "不正解") : "未回答");
      const oks = Object.values(c.results ?? {})
        .filter((x) => x.ok)
        .map((x) => x.ms);
      const best = oks.length ? Math.min(...oks) : 0;
      const gap = r?.ok ? (r.ms > best ? `  (+${((r.ms - best) / 1000).toFixed(2)}s)` : "  1位") : "";
      v.foot.push(r ? (r.ok ? `正解  ${(r.ms / 1000).toFixed(2)}s${gap}` : "不正解") : "未回答");
    }
    if (c.answer) v.foot.push(`正解  ${c.answer}`);
  } else {
    const m = g.answerer ? roster.get(g.answerer) : null;
    v.phase = g.n === 0 ? "待機中" : g.phase === "idle" ? "終了" : m ? `回答中` : "出題中";
    if (m) v.text = `回答中 : <div class="big-name animate-in">${m.nick}</div>`;
    if (me?.host && g.fq) {
      if (g.fq.text) v.foot.push(`問題  ${g.fq.text}`);
      if (g.fq.answer) v.foot.push(`答え  ${g.fq.answer}`);
    }

    // NG delay visual in status
    const now = performance.now();
    if (g.phase === "open" && !g.answerer && ngDelayUntil > now) {
      v.phase = "ボタン復活待ち";
      const left = ngDelayUntil - now;
      v.timer = sec(left);
      v.ratio = left / 1000;
    }
  }

  if (me?.host) renderProg($("h-prog"), c, true);
  else renderProg($("p-prog"), c, false);
  // if (me?.host && c && (c.phase === "answering" || c.phase === "streaming" || c.phase === "closed")) {
  //   const players = [...roster.values()].filter((m) => !m.host);
  //   const lines = players
  //     .map((p) => {
  //       const k = c.ks?.[p.id];
  //       if (!k) return "";
  //       const state = k.s,
  //         pVal = k.p,
  //         total = k.total;
  //       if (c.kind === "kana") {
  //         return `<div class="prog-row"><div class="prog-nick">${p.nick}</div><div class="prog-text ${state}">${k.v || "–"}</div><div class="prog-val">${pVal}/${total}</div></div>`;
  //       }
  //       return ""; // No bar for non-kana or if bar is not requested
  //     })
  //     .filter(Boolean);
  //   if (lines.length) {
  //     hp.innerHTML = lines.join("");
  //     hp.hidden = false;
  //   } else hp.hidden = true;
  // } else hp.hidden = true;

  paint($("question"), v);
  const players = [...roster.values()].filter((m) => !m.host).length;
  const started = Object.keys(c?.ks ?? {}).length;
  const extra = c?.kind === "kana" && (c.phase === "streaming" || c.phase === "answering") ? `回答開始 ${started}/${players}  完了 ${c.answered.length}` : c?.phase === "answering" ? `回答 ${c.answered.length}/${players}` : "";
  paint($("h-question"), { ...v, foot: extra ? [...v.foot, extra] : v.foot });
}

const STATE_JA: Record<string, string> = { play: "回答中", done: "完了", fail: "不正解" };
function renderProg(el: HTMLElement, c: PublicChoice | null, host: boolean) {
  const full = !!c && c.max !== undefined && Object.keys(c.ks ?? {}).length >= c.max;
  const ph = ["streaming", "answering", "closed", "revealed"];
  if (!c || c.kind !== "kana" || !ph.includes(c.phase) || !(host || full)) {
    el.hidden = true;
    return;
  }
  const rows: HTMLElement[] = [];
  for (const p of roster.values()) {
    const k = c.ks?.[p.id];
    if (p.host || !k) continue;
    const row = document.createElement("div");
    row.className = "prog-row";
    const n = document.createElement("div");
    n.className = "prog-nick";
    n.textContent = p.nick;
    const t = document.createElement("div");
    t.className = `prog-text ${k.s}`;
    t.textContent = host ? k.v || "–" : STATE_JA[k.s];
    const v = document.createElement("div");
    v.className = "prog-val";
    v.textContent = `${k.p}/${k.total}`;
    row.append(n, t, v);
    rows.push(row);
  }
  el.replaceChildren(...rows);
  el.hidden = rows.length === 0;
}

const mk = (cls: string, text = "") => {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
};

function renderMembers() {
  const g = game,
    c = g?.c;
  const pts = (id: string) => g?.pts[id] ?? 0;
  const ms = (id: string) => g?.ms[id] ?? 0;
  const all = [...roster.values()];
  const players = all.filter((m) => !m.host).sort((a, b) => pts(b.id) - pts(a.id) || ms(a.id) - ms(b.id));
  const rows: HTMLElement[] = all
    .filter((m) => m.host)
    .map((m) => {
      const li = document.createElement("li");
      li.className = "row host";
      li.textContent = `出題者  ${m.nick}`;
      return li;
    });
  let rank = 0,
    prev = "";
  const topMs = players.length ? ms(players[0].id) : 0;
  players.forEach((m, i) => {
    const k = `${pts(m.id)}:${ms(m.id)}`;
    if (k !== prev) {
      rank = i + 1;
      prev = k;
    }
    const ks = c?.kind === "kana" ? c.ks?.[m.id] : undefined;
    const st = ks ? ks.s : c?.phase === "answering" && c.answered.includes(m.id) ? "done" : undefined;
    const qi = g?.queue.indexOf(m.id) ?? -1;
    const active = g?.answerer === m.id || st === "play";
    const dif = i > 0 && topMs && ms(m.id) ? ms(m.id) - topMs : 0;
    const gap = dif ? ` (${dif > 0 ? "+" : "-"}${(Math.abs(dif) / 1000).toFixed(2)}s)` : "";
    const sub = [ms(m.id) ? `${(ms(m.id) / 1000).toFixed(2)}s${gap}` : "", qi >= 0 ? `待機 ${qi + 1}` : ""].filter(Boolean).join("  ");
    const nick = mk("nick", m.nick);
    if (sub) {
      const s = document.createElement("small");
      s.textContent = sub;
      nick.append(s);
    }
    const li = document.createElement("li");
    li.className = "row" + (me?.id === m.id ? " me" : "") + (active ? " active" : "");
    li.append(mk("rank", String(rank)), nick, mk("mark", active ? "▶" : st === "done" ? "✓" : st === "fail" ? "✗" : ""), mk("pts", String(pts(m.id))));
    rows.push(li);
  });
  $("members").replaceChildren(...rows);
}

setInterval(() => {
  const p = game?.c?.phase;
  if (p === "answering" || p === "streaming" || ngDelayUntil > performance.now() - 100) renderAll();
}, 50);

function renderChoices(el: HTMLElement) {
  const c = game?.c;
  if (c?.kind === "kana") {
    renderKeys(el);
    return;
  }
  const choices = c?.choices;
  if (!c || !choices) {
    el.replaceChildren();
    return;
  }

  const isOx = choices.length === 2 && choices.includes("〇") && choices.includes("×");
  const children = Array.from(el.children) as HTMLButtonElement[];

  // If number of choices changed, replace all
  if (children.length !== choices.length) {
    el.replaceChildren(
      ...choices.map((_, i) => {
        const b = document.createElement("button");
        b.className = "choice";
        b.dataset.i = String(i);
        return b;
      })
    );
  }

  (Array.from(el.children) as HTMLButtonElement[]).forEach((b, i) => {
    const label = choices[i];
    const count = c.counts ? `(${c.counts[i]}) ` : "";
    const text = `${count}${i + 1}. ${label}`;
    if (b.textContent !== text) b.textContent = text;

    b.classList.toggle("mine", myChoice === i);
    b.classList.toggle("ok", c.correct === i);
    b.classList.toggle("ng", c.phase === "revealed" && myChoice === i && c.correct !== i);
    b.dataset.ox = isOx ? "true" : "false";
  });
}

// kana keys (player panel only)
function renderKeys(el: HTMLElement) {
  const c = game?.c;
  const playing = (c?.phase === "streaming" || c?.phase === "answering") && kst?.qn === c.qn && kst.state === "play";

  if (!playing || el.id !== "choices") {
    el.replaceChildren();
    return;
  }
  el.replaceChildren(
    ...kst!.keys.map((k, i) => {
      const b = document.createElement("button");
      b.className = "choice key";
      b.dataset.k = k;
      b.textContent = `${i + 1}. ${k}`;
      return b;
    })
  );
}

// one key press; d = local ms since answering started
function pickKey(k: string, e: Event) {
  const c = game?.c;
  if (!c || c.kind !== "kana" || (c.phase !== "streaming" && c.phase !== "answering") || !kst || kst.qn !== c.qn || kst.state !== "play" || kPending) return;
  const d = e.timeStamp - stepBase;
  if (d > kst.limitMs) return;
  kPending = true;
  kTyped += k;
  send({ type: "key", step: kst.step, key: k, d });
  renderAll();
}

function updateButtons() {
  const g = game;
  if (!g || !me) return;
  const c = g.c;
  if (me.host) {
    btn("buzz").disabled = true;

    // 1. 自由形式
    const isFree = g.phase === "open" && !c;
    btn("h-start").disabled = !!c || isFree;
    // btn("h-ox").disabled = !!c || isFree;
    btn("h-start").textContent = g.n === 0 ? "自由早押し開始" : "自由形式で次へ";

    // 2. 判定
    btn("h-ok").disabled = !g.answerer;
    btn("h-ng").disabled = !g.answerer;

    // 3. クイズ進行
    btn("h-show-q").disabled = c?.phase !== "ready";

    const canShowChoices = c?.phase === "ready" || c?.phase === "shown" || c?.phase === "streaming";
    btn("h-show-c").disabled = !canShowChoices;
    btn("h-show-c").textContent = c?.kind === "kana" ? "回答へスキップ" : "選択肢を表示";

    btn("h-reveal").disabled = c?.phase !== "closed";

    // 4. 締切・終了
    const canClose = (g.phase === "open" && !!g.queue.length) || (g.phase === "open" && !!g.answerer) || c?.phase === "answering" || c?.phase === "streaming";
    const canEnd = c?.phase === "revealed" || (g.phase === "idle" && g.n > 0) || (g.phase === "open" && !g.answerer && !g.queue.length);

    btn("h-next").disabled = !canClose && !canEnd;
    btn("h-next").textContent = canClose ? "回答を締切" : "問題を終了";
  } else {
    const now = performance.now();
    const kana = c?.kind === "kana" && (c.phase === "streaming" || c.phase === "answering");
    const inNgDelay = !c && ngDelayUntil > now;
    if (kana) btn("buzz").disabled = me.id in (c!.ks ?? {}) || (c!.max !== undefined && Object.keys(c!.ks ?? {}).length >= c!.max);
    else btn("buzz").disabled = inNgDelay || !!g.answerer || !(g.phase === "open" && g.answerer !== me.id && !g.locked.includes(me.id) && !g.queue.includes(me.id));

    // NG delay visual
    const b = btn("buzz");
    let cd = b.querySelector(".buzz-cooldown") as HTMLElement;
    if (inNgDelay) {
      if (!cd) {
        cd = document.createElement("div");
        cd.className = "buzz-cooldown";
        const duration = Math.round(ngDelayUntil - now);
        cd.style.animation = `buzzCooldown ${duration}ms linear forwards`;
        b.append(cd);
      }
    } else {
      if (cd) cd.remove();
    }
  }
}

// sync per-question local state (call before renderAll on welcome/game)
function syncChoice() {
  const c = game?.c;
  if (!c) {
    myChoice = null;
    ansQn = -1;
    lastQn = -1;
    kst = null;
    kTyped = "";
    kPending = false;
    return;
  }
  if (c.qn !== lastQn) {
    lastQn = c.qn;
    myChoice = null;
    kst = null;
    kTyped = "";
    kPending = false;
  }
  if (c.phase === "streaming" && streamQn !== c.qn) {
    streamQn = c.qn;
    streamBase = performance.now() - (c.sMs ?? 0);
  }
  if (c.phase === "answering" && ansQn !== c.qn) {
    ansQn = c.qn;
    ansBase = performance.now() - (c.limitMs - c.leftMs);
  }
  if (c.kind === "kana" && c.phase === "answering") winEnd = performance.now() + (c.startLeftMs ?? 0);
}

function shownText(c: PublicChoice): string | undefined {
  if (!c.text) return undefined;
  const chars = Array.from(c.text);
  let n = c.phase !== "streaming" ? chars.length : Math.min(chars.length, Math.max(0, Math.floor((performance.now() - streamBase) / (c.intervalMs ?? 100))));
  if (c.kind === "kana" && me && !me.host && kst?.qn === c.qn) {
    if (kst.state === "play") n = Math.min(kst.pos, chars.length);
    else if (kst.state === "done") n = chars.length;
  }
  return chars.slice(0, n).join("");
}

function pick(i: number, e: Event) {
  const c = game?.c;
  if (!c || !me || c.kind !== "choice") return;
  if (me.host) {
    if (c.phase === "closed") send({ type: "cmd", cmd: "reveal", correct: i });
    return;
  }
  if (c.phase !== "answering" || myChoice !== null || c.answered.includes(me.id)) return;
  const d = e.timeStamp - ansBase;
  if (d > c.limitMs) return;
  myChoice = i;
  send({ type: "answer", choice: i, d });
  renderAll();
}

$("choices").addEventListener("pointerdown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".choice");
  if (!el) return;
  if (el.dataset.k !== undefined) pickKey(el.dataset.k, e);
  else if (el.dataset.i !== undefined) pick(Number(el.dataset.i), e);
});
$("h-choices").addEventListener("pointerdown", (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(".choice");
  if (!el || el.dataset.i === undefined) return;
  pick(Number(el.dataset.i), e);
});

// buzz via pointer or Space; time converted to server clock
function onBuzz(e: Event) {
  if (btn("buzz").disabled) return;
  const c = game?.c;
  if (c?.kind === "kana") {
    const n = Array.from(c.text ?? "").length;
    const pos = c.phase === "streaming" ? Math.min(n, Math.max(0, Math.floor((e.timeStamp - streamBase) / (c.intervalMs ?? 100)))) : n;
    send({ type: "press", pos });
  } else send({ type: "buzz", at: performance.timeOrigin + e.timeStamp + offset });
  btn("buzz").disabled = true;
}

btn("buzz").addEventListener("pointerdown", onBuzz);
window.addEventListener("keydown", (e) => {
  if (e.repeat || (e.target as HTMLElement).closest("input, textarea, select")) return;
  const m = /^Digit([1-9])$/.exec(e.code);
  if (m) {
    const i = Number(m[1]) - 1;
    if (game?.c?.kind === "kana") {
      const k = kst?.keys[i];
      if (k) pickKey(k, e);
    } else pick(i, e);
    return;
  }

  if (e.code === "Space") {
    e.preventDefault();
    onBuzz(e);
  }
});

window.addEventListener("popstate", () => {
  if (joined) leaveRoom();
});

$("copy-link").onclick = async () => {
  const url = `${location.origin}/?room=${$("room-title").textContent}`;
  try {
    await navigator.clipboard.writeText(url);
    $("copy-link").textContent = "コピーしました";
    setTimeout(() => ($("copy-link").textContent = "リンクをコピー"), 1500);
  } catch {
    prompt("招待URL", url);
  }
};
