/**
 * The owner's side of forms (spec 5.9): new forms and templates, one blank
 * question per kind with the picker's help text (Tally's "Insert anything"),
 * sealing the working draft to the owner, signing and publishing.
 */
import {
  FormDefSchema,
  Purpose,
  fromUtf8,
  isQuestion,
  openItem,
  publicRecipient,
  randomBytes,
  sealItem,
  signRecord,
  utf8,
  type FormBlock,
  type FormDef,
  type Question,
  type QuestionKind,
} from "@mizuhiki/core";
import type { IconName } from "@mizuhiki/ui";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";

export const newId = (n = 10): string => {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(randomBytes(n), (x) => a[x % a.length]).join("");
};

export interface KindInfo {
  kind: QuestionKind | "page" | "heading" | "statement";
  label: string;
  icon: IconName;
  group: "Questions" | "Choices" | "Contact" | "Uploads" | "Layout";
  help: string;
  example: string;
}

/** The insert picker: every block with a plain explanation and an example (Tally). */
export const KINDS: KindInfo[] = [
  {
    kind: "short",
    label: "Short answer",
    icon: "text",
    group: "Questions",
    help: "One line of text: a name, a title, a short reply.",
    example: "What's your name? · Rohan Mehta",
  },
  {
    kind: "long",
    label: "Long answer",
    icon: "text",
    group: "Questions",
    help: "Several lines. Shift + Enter makes a new line.",
    example: "Tell us about your project · We're opening a tea shop…",
  },
  {
    kind: "number",
    label: "Number",
    icon: "text",
    group: "Questions",
    help: "Only numbers, with an optional lowest and highest value.",
    example: "How many people? · 12",
  },
  {
    kind: "date",
    label: "Date",
    icon: "calendar",
    group: "Questions",
    help: "A calendar date.",
    example: "When do you need it? · 3 March 2027",
  },
  {
    kind: "choice",
    label: "Multiple choice",
    icon: "check",
    group: "Choices",
    help: "Pick one. Respondents can press A, B, C on the keyboard.",
    example: "Budget? · A Under 500 · B 500 or more",
  },
  {
    kind: "checkboxes",
    label: "Checkboxes",
    icon: "check",
    group: "Choices",
    help: "Pick several. Set the least and most they may pick.",
    example: "Which services? · Logo, Website",
  },
  {
    kind: "dropdown",
    label: "Dropdown",
    icon: "chev",
    group: "Choices",
    help: "Pick one from a long list.",
    example: "Country · Japan",
  },
  {
    kind: "yesno",
    label: "Yes / No",
    icon: "check",
    group: "Choices",
    help: "A simple yes or no.",
    example: "Have you worked with us before? · Yes",
  },
  {
    kind: "rating",
    label: "Rating",
    icon: "star",
    group: "Choices",
    help: "Stars or hearts, 3 to 10.",
    example: "How was it? · ★★★★☆",
  },
  {
    kind: "scale",
    label: "Opinion scale",
    icon: "chart",
    group: "Choices",
    help: "A numbered scale with labels at the ends.",
    example: "How likely are you to recommend us? · 0 … 10",
  },
  {
    kind: "email",
    label: "Email",
    icon: "mail",
    group: "Contact",
    help: "Collect a correctly formatted email address. A wrong format is caught before they continue.",
    example: "What is your email address? · john@doe.com",
  },
  {
    kind: "phone",
    label: "Phone number",
    icon: "phone",
    group: "Contact",
    help: "A phone number, checked for a sensible format.",
    example: "Phone · +81 90 1234 5678",
  },
  {
    kind: "link",
    label: "Link",
    icon: "link",
    group: "Contact",
    help: "A website address.",
    example: "Your portfolio · https://…",
  },
  {
    kind: "wallet",
    label: "Wallet address",
    icon: "wallet",
    group: "Contact",
    help: "A QoreChain address. QoreX users can fill it with one tap.",
    example: "Where should we pay you? · qor1…",
  },
  {
    kind: "file",
    label: "File upload",
    icon: "upload",
    group: "Uploads",
    help: "Files are encrypted on the respondent's device before they upload. Only your readers can open them.",
    example: "Upload your brief · brief.pdf",
  },
  {
    kind: "signature",
    label: "Signature",
    icon: "pen",
    group: "Uploads",
    help: "They draw a signature; it is encrypted with the answers.",
    example: "Sign to confirm · ✍",
  },
  {
    kind: "statement",
    label: "Statement",
    icon: "info",
    group: "Layout",
    help: "Text between questions, with a Continue button.",
    example: "Next, a few questions about your budget.",
  },
  {
    kind: "heading",
    label: "Heading",
    icon: "text",
    group: "Layout",
    help: "A section title shown above the next questions.",
    example: "About you",
  },
  {
    kind: "page",
    label: "New section",
    icon: "menu",
    group: "Layout",
    help: "Ends the current section; the next heading starts fresh.",
    example: "—",
  },
];

