/**
 * Demo pages for the landing (spec 5.1: real product screens). Each demo is a
 * real testnet account: keys on QoreChain, a name on MizuhikiRegistry, a
 * verified card and a signed, published page on the local API. Run again at
 * any time: names and keys are kept, pages are re-published.
 * Usage: tsx tools/demo-seed.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_THEME, newId, signRecord, type Block, type Manifest, type Theme } from "@mizuhiki/core";
import { ensurePersona } from "@mizuhiki/testnet";
import { NETWORK } from "@mizuhiki/chain";
import { API, apiToken } from "../specs/owner";

const theme = (preset: Theme["preset"], a: string, b: string, font: Theme["font"] = "round"): Theme => ({
  ...DEFAULT_THEME,
  preset,
  wallpaper: { kind: "pattern", a, b },
  font,
});
const pay = (title: string, subtitle: string): Block => ({
  id: newId(),
  type: "pay",
  on: true,
  archived: false,
  title,
  subtitle,
  tokens: ["fUSD", "QOR"],
  presets: [],
  tip: false,
  thanks: "",
});
const message = (title: string, subtitle: string, greeting: string): Block => ({
  id: newId(),
  type: "message",
  on: true,
  archived: false,
  title,
  subtitle,
  greeting,
  allowFiles: true,
  maxFileMB: 500,
});
const invoice = (title: string, subtitle: string): Block => ({
  id: newId(),
  type: "invoiceRequest",
  on: true,
  archived: false,
  title,
  subtitle,
});

interface Demo {
  label: string;
  name: string;
  displayName: string;
  bio: string;
  goal: Manifest["goal"];
  theme: Theme;
  blocks: Block[];
}

export const DEMOS: Demo[] = [
  {
    label: "demo-aria",
    name: "aria",
    displayName: "Aria Kapoor",
    bio: "Brand designer. Briefs, contracts and payments come through here, sealed to me.",
    goal: "creator",
    theme: theme("washi", "#ffc4d0", "#ffb3c3"),
    blocks: [
      pay("Pay Aria", "Any amount, with a note only I can read"),
      message(
        "Send a private file",
        "Sealed on your device before it leaves",
        "Hi, I'm Aria. Briefs, contracts, anything private.",
      ),
      invoice("Ask for an invoice", "Line items sealed to you and me"),
    ],
  },
  {
    label: "demo-rohan",
    name: "rohan.law",
    displayName: "Rohan Nair Law",
    bio: "Contracts and company law. Send documents for review; only my office can open them.",
    goal: "business",
    theme: theme("kinari", "#fff1dc", "#ffe7c2", "sans"),
    blocks: [
      invoice("Pay an invoice", "Your invoice opens only for you and us"),
      message(
        "Send documents for review",
        "Sealed before upload, up to 500 MB",
        "Send the documents and a short note on what you need.",
      ),
    ],
  },
  {
    label: "demo-sunrise",
    name: "sunrise.clinic",
    displayName: "Sunrise Clinic",
    bio: "Family practice. Results and questions reach our nurses sealed, never by email.",
    goal: "business",
    theme: theme("matcha", "#dcebc8", "#cfe3b4"),
    blocks: [
      message(
        "Ask the nurse",
        "A private question, answered within a day",
        "Write your question. Add your date of birth so we can find you.",
      ),
      message(
        "Upload test results",
        "Lab PDFs and photos, sealed on your phone",
        "Attach your results. Only the clinic can open them.",
      ),
    ],
  },
  {
    label: "demo-maya",
    name: "maya.studio",
    displayName: "Maya Studio",
    bio: "Photo presets and custom edits. Each buyer gets their own sealed copy.",
    goal: "creator",
    theme: theme("fuji", "#e8dcff", "#dccbff"),
    blocks: [
      message("Commission request", "Send your photos and what you have in mind", "Tell me about the edit you want."),
      pay("Tip the studio", "Thank you, truly"),
    ],
  },
  {
    label: "demo-kapoor",
    name: "kapoor.family",
    displayName: "Kapoor Family",
    bio: "Our family documents, in one place only we can open.",
    goal: "personal",
    theme: theme("sora", "#d3e9f7", "#c4e0f3"),
    blocks: [
      message("Send us a document", "Passports, deeds, school forms", "Drop it here. Only the family can open it."),
      pay("Chip in for the trip", "Any amount, note sealed"),
    ],
  },
  {
    label: "demo-mila",
    name: "mila.cpa",
    displayName: "Mila Chen, CPA",
    bio: "Bookkeeping and tax for freelancers. Share one quarter with me, not everything.",
    goal: "business",
    theme: theme("kinari", "#fff1dc", "#ffe7c2", "sans"),
    blocks: [
      message("Send your receipts", "Sealed to me before upload", "Receipts, statements and invoices for the quarter."),
      invoice("Pay your invoice", "Opens only for you and me"),
    ],
  },
];

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const j = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${path}: ${j.error?.message ?? res.status}`);
  return j;
}

/** The account's key registrations, read from the native lane's transaction index. */
async function keyTxs(address: string): Promise<{ kind: string; hash: string; height: string }[]> {
  const q = encodeURIComponent(`message.sender='${address}'`);
  const r = (await (await fetch(`${NETWORK.rest}/cosmos/tx/v1beta1/txs?query=${q}&limit=50`)).json()) as {
    tx_responses?: { txhash: string; height: string; tx: { body: { messages: { "@type": string }[] } } }[];
  };
  return (r.tx_responses ?? []).flatMap((t) =>
    t.tx.body.messages
      .map((m) => m["@type"])
      .filter((ty) => /pqc|PQ|Kem|Key/i.test(ty))
      .map((kind) => ({ kind, hash: t.txhash, height: t.height })),
  );
}

const out: Record<string, { address: string; evm: string; keys: { kind: string; hash: string; height: string }[] }> =
  {};
for (const d of DEMOS) {
  const p = await ensurePersona(d.label, { name: d.name });
  const token = await apiToken(p);
  await call("/cards", { method: "PUT", body: { card: p.card }, token });
  const own = await call<{ page: { version: number } | null }>("/owner/page", { token });
  const m: Manifest = {
    v: 1,
    name: d.name,
    address: p.address,
    displayName: d.displayName,
    bio: d.bio,
    socials: [],
    goal: d.goal,
    theme: d.theme,
    blocks: d.blocks,
    periodKeys: [],
    version: (own.page?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  await call("/pages", {
    method: "PUT",
    body: { record: signRecord({ kind: "manifest", body: m, signer: p.address, classical: p.classical, pq: p.pq }) },
    token,
  });
  await call("/drafts", { method: "DELETE", token });
  out[d.name] = { address: p.address, evm: p.evm, keys: await keyTxs(p.address) };
  console.log(`@${d.name} published (${p.address})`);
}
writeFileSync(resolve(import.meta.dirname, "../../../var/demo-accounts.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
