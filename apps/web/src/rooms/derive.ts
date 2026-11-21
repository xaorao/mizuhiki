/**
 * Room state worked out on this device from the opened, signature-checked
 * lines: name, photo, settings, pins, reactions, deletions, the visible
 * timeline with system pills, the recent-actions log and the shared files.
 *
 * Trust rules: a system change (info, settings, created, added, removed, role,
 * rotated, pin) counts only when its author was an owner or admin at the time,
 * or recorded that epoch's key change on chain; info and pin changes also
 * count from a member who held that right at the time. "left" counts only from the
 * person leaving. Deletions count from the author or an admin.
 */
import type { FileFacts, Permission, RoomBody, RoomType } from "@mizuhiki/core";
import type { EpochRow, Line, MemberRow, Role } from "./engine";

export interface RoomInfo {
  name: string;
  description: string;
  type: RoomType;
  photo: FileFacts | null;
  approval: boolean;
  autoDeleteSeconds: number;
  restrictSaving: boolean;
  historyDefault: "share" | "hide";
}

export const DEFAULT_INFO: RoomInfo = {
  name: "",
  description: "",
  type: "team",
  photo: null,
  approval: true,
  autoDeleteSeconds: 0,
  restrictSaving: false,
  historyDefault: "hide",
};

export type Item =
  | { type: "day"; key: string; date: string }
  | {
      type: "message";
      key: string;
      line: Line;
      author: string;
      body: Extract<RoomBody, { kind: "text" } | { kind: "file" }>;
      reactions: Record<string, string[]>;
      pinned: boolean;
    }
  | { type: "pill"; key: string; line: Line | null; text: PillText; tone: "plain" | "key" | "warn" }
  | { type: "problem"; key: string; line: Line };

/** A pill is built from parts so names can be shown as they resolve. */
export type PillText = Array<string | { who: string }>;

export interface ActionEntry {
  key: string;
  at: string;
  by: string;
  text: PillText;
  /** The on-chain record behind this action, when there is one. */
  txHash?: string;
  epoch: number;
}

export interface SharedFile {
  key: string;
  line: Line;
  author: string;
  facts: FileFacts;
  caption: string;
  kind: "photo" | "video" | "audio" | "doc";
}

export interface Derived {
  info: RoomInfo;
  items: Item[];
  pinned: { msgId: string; line: Line; text: string }[];
  actions: ActionEntry[];
  files: SharedFile[];
  /** Message id → line, for replies and reactions. */
  byId: Map<string, Line>;
  /** Members' permissions as last announced (the server's copy is in RoomDetail). */
  lastSeq: bigint;
}

const SYSTEM = new Set(["info", "settings", "created", "added", "removed", "role", "rotated", "pin"]);

