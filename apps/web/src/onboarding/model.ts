/** What the person chooses during onboarding. Public data only; never the phrase. */
import { DEFAULT_THEME, newId, type Block, type Manifest, type Theme } from "@mizuhiki/core";

export type Goal = "creator" | "business" | "personal" | "team";
export type BlockPick = "pay" | "message" | "form" | "shop" | "room" | "capsule" | "pass";

export interface Draft {
  name: string;
  goal: Goal | undefined;
  template: string | undefined;
  picks: BlockPick[];
  fields: Partial<Record<BlockPick, string>>;
  displayName: string;
  bio: string;
  avatar: { hash: string; type: "image/png" | "image/jpeg" | "image/webp" } | undefined;
}

export const emptyDraft = (name = ""): Draft => ({
  name,
  goal: undefined,
  template: undefined,
  picks: [],
  fields: {},
  displayName: "",
  bio: "",
  avatar: undefined,
});

export const PICKS: {
  id: BlockPick;
  title: string;
  detail: string;
  icon: "coin" | "mail" | "form" | "bag" | "chat" | "hour" | "pass";
  tone: "matcha" | "sakura" | "sora" | "butter" | "fuji" | "kinari";
  field?: { label: string; placeholder: string; options?: string[] };
}[] = [
  {
    id: "pay",
    title: "Pay me",
    detail: "Anyone can pay you with a note only you read",
    icon: "coin",
    tone: "matcha",
    field: { label: "Paid in", placeholder: "", options: ["Test dollars (fUSD)", "Test QOR"] },
  },
  {
    id: "message",
    title: "Messages and files",
    detail: "A private drop box for anything",
    icon: "mail",
    tone: "sakura",
    field: { label: "Greeting", placeholder: "Hi, send me anything private here." },
  },
  {
    id: "form",
    title: "Forms",
    detail: "Questions answered in private",
    icon: "form",
    tone: "sora",
    field: { label: "First form", placeholder: "Project enquiry" },
  },
  {
    id: "shop",
    title: "Shop",
    detail: "Sell files sealed to each buyer",
    icon: "bag",
    tone: "butter",
    field: { label: "What you sell", placeholder: "Brand kit templates" },
  },
  {
    id: "room",
    title: "Rooms",
    detail: "Private groups for clients or family",
    icon: "chat",
    tone: "fuji",
    field: { label: "First room", placeholder: "Client room" },
  },
  { id: "capsule", title: "Capsules", detail: "Release files later, or if you go quiet", icon: "hour", tone: "kinari" },
  {
    id: "pass",
    title: "Passes",
    detail: "Let an accountant read one period",
    icon: "pass",
    tone: "butter",
    field: { label: "Accountant's @name (optional)", placeholder: "@mila.cpa" },
  },
];

export const GOAL_PICKS: Record<Goal, BlockPick[]> = {
  creator: ["pay", "message", "shop"],
  business: ["pay", "message", "form", "pass"],
  personal: ["message", "capsule"],
  team: ["message", "room", "form"],
};

export interface Template {
  id: string;
  title: string;
  trade: string;
  theme: Theme;
}

const t = (preset: Theme["preset"], a: string, b: string, font: Theme["font"] = "round"): Theme => ({
  ...DEFAULT_THEME,
  preset,
  wallpaper: { kind: "pattern", a, b },
  font,
});

export const TEMPLATES: Template[] = [
  { id: "washi", title: "Washi", trade: "Designers and makers", theme: t("washi", "#ffc4d0", "#ffb3c3") },
  { id: "sora", title: "Sora", trade: "Consultants and studios", theme: t("sora", "#d3e9f7", "#c4e0f3") },
  { id: "matcha", title: "Matcha", trade: "Cafes, shops and growers", theme: t("matcha", "#dcebc8", "#cfe3b4") },
  {
    id: "kinari",
    title: "Kinari",
    trade: "Lawyers, clinics, accountants",
    theme: t("kinari", "#fff1dc", "#ffe7c2", "sans"),
  },
  { id: "fuji", title: "Fuji", trade: "Writers, coaches, teachers", theme: t("fuji", "#e8dcff", "#dccbff") },
];

/** The first public blocks: only blocks that need no further setup are published. */
export function firstBlocks(d: Draft): Block[] {
  const firstName = (d.displayName || d.name).split(" ")[0] ?? d.name;
  const blocks: Block[] = [];
  if (d.picks.includes("pay")) {
    const tok = d.fields.pay === "Test QOR" ? "QOR" : "fUSD";
    blocks.push({
      id: newId(),
      type: "pay",
      on: true,
      archived: false,
      title: `Pay ${firstName}`,
      subtitle: "Any amount, with a note only they can read",
      tokens: tok === "QOR" ? ["QOR", "fUSD"] : ["fUSD", "QOR"],
      presets: [],
      tip: false,
      thanks: "",
    });
  }
  blocks.push({
    id: newId(),
    type: "message",
    on: true,
    archived: false,
    title: "Send me something private",
    subtitle: "Sealed on your device before it leaves",
    greeting: d.fields.message?.trim() || `Hi, I'm ${firstName}. Anything you send here is sealed to me.`,
    allowFiles: true,
    maxFileMB: 500,
  });
  if (d.picks.includes("capsule"))
    blocks.push({
      id: newId(),
      type: "capsule",
      on: false,
      archived: false,
      title: "Leave me a sealed note",
      subtitle: "Opens only when I choose",
    });
  return blocks;
}

export function firstManifest(d: Draft, address: string): Manifest {
  const tpl = TEMPLATES.find((x) => x.id === d.template) ?? TEMPLATES[0];
  return {
    v: 1,
    name: d.name,
    address,
    displayName: d.displayName.trim() || d.name,
    bio: d.bio.trim(),
    ...(d.avatar ? { avatar: d.avatar } : {}),
    socials: [],
    goal: d.goal ?? "creator",
    theme: tpl?.theme ?? DEFAULT_THEME,
    blocks: firstBlocks(d),
    periodKeys: [],
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}