export function blankBlock(kind: KindInfo["kind"]): FormBlock {
  const id = `q${newId(6)}`;
  const common = { id, title: "", description: "", required: true, hidden: false, half: false };
  const c = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${newId(5)}`, label: `Choice ${i + 1}` }));
  switch (kind) {
    case "page":
      return { id, kind: "page" };
    case "heading":
      return { id, kind: "heading", title: "" };
    case "statement":
      return { id, kind: "statement", title: "", description: "" };
    case "short":
    case "long":
      return { ...common, kind, placeholder: "" };
    case "choice":
      return { ...common, kind, choices: c(2), other: false, randomize: false };
    case "checkboxes":
      return { ...common, kind, choices: c(3), other: false, none: false, randomize: false };
    case "dropdown":
      return { ...common, kind, choices: c(3) };
    case "rating":
      return { ...common, kind, max: 5, icon: "star" };
    case "scale":
      return { ...common, kind, from: 0, to: 10, left: "Not likely", center: "", right: "Very likely" };
    case "file":
      return { ...common, kind, maxFiles: 1, maxMB: 25 };
    default:
      return { ...common, kind };
  }
}

/** Turn a question into another kind, keeping what still makes sense (Tally's "Turn into"). */
export function turnInto(q: Question, kind: QuestionKind): Question {
  const fresh = blankBlock(kind) as Question;
  const keep = {
    id: q.id,
    title: q.title,
    description: q.description,
    required: q.required,
    hidden: q.hidden,
    half: q.half,
  };
  const choices = "choices" in q && "choices" in fresh ? { choices: q.choices } : {};
  return { ...fresh, ...keep, ...choices };
}

export function newForm(account: Account, name: string, title = "Untitled form"): FormDef {
  const id = `f${newId(11)}`;
  return {
    v: 1,
    id,
    owner: account.owner.address,
    name,
    slug: `form-${newId(5)}`,
    title,
    description: "",
    welcome: { enabled: true, button: "Start", showTime: true },
    blocks: [],
    endings: [{ id: `e${newId(6)}`, title: "Thanks! Your answers are sealed and on their way.", body: "" }],
    logic: [],
    settings: { progress: true, numbers: true, closed: false, notify: true, language: "en" },
    readers: [],
    hideReaders: false,
    design: {},
    preview: { title: "", description: "" },
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

type Tpl = {
  key: string;
  title: string;
  description: string;
  blocks: [KindInfo["kind"], string, Partial<Question>?][];
};
export const TEMPLATES: Tpl[] = [
  {
    key: "contact",
    title: "Contact me",
    description: "A short, private contact form.",
    blocks: [
      ["short", "What's your name?"],
      ["email", "Your email, so I can reply"],
      ["long", "What would you like to say, {{q0}}?"],
    ],
  },
  {
    key: "intake",
    title: "Client intake",
    description: "Everything you need before a first call.",
    blocks: [
      ["short", "What's your name?"],
      ["short", "Company", { required: false }],
      ["checkboxes", "Which services do you need?"],
      ["choice", "What's your budget?"],
      ["date", "When should it be ready?"],
      ["file", "Upload a brief", { required: false }],
      ["email", "Your email"],
    ],
  },
  {
    key: "feedback",
    title: "Feedback",
    description: "How did it go?",
    blocks: [
      ["scale", "How likely are you to recommend us?"],
      ["long", "What could we do better?", { required: false }],
      ["yesno", "May we contact you about your answer?"],
    ],
  },
  {
    key: "application",
    title: "Application",
    description: "Apply for a role or a residency.",
    blocks: [
      ["short", "Full name"],
      ["email", "Email"],
      ["link", "Portfolio or website"],
      ["long", "Why you?"],
      ["file", "CV", { required: true }],
      ["signature", "Sign to confirm the information is true"],
    ],
  },
  {
    key: "rsvp",
    title: "Event RSVP",
    description: "Who's coming?",
    blocks: [
      ["short", "Your name"],
      ["yesno", "Will you come?"],
      ["number", "How many guests with you?", { required: false }],
      ["dropdown", "Meal preference", { required: false }],
    ],
  },
];

export function fromTemplate(account: Account, name: string, t: Tpl): FormDef {
  const def = newForm(account, name, t.title);
  def.description = t.description;
  const ids: string[] = [];
  def.blocks = t.blocks.map(([kind, title, extra]) => {
    const b = blankBlock(kind);
    ids.push(b.id);
    const withRecall = title.replace(/\{\{q(\d+)\}\}/g, (_, i: string) => `{{${ids[Number(i)] ?? ""}}}`);
    return { ...b, ...(extra ?? {}), ...("title" in b ? { title: withRecall } : {}) } as FormBlock;
  });
  // A readable link that never clashes with an earlier form made from the same template.
  def.slug = `${t.key}-${newId(4)}`;
  return def;
}

// ---- drafts and publishing --------------------------------------------------------

export function sealDraft(account: Account, def: FormDef): { envelope: Uint8Array; hash: string } {
  const s = sealItem({
    purpose: Purpose.form(def.id),
    readers: [publicRecipient(account.keys.seal)],
    plaintext: utf8(JSON.stringify(def)),
    context: "draft",
    anonymous: true,
  });
  return { envelope: s.envelope, hash: s.hash };
}

export function openDraft(account: Account, id: string, envelope: Uint8Array): FormDef {
  return FormDefSchema.parse(
    JSON.parse(fromUtf8(openItem({ purpose: Purpose.form(id), envelope, keys: account.keys.seal, context: "draft" }))),
  );
}

export async function saveFormDraft(account: Account, token: string, def: FormDef): Promise<void> {
  const d = sealDraft(account, def);
  await api.put("/blobs", d.envelope);
  await api.put("/forms", { id: def.id, slug: def.slug, draftEnvelope: d.hash }, { token });
}

export async function publishForm(
  account: Account,
  token: string,
  def: FormDef,
  publishedVersion: number,
): Promise<FormDef> {
  const body: FormDef = FormDefSchema.parse({
    ...def,
    version: publishedVersion + 1,
    updatedAt: new Date().toISOString(),
  });
  const d = sealDraft(account, body);
  await api.put("/blobs", d.envelope);
  const record = signRecord({
    kind: "form",
    body,
    signer: account.owner.address,
    classical: account.keys.classical,
    pq: account.keys.pq,
  });
  await api.put("/forms", { id: body.id, slug: body.slug, draftEnvelope: d.hash, publish: record }, { token });
  return body;
}

export interface FormRow {
  id: string;
  slug: string;
  draftEnvelope: string | null;
  published: { version: number; at: string | null; title: string; closed: boolean } | null;
  archived: boolean;
  updatedAt: string;
  responses: number;
}

export const questionsOf = (def: Pick<FormDef, "blocks">): Question[] => def.blocks.filter(isQuestion);
