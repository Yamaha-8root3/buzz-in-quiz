import type { ClientMsg, ServerMsg } from "../shared/types";

// open WS to room and send hello on open
export function connect(room: string, hello: ClientMsg, onMsg: (m: ServerMsg) => void, onClose: (e: CloseEvent) => void) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/${room}`);
  ws.onopen = () => ws.send(JSON.stringify(hello));
  ws.onmessage = (e) => onMsg(JSON.parse(e.data as string) as ServerMsg);
  ws.onclose = onClose;
  return ws;
}