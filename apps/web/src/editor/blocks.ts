/** Block catalogue for the Add sheet, and pure edits on the draft's block list. */
import { newId, type Block, type BlockType } from "@mizuhiki/core";
import type { IconName } from "@mizuhiki/ui";
import type { Draft } from "./state";

export type Category = "suggested" | "money" | "messages" | "links" | "text";
export const CATEGORIES: { id: Category; label: string; icon: IconName }[] = [
  { id: "suggested", label: "Suggested", icon: "sparkle" },
  { id: "money", label: "Money", icon: "coin" },
  { id: "messages", label: "Messages", icon: "mail" },
  { id: "links", label: "Links", icon: "link" },
  { id: "text", label: "Text", icon: "text" },
];

export interface CatalogItem {
  type: BlockType;
  title: string;
  detail: string;
  icon: IconName;
  categories: Category[];
  make: (ctx: { firstName: string }) => Block;
}

/** Block types whose feature exists today. Others join this list as their area is built. */
export const CATALOG: CatalogItem[] = [
  {
    type: "message",
    title: "Message or file drop",
    detail: "A private drop box: messages and files sealed to you",
    icon: "mail",
    categories: ["suggested", "messages"],
    make: ({ firstName }) => ({
      id: newId(),
      type: "message",
      on: true,
      archived: false,
      title: "Send me something private",
      subtitle: "Sealed on your device before it leaves",
      greeting: `Hi, I'm ${firstName}. Anything you send here is sealed to me.`,
      allowFiles: true,
      maxFileMB: 500,
    }),
  },
  {
    type: "pay",
    title: "Pay me",
    detail: "Any amount, with a note only you can read",
    icon: "coin",
    categories: ["suggested", "money"],
    make: ({ firstName }) => ({
      id: newId(),
      type: "pay",
      on: true,
      archived: false,
      title: `Pay ${firstName}`,
      subtitle: "Any amount, with a sealed note",
      tokens: ["fUSD", "QOR"],
      presets: [],
      tip: false,
      thanks: "",
    }),
  },
  {
    type: "link",
    title: "Link",
    detail: "Any website, shown as a button",
    icon: "link",
    categories: ["suggested", "links"],
    make: () => ({
      id: newId(),
      type: "link",
      on: false,
      archived: false,
      title: "New link",
      subtitle: "",
      url: "https://",
    }),
  },
  {
    type: "text",
    title: "Text",
    detail: "A short note on your page",
    icon: "text",
    categories: ["text"],
    make: () => ({ id: newId(), type: "text", on: false, archived: false, title: "A note", subtitle: "", body: "" }),
  },
  {
    type: "capsule",
    title: "Leave me a sealed note",
    detail: "A public note box for capsules",
    icon: "hour",
    categories: ["messages"],
    make: () => ({
      id: newId(),
      type: "capsule",
      on: false,
      archived: false,
      title: "Leave me a sealed note",
      subtitle: "Opens only when I choose",
    }),
  },
  {
    type: "collection",
    title: "Collection",
    detail: "Group blocks under a heading",
    icon: "folder",
    categories: ["links", "text"],
    make: () => ({ id: newId(), type: "collection", on: true, archived: false, title: "New collection", subtitle: "" }),
  },
];

/** A block is publishable when its required fields are complete. */
export function blockProblem(b: Block): string | undefined {
  if (!b.title.trim()) return "Add a title";
  if (b.type === "link") {
    try {
      const u = new URL(b.url);
      if (!["http:", "https:", "mailto:"].includes(u.protocol) || u.hostname === "")
        return "Add the full link, starting with https://";
    } catch {
      return "Add the full link, starting with https://";
    }
  }
  if (b.type === "text" && !b.body.trim()) return "Write the text";
  if (b.type === "pay" && b.tokens.length === 0) return "Pick at least one token";
  return undefined;
}

export const mapBlocks = (d: Draft, fn: (bs: Block[]) => Block[]): Draft => ({
  ...d,
  manifest: { ...d.manifest, blocks: fn(d.manifest.blocks) },
});
export const updateBlock = (d: Draft, id: string, patch: Partial<Block>): Draft =>
  mapBlocks(d, (bs) => bs.map((b) => (b.id === id ? ({ ...b, ...patch } as Block) : b)));

export function moveBlock(d: Draft, id: string, to: number): Draft {
  return mapBlocks(d, (bs) => {
    const live = bs.filter((b) => !b.archived);
    const from = live.findIndex((b) => b.id === id);
    if (from < 0 || to < 0 || to >= live.length || from === to) return bs;
    const moved = [...live];
    const [b] = moved.splice(from, 1);
    if (!b) return bs;
    moved.splice(to, 0, b);
    return [...moved, ...bs.filter((x) => x.archived)];
  });
}

/** Normalise a pasted link: "example.com" becomes "https://example.com". */
export function linkFromPaste(text: string): URL | undefined {
  const t = text.trim();
  if (!t || /\s/.test(t)) return undefined;
  for (const candidate of [t, `https://${t}`]) {
    try {
      const u = new URL(candidate);
      if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".")) return u;
    } catch {
      // try the next form
    }
  }
  return undefined;
}

/** A readable button title from a URL: "www.youtube.com" becomes "Youtube". */
export function titleFromUrl(u: URL): string {
  const host = u.hostname.replace(/^www\./, "").split(".")[0] ?? u.hostname;
  return host.charAt(0).toUpperCase() + host.slice(1);
}
