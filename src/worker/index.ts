import { Room } from "./room";
export { Room };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const m = new URL(req.url).pathname.match(/^\/ws\/([A-Za-z0-9]{4,8})$/);
    if (!m) return new Response("not found", { status: 404 });
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const id = env.ROOM.idFromName(m[1].toUpperCase());
    return env.ROOM.get(id, { locationHint: "apac" }).fetch(req);
  },
} satisfies ExportedHandler<Env>;