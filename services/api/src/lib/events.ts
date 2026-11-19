/**
 * Fan-out of "something new for this owner" from Postgres NOTIFY (written by
 * the drop service and the indexer) to the owner's open dashboards. Payloads
 * are "<kind>:<owner address>"; sockets receive only {type:"new", kind}.
 */
import postgres from "postgres";

interface Socket {
  send(data: string): void;
  readyState: number;
}

export class EventHub {
  private readonly subs = new Map<string, Set<Socket>>();
  private sql: ReturnType<typeof postgres> | null = null;

  async start(url: string): Promise<void> {
    this.sql = postgres(url, { max: 1, onnotice: () => undefined });
    await this.sql.listen("mzk_events", (payload) => this.dispatch(payload));
  }

  dispatch(payload: string): void {
    const i = payload.indexOf(":");
    if (i < 0) return;
    const kind = payload.slice(0, i);
    const owner = payload.slice(i + 1);
    for (const s of this.subs.get(owner) ?? []) {
      if (s.readyState === 1) s.send(JSON.stringify({ type: "new", kind }));
    }
  }

  subscribe(owner: string, s: Socket): void {
    const set = this.subs.get(owner) ?? new Set<Socket>();
    set.add(s);
    this.subs.set(owner, set);
  }

  unsubscribe(owner: string, s: Socket): void {
    const set = this.subs.get(owner);
    set?.delete(s);
    if (set?.size === 0) this.subs.delete(owner);
  }

  async stop(): Promise<void> {
    await this.sql?.end();
  }
}
