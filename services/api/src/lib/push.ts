/**
 * Web Push (spec 5.17, ARCHITECTURE 8f). A push says only what kind of thing
 * happened ("Something new arrived"), never content, and is encrypted to the
 * browser (RFC 8291) and signed with this server's VAPID key (RFC 8292).
 * Each account chooses which kinds it wants; a kind is sent at most once a
 * minute per account; subscriptions the push service no longer knows are
 * removed.
 */
import webpush from "web-push";
import { eq } from "drizzle-orm";
import { notifyPrefs, pushSubscriptions, type Db } from "@mizuhiki/db";
import type { Config } from "../config";

export const PUSH_TYPES = ["items", "payments", "orders", "rooms", "access", "recovery", "checkin"] as const;
export type PushType = (typeof PUSH_TYPES)[number];

/** Dashboard event kinds and the push each one becomes. */
const FROM_EVENT: Record<string, PushType> = {
  drop: "items",
  pay: "payments",
  order: "orders",
  room: "rooms",
  pass: "access",
  capsule: "access",
  recovery: "recovery",
};

const WORDS: Record<PushType, { title: string; body: string; url: string }> = {
  items: { title: "Something new arrived", body: "A sealed item is waiting in your inbox.", url: "/app/inbox" },
  payments: { title: "A payment arrived", body: "Open Mizuhiki to see it.", url: "/app/inbox" },
  orders: { title: "Shop update", body: "An order changed. Open your shop to see it.", url: "/app/shop?tab=sales" },
  rooms: { title: "Room activity", body: "Something changed in one of your rooms.", url: "/app/rooms" },
  access: { title: "Passes and capsules", body: "Something changed in a pass or capsule.", url: "/app/capsules" },
  recovery: {
    title: "Spare key",
    body: "Something needs you on your spare key page. If someone is recovering your account and it isn't you, cancel it.",
    url: "/app/spare-key",
  },
  checkin: {
    title: "Time to check in",
    body: "A capsule opens soon if you stay quiet. Open Mizuhiki and check in.",
    url: "/app/capsules",
  },
};

export const pushEnabled = (cfg: Config): boolean =>
  Boolean(cfg.VAPID_PUBLIC_KEY && cfg.VAPID_PRIVATE_KEY && cfg.VAPID_SUBJECT);

export interface PushSender {
  /** Sends `type` to every browser of `address` that wants it. Returns how many were delivered. */
  send(address: string, type: PushType): Promise<number>;
  fromEvent(kind: string, address: string): Promise<number>;
}

export function makePush(
  db: Db,
  cfg: Config,
  transport: typeof webpush.sendNotification = webpush.sendNotification.bind(webpush),
): PushSender {
  const last = new Map<string, number>();
  const wants = async (address: string, type: PushType) => {
    const [p] = await db.select({ prefs: notifyPrefs.prefs }).from(notifyPrefs).where(eq(notifyPrefs.address, address));
    const prefs = (p?.prefs ?? {}) as Partial<Record<PushType, boolean>>;
    return prefs[type] !== false;
  };
  const send = async (address: string, type: PushType): Promise<number> => {
    if (!pushEnabled(cfg)) return 0;
    const key = `${address}|${type}`;
    const now = Date.now();
    if (now - (last.get(key) ?? 0) < 60_000) return 0;
    if (!(await wants(address, type))) return 0;
    const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.address, address));
    if (subs.length === 0) return 0;
    last.set(key, now);
    if (last.size > 50_000) last.clear();
    const payload = JSON.stringify({ type, ...WORDS[type] });
    let delivered = 0;
    for (const s of subs) {
      try {
        await transport({ endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } }, payload, {
          TTL: 24 * 3600,
          urgency: type === "recovery" ? "high" : "normal",
          topic: type,
          vapidDetails: {
            subject: cfg.VAPID_SUBJECT ?? "",
            publicKey: cfg.VAPID_PUBLIC_KEY ?? "",
            privateKey: cfg.VAPID_PRIVATE_KEY ?? "",
          },
        });
        delivered++;
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // The browser unsubscribed or the push service forgot it: stop sending there.
        if (status === 404 || status === 410)
          await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, s.endpoint));
      }
    }
    return delivered;
  };
  return {
    send,
    fromEvent: async (kind, address) => {
      const type = FROM_EVENT[kind];
      return type ? send(address, type) : 0;
    },
  };
}
