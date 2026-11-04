// src/client/qlist.ts : replace whole file
import { cleanQ, csvToQs, type Q } from "../shared/quiz";

const KEY = "qlist";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let list: Q[] = [];
let editing: string | null = null;
let onAsk: (q: Q) => void = () => {};

function load(): Q[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}
function save() {
  localStorage.setItem(KEY, JSON.stringify(list));
}
function mk(t: string, f: () => void) {
  const b = document.createElement("button");
  b.textContent = t;
  b.onclick = f;
  return b;
}

// render rows with ask / edit / delete
function render() {
  $("qlist").replaceChildren(
    ...list.map((q) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = { kana: "[半] ", choice: "[選] ", free: "[自] " }[q.type] + (q.text || (q.type === "choice" ? q.choices.join(" / ") : ""));
      li.append(
        label,
        mk("出題", () => onAsk(q)),
        mk("編集", () => open(q.id)),
        mk("削除", () => {
          list = list.filter((x) => x.id !== q.id);
          save();
          render();
        })
      );
      return li;
    })
  );
}

// toggle form sections by type
function syncType() {
  const t = $<HTMLSelectElement>("qe-type").value;
  $("qe-choice").hidden = t !== "choice";
  $("qe-kana").hidden = t !== "kana";
}

// open editor (null = new record)
function open(id: string | null) {
  editing = id;
  const q = list.find((x) => x.id === id);
  const c = q?.type === "choice" ? q : undefined;
  const k = q?.type === "kana" ? q : undefined;
  const set = (i: string, v: string) => ($<HTMLInputElement>(i).value = v);
  $<HTMLSelectElement>("qe-type").value = q?.type ?? "choice";
  set("qe-text", q?.text ?? "");
  set("qe-ans", q?.ans ?? "");
  document.querySelectorAll<HTMLInputElement>(".qe-c").forEach((el, i) => (el.value = c?.choices[i] ?? ""));
  $<HTMLSelectElement>("qe-correct").value = String(c?.correct ?? 0);
  set("qe-limit", String((c?.limitMs ?? 10000) / 1000));
  set("qe-interval", String(k?.intervalMs ?? 150));
  set("qe-start", String((k?.startMs ?? 5000) / 1000));
  set("qe-first", String((k?.firstMs ?? 5000) / 1000));
  set("qe-next", String((k?.nextMs ?? 3000) / 1000));
  set("qe-max", k?.max === undefined ? "" : String(k.max));
  $<HTMLTextAreaElement>("qe-steps").value = k ? k.steps.map((s) => s.correct + s.dummies.join("")).join("\n") : "";
  $("qe-err").textContent = "";
  syncType();
  $<HTMLDialogElement>("qedit").showModal();
}

function commit() {
  const num = (i: string) => Number($<HTMLInputElement>(i).value);
  const base = { id: editing ?? crypto.randomUUID(), text: $<HTMLInputElement>("qe-text").value, ans: $<HTMLInputElement>("qe-ans").value };
  const type = $<HTMLSelectElement>("qe-type").value;
  let raw: unknown;
  if (type === "free") raw = { ...base, type: "free" };
  else if (type === "kana") {
    const steps = $<HTMLTextAreaElement>("qe-steps")
      .value.split("\n")
      .map((l) => [...l.replace(/\s/g, "")])
      .filter((a) => a.length)
      .map((a) => ({ correct: a[0], dummies: a.slice(1) }));
    const mx = $<HTMLInputElement>("qe-max").value.trim();
    raw = {
      ...base,
      type: "kana",
      intervalMs: num("qe-interval"),
      startMs: num("qe-start") * 1000,
      firstMs: num("qe-first") * 1000,
      nextMs: num("qe-next") * 1000,
      max: mx === "" ? undefined : Number(mx),
      steps
    };
  } else {
    const all = [...document.querySelectorAll<HTMLInputElement>(".qe-c")].map((el) => el.value.trim());
    const k = all.indexOf("");
    raw = { ...base, type: "choice", choices: k < 0 ? all : all.slice(0, k), correct: Number($<HTMLSelectElement>("qe-correct").value), limitMs: num("qe-limit") * 1000 };
  }
  const q = cleanQ(raw);
  if (!q) {
    $("qe-err").textContent = "入力が不正です（半回答: 問題文必須、各行は正解+ダミー3の計4文字で重複なし／選択: 2個以上、正解は入力済みの番号）";
    return;
  }
  const i = list.findIndex((x) => x.id === q.id);
  if (i >= 0) list[i] = q;
  else list.push(q);
  save();
  render();
  $<HTMLDialogElement>("qedit").close();
}

// CSV import (UTF-8, falls back to Shift_JIS)
async function importFile() {
  const inp = $<HTMLInputElement>("q-import"),
    f = inp.files?.[0];
  if (!f) return;
  const buf = await f.arrayBuffer();
  let src: string;
  try {
    src = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    src = new TextDecoder("shift_jis").decode(buf);
  }
  const { qs, errs } = csvToQs(src);
  list.push(...qs);
  save();
  render();
  inp.value = "";
  $("q-import-msg").textContent = `取込 ${qs.length}件` + (errs.length ? ` / エラー ${errs.length}件` : "");
  if (errs.length) alert(errs.slice(0, 10).join("\n"));
}

export function initQList(ask: (q: Q) => void) {
  onAsk = ask;
  list = load();
  render();
  $("q-add").onclick = () => open(null);
  $("q-import-btn").onclick = () => $("q-import").click();
  $("q-import").onchange = () => void importFile();
  $("qe-type").onchange = syncType;
  $("qe-save").onclick = commit;
  $("qe-cancel").onclick = () => $<HTMLDialogElement>("qedit").close();
}

export function removeQ(id: string) {
  list = list.filter((q) => q.id !== id);
  save();
  render();
}

export function addQ(q: Q) {
  list.push(q);
  save();
  render();
}