export function fileKind(type: string): SharedFile["kind"] {
  if (type.startsWith("image/")) return "photo";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  return "doc";
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Who was owner or admin when a line was written. Roles come from the room's
 * "role" messages in order, starting from the owner who created the room; the
 * server's current roles fill in for anyone the stream has not mentioned.
 */
function roleTracker(members: MemberRow[], epochs: EpochRow[]) {
  const roles = new Map<string, Role>();
  // A member's rights as last announced in the stream ("role" messages); joining resets them to all.
  const perms = new Map<string, Permission[]>();
  const creator = epochs.find((e) => e.epoch === 1)?.by;
  if (creator) roles.set(creator, "owner");
  return {
    roleOf(address: string): Role {
      return (
        roles.get(address) ??
        (members.find((m) => m.address === address && m.status === "active")?.role === "owner" && !creator
          ? "owner"
          : "member")
      );
    },
    permsOf(address: string): Permission[] {
      return perms.get(address) ?? members.find((m) => m.address === address)?.permissions ?? [];
    },
    apply(body: RoomBody, author: string) {
      if (body.kind === "added") perms.set(body.member, [...ALL_PERMISSIONS]);
      if (body.kind !== "role") return;
      perms.set(body.member, body.permissions);
      if (body.role === "owner") {
        for (const [a, r] of roles) if (r === "owner") roles.set(a, "admin");
        if (author !== body.member) roles.set(author, "admin");
      }
      roles.set(body.member, body.role);
    },
  };
}

export function derive(lines: Line[], members: MemberRow[], epochs: EpochRow[]): Derived {
  const info: RoomInfo = { ...DEFAULT_INFO };
  const items: Item[] = [];
  const actions: ActionEntry[] = [];
  const byId = new Map<string, Line>();
  const reactions = new Map<string, Map<string, Set<string>>>();
  const pins = new Map<string, boolean>();
  const deleted = new Set<string>();
  const epochBy = new Map(epochs.map((e) => [e.epoch, e]));
  const roles = roleTracker(members, epochs);
  const files: SharedFile[] = [];
  let lastSeq = 0n;

  // A message counts once: a member re-uploading someone else's signed message in the same key period
  // must not make it appear twice (the first copy wins).
  const seen = new Set<string>();
  const copies = new Set<string>();
  // The author must have been in the room during the key period the message was sealed under. Someone
  // who has left gets no member list, so their device cannot check this (and only sees their own periods).
  const outsiders = new Set<string>();
  const wasMember = (author: string, epoch: number): boolean => {
    if (members.length === 0) return true;
    const m = members.find((x) => x.address === author);
    if (!m) return false;
    if (epoch < m.firstEpoch) return false;
    if (m.status !== "active" && m.lastEpoch !== null && epoch > m.lastEpoch) return false;
    return true;
  };

  // First pass: authority, reactions, pins, deletions.
  const trusted = new Set<string>();
  for (const l of lines) {
    if (l.seq > lastSeq) lastSeq = l.seq;
    const m = l.msg;
    if (!m) continue;
    if (seen.has(m.id)) {
      copies.add(l.hash);
      continue;
    }
    seen.add(m.id);
    if (!wasMember(m.author, l.epoch)) {
      outsiders.add(l.hash);
      continue;
    }
    byId.set(m.id, l);
    const b = m.body;
    const role = roles.roleOf(m.author);
    const isAdmin = role === "owner" || role === "admin";
    const recorded = epochBy.get(l.epoch)?.by === m.author;
    // Room info and pins also count from a member holding that right ("Change room info", "Pin messages").
    const granted = (b.kind === "info" || b.kind === "pin") && roles.permsOf(m.author).includes(b.kind);
    if (SYSTEM.has(b.kind) && !(isAdmin || recorded || granted)) continue;
    if (b.kind === "left" && b.member !== m.author) continue;
    trusted.add(m.id);
    roles.apply(b, m.author);
    if (b.kind === "reaction") {
      const per = reactions.get(b.target) ?? new Map<string, Set<string>>();
      const set = per.get(b.emoji) ?? new Set<string>();
      if (b.on) set.add(m.author);
      else set.delete(m.author);
      per.set(b.emoji, set);
      reactions.set(b.target, per);
    }
    if (b.kind === "pin") pins.set(b.target, b.on);
    if (b.kind === "delete") {
      const target = byId.get(b.target);
      if (target?.msg && (target.msg.author === m.author || isAdmin)) deleted.add(b.target);
    }
  }

  // Second pass: the timeline.
  let lastDay = "";
  for (const l of lines) {
    const when = l.msg?.sentAt ?? l.at;
    const d = dayKey(when);
    if (d !== lastDay) {
      items.push({ type: "day", key: `day:${d}:${l.hash}`, date: when });
      lastDay = d;
    }
    if (copies.has(l.hash)) continue;
    if (!l.msg || outsiders.has(l.hash)) {
      items.push({ type: "problem", key: l.hash, line: l.msg ? { ...l, problem: "not-member" } : l });
      continue;
    }
    const m = l.msg;
    if (!trusted.has(m.id) || deleted.has(m.id)) continue;
    const b = m.body;
    const who = { who: m.author };
    const tx = epochBy.get(l.epoch)?.txHash;
    const act = (text: PillText, withTx = false) =>
      actions.push({
        key: m.id,
        at: m.sentAt,
        by: m.author,
        text,
        epoch: l.epoch,
        ...(withTx && tx ? { txHash: tx } : {}),
      });
    switch (b.kind) {
      case "text":
      case "file": {
        const r: Record<string, string[]> = {};
        for (const [emoji, set] of reactions.get(m.id) ?? []) if (set.size) r[emoji] = [...set];
        items.push({
          type: "message",
          key: m.id,
          line: l,
          author: m.author,
          body: b,
          reactions: r,
          pinned: pins.get(m.id) === true,
        });
        if (b.kind === "file") {
          const facts = b.file as unknown as FileFacts;
          files.push({ key: m.id, line: l, author: m.author, facts, caption: b.caption, kind: fileKind(facts.type) });
        }
        break;
      }
      case "created":
        // The creation card at the top of the room says this already; it stays in the recent-actions log.
        act([who, " created the room"], true);
        break;
      case "info": {
        const renamed = info.name && info.name !== b.name;
        const firstInfo = !info.name;
        const photoId = (b.photo as unknown as FileFacts | undefined)?.fileId;
        // Admins re-post the room info under each new key (so people who join see it); that is not a change.
        const same =
          !firstInfo &&
          !renamed &&
          info.description === b.description &&
          info.type === b.type &&
          (photoId === undefined || photoId === info.photo?.fileId);
        info.name = b.name;
        info.description = b.description;
        info.type = b.type;
        info.photo = (b.photo as unknown as FileFacts | undefined) ?? info.photo;
        if (!firstInfo && !same) {
          const text: PillText = renamed ? [who, ` renamed the room to “${b.name}”`] : [who, " changed the room info"];
          items.push({ type: "pill", key: m.id, line: l, text, tone: "plain" });
          act(text);
        }
        break;
      }
      case "settings": {
        const changed: string[] = [];
        if (info.approval !== b.approval)
          changed.push(b.approval ? "turned on approval for new members" : "let invites join without approval");
        if (info.autoDeleteSeconds !== b.autoDeleteSeconds)
          changed.push(
            b.autoDeleteSeconds
              ? `set new messages to delete after ${durationLabel(b.autoDeleteSeconds)}`
              : "turned off auto-delete",
          );
        if (info.restrictSaving !== b.restrictSaving)
          changed.push(b.restrictSaving ? "asked members not to save" : "stopped asking members not to save");
        if (info.historyDefault !== b.historyDefault)
          changed.push(
            b.historyDefault === "share"
              ? "set people who join by link to see past messages"
              : "set people who join by link to see only new messages",
          );
        Object.assign(info, {
          approval: b.approval,
          autoDeleteSeconds: b.autoDeleteSeconds,
          restrictSaving: b.restrictSaving,
          historyDefault: b.historyDefault,
        });
        const isCreation = l === lines.find((x) => x.msg?.body.kind === "settings");
        // The room's starting settings are part of creation, not a change.
        if (!isCreation)
          for (const c of changed) {
            const text: PillText = [who, ` ${c}`];
            items.push({ type: "pill", key: `${m.id}:${c}`, line: l, text, tone: "plain" });
            act(text);
          }
        break;
      }
      case "added": {
        items.push({ type: "pill", key: m.id, line: l, text: [who, " added ", { who: b.member }], tone: "plain" });
        items.push({
          type: "pill",
          key: `${m.id}:key`,
          line: l,
          text: [
            "Room key updated. ",
            { who: b.member },
            b.history === "share" ? " joined, history shared." : " joined, history not shared.",
          ],
          tone: "key",
        });
        act(
          [
            who,
            " added ",
            { who: b.member },
            b.history === "share" ? " and shared past messages" : " (only new messages)",
          ],
          true,
        );
        break;
      }
      case "removed": {
        items.push({
          type: "pill",
          key: m.id,
          line: l,
          text: [who, b.blocked ? " removed and blocked " : " removed ", { who: b.member }],
          tone: "plain",
        });
        items.push({
          type: "pill",
          key: `${m.id}:key`,
          line: l,
          text: ["Room key updated. ", { who: b.member }, " was removed and cannot read new messages."],
          tone: "key",
        });
        act([who, b.blocked ? " removed and blocked " : " removed ", { who: b.member }], true);
        break;
      }
      case "left":
        items.push({ type: "pill", key: m.id, line: l, text: [who, " left"], tone: "plain" });
        act([who, " left the room"]);
        break;
      case "rotated": {
        const leftWho = /^left:(qor1[0-9a-z]{38})$/.exec(b.reason)?.[1];
        const text: PillText = leftWho
          ? ["Room key updated. ", { who: leftWho }, " left and cannot read new messages."]
          : ["Room key updated."];
        items.push({ type: "pill", key: m.id, line: l, text, tone: "key" });
        act(
          leftWho ? [who, " changed the room key after ", { who: leftWho }, " left"] : [who, " changed the room key"],
          true,
        );
        break;
      }
      case "role": {
        const text: PillText =
          b.role === "owner"
            ? [who, " made ", { who: b.member }, " the owner"]
            : b.role === "admin"
              ? [who, " made ", { who: b.member }, " an admin"]
              : [who, " changed what ", { who: b.member }, " can do"];
        items.push({ type: "pill", key: m.id, line: l, text, tone: "plain" });
        act(b.role === "member" ? [...text, `: ${permissionSummary(b.permissions)}`] : text);
        break;
      }
      case "pin": {
        const target = byId.get(b.target);
        const snippet = target?.msg ? snippetOf(target.msg.body) : "a message";
        const text: PillText = [who, b.on ? ` pinned “${snippet}”` : ` unpinned “${snippet}”`];
        items.push({ type: "pill", key: m.id, line: l, text, tone: "plain" });
        act(text);
        break;
      }
      default:
        break;
    }
  }

  const pinned = [...pins.entries()]
    .filter(([id, on]) => on && !deleted.has(id) && byId.get(id)?.msg)
    .map(([id]) => {
      const l = byId.get(id) as Line;
      return { msgId: id, line: l, text: snippetOf((l.msg as NonNullable<Line["msg"]>).body) };
    })
    .sort((a, b) => (a.line.seq < b.line.seq ? 1 : -1));

  return { info, items, pinned, actions: actions.reverse(), files: files.reverse(), byId, lastSeq };
}

export function snippetOf(b: RoomBody): string {
  if (b.kind === "text") return b.text.length > 60 ? `${b.text.slice(0, 57)}…` : b.text;
  if (b.kind === "file") {
    const f = b.file as unknown as FileFacts;
    return b.caption || f.name;
  }
  return "a message";
}

export function durationLabel(s: number): string {
  if (s % 604800 === 0) return s === 604800 ? "1 week" : `${s / 604800} weeks`;
  if (s % 86400 === 0) return s === 86400 ? "1 day" : `${s / 86400} days`;
  if (s % 3600 === 0) return s === 3600 ? "1 hour" : `${s / 3600} hours`;
  return `${Math.round(s / 60)} minutes`;
}

export const ALL_PERMISSIONS: Permission[] = ["send", "files", "add", "info", "pin"];
export function permissionSummary(p: Permission[]): string {
  if (p.length === ALL_PERMISSIONS.length) return "everything";
  if (p.length === 0) return "read only";
  const label: Record<Permission, string> = {
    send: "send",
    files: "files",
    add: "add people",
    info: "change info",
    pin: "pin",
  };
  return p.map((x) => label[x]).join(", ");
}

/** Can this member do this, by the server's current record? Owners and admins can do everything. */
export function can(m: MemberRow | undefined, p: Permission): boolean {
  if (!m || m.status !== "active") return false;
  return m.role === "owner" || m.role === "admin" || m.permissions.includes(p);
}
