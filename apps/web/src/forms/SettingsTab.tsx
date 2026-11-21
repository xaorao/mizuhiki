"use client";
/**
 * Form settings (spec 5.9): display, access and scheduling (our grouping after
 * Typeform's "Access & Scheduling"), notifications, language, readers, design
 * (logo, cover, accent; everything else comes from the page theme) and the link
 * with its preview card. Every change goes through `update`; typing coalesces.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Icon,
  IconButton,
  LockLine,
  Panel,
  Readers,
  TextArea,
  TextField,
  ToggleRow,
  useToast,
} from "@mizuhiki/ui";
import { normalizeNameInput, type FormDef } from "@mizuhiki/core";
import { api, ApiFailure, mediaUrl } from "@/lib/api";
import { SITE_HOST } from "@/lib/site";
import { contrast } from "@/page/theme";
import { AvatarCrop } from "@/onboarding/AvatarCrop";
import type { TabProps } from "./tabTypes";
import s from "./settings.module.css";
import { failureText } from "@/lib/failure";

const SLUG_RE = /^[a-z0-9-]{1,48}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const MAX_READERS = 10;
const MAX_LIMIT = 1_000_000;
const MEDIA_MAX = 3 * 1024 * 1024;
/** WCAG AA for normal text: the accent carries white button labels and small question numbers. */
const MIN_CONTRAST = 4.5;

/** Brand colours that hold white text at 4.5:1 or more (checked against tokens.css). */
const SWATCHES: { hex: string; name: string }[] = [
  { hex: "#c2300f", name: "Beni red" },
  { hex: "#a92a22", name: "Deep cord" },
  { hex: "#a8173f", name: "Ume plum" },
  { hex: "#7d5a0e", name: "Kohaku amber" },
  { hex: "#24461c", name: "Matcha" },
  { hex: "#1f2d6b", name: "Sora indigo" },
  { hex: "#4b2a8a", name: "Fuji violet" },
  { hex: "#2b2340", name: "Sumi ink" },
];

const pad = (n: number) => String(n).padStart(2, "0");
/** ISO instant to the value a datetime-local input shows, in this device's time zone. */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const zoneName = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "your time zone";
  }
};

/** Shrink an image in the browser to fit a box and re-encode it (drops camera metadata too). */
async function shrinkImage(file: File, maxW: number, maxH: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("This file is not an image we can read. Try a PNG, JPEG or WebP."));
      i.src = url;
    });
    const k = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("This browser could not prepare the image. Try another browser.");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    for (const q of [0.9, 0.8, 0.68]) {
      const b = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/webp", q));
      if (b && b.size <= MEDIA_MAX) return b;
    }
    throw new Error("This image stays over 3 MB even after shrinking. Try a smaller one.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sameAccess(a: FormDef["settings"], b: FormDef["settings"]): boolean {
  return a.closed === b.closed && a.limit === b.limit && a.closeAt === b.closeAt;
}

export function SettingsTab(props: TabProps) {
  const { def, update, published } = props;
  const set = def.settings;
  const settings = (patch: Partial<FormDef["settings"]>, coalesce?: string) =>
    update((d) => ({ ...d, settings: { ...d.settings, ...patch } }), coalesce);

  const accessPending = published ? !sameAccess(set, published.settings) : false;

  return (
    <div className={s.tab}>
      <Panel title="Display" kicker="ひょうじ">
        <div className={s.stack}>
          <ToggleRow
            title="Progress bar"
            detail="A thin bar at the top shows how far along they are."
            checked={set.progress}
            onChange={(progress) => settings({ progress })}
          />
          <ToggleRow
            title="Question numbers"
            detail="Shows 1, 2, 3… before each question."
            checked={set.numbers}
            onChange={(numbers) => settings({ numbers })}
          />
        </div>
      </Panel>

      <Panel title="Access and scheduling" kicker="うけつけ">
        <div className={s.stack}>
          {published === null ? (
            <p className={s.note}>
              <Icon name="info" size={16} />
              <span className={s.noteGrow}>These apply from the moment you publish the form.</span>
            </p>
          ) : accessPending ? (
            <p className={s.note}>
              <Icon name="clock" size={16} />
              <span className={s.noteGrow}>
                <b>Not live yet.</b> Publish to apply these changes. Until then, respondents get the published settings.
              </span>
            </p>
          ) : null}
          <ToggleRow
            title="Close the form now"
            detail={
              set.closed
                ? "Closed. Visitors see that it is not taking answers, and nothing new can arrive."
                : "Stops new answers right away. Answers you already have stay yours."
            }
            checked={set.closed}
            onChange={(closed) => settings({ closed })}
          />
          <LimitField value={set.limit} onChange={(limit) => update((d) => withLimit(d, limit), "settings-limit")} />
          <CloseDateField value={set.closeAt} onChange={(closeAt) => update((d) => withCloseAt(d, closeAt))} />
          <p className={s.help}>
            Mizuhiki counts answers and checks the date without opening them, so these rules work while answers stay
            sealed.
          </p>
        </div>
      </Panel>

      <Panel title="Notifications" kicker="おしらせ">
        <ToggleRow
          title="Tell me when an answer arrives"
          detail="You get a notice that says only that an answer came in. Answers are only readable on your devices."
          checked={set.notify}
          onChange={(notify) => settings({ notify })}
        />
      </Panel>

      <Panel title="Language" kicker="ことば">
        <div className={s.fixed}>
          <span>
            <b>English</b>
          </span>
          <span className={s.help}>Buttons, hints and errors respondents see are in English for now.</span>
        </div>
      </Panel>

      <ReadersPanel {...props} />
      <DesignPanel {...props} />
      <LinkPanel {...props} />
    </div>
  );
}

function withLimit(d: FormDef, limit: number | undefined): FormDef {
  const { limit: _old, ...rest } = d.settings;
  return { ...d, settings: limit === undefined ? rest : { ...rest, limit } };
}
function withCloseAt(d: FormDef, closeAt: string | undefined): FormDef {
  const { closeAt: _old, ...rest } = d.settings;
  return { ...d, settings: closeAt === undefined ? rest : { ...rest, closeAt } };
}

function LimitField({ value, onChange }: { value: number | undefined; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState(value === undefined ? "" : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(value === undefined ? "" : String(value));
    setError(null);
  }, [value]);
  const change = (raw: string) => {
    const t = raw.replace(/[\s,._]/g, "");
    setText(t);
    if (t === "") {
      setError(null);
      onChange(undefined);
      return;
    }
    if (!/^\d+$/.test(t)) return setError("Use a whole number, like 50.");
    const n = Number(t);
    if (n < 1) return setError("Use 1 or more. Clear the box to take any number of answers.");
    if (n > MAX_LIMIT) return setError("Use 1,000,000 or fewer.");
    setError(null);
    onChange(n);
  };
  return (
    <div className={s.fieldRow}>
      <TextField
        label="Stop after this many answers"
        inputMode="numeric"
        placeholder="No limit"
        value={text}
        onChange={(e) => change(e.target.value)}
        error={error ?? undefined}
        hint={
          value === undefined
            ? "Leave empty to take any number of answers."
            : `The form closes itself after answer ${value.toLocaleString("en")}.`
        }
      />
      {text !== "" ? (
        <Button className={s.fieldAction} variant="ghost" size="sm" icon="x" onClick={() => change("")}>
          No limit
        </Button>
      ) : null}
    </div>
  );
}

function CloseDateField({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [text, setText] = useState(toLocalInput(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(toLocalInput(value));
    setError(null);
  }, [value]);
  const change = (v: string) => {
    setText(v);
    if (v === "") {
      setError(null);
      onChange(undefined);
      return;
    }
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return setError("Pick a full date and time.");
    if (d.getTime() <= Date.now()) return setError("That moment has passed. Pick a date and time in the future.");
    setError(null);
    onChange(d.toISOString());
  };
  const passed = value !== undefined && Date.parse(value) <= Date.now();
  return (
    <div className={s.fieldRow}>
      <TextField
        label="Close on a date"
        type="datetime-local"
        className={s.dateInput}
        value={text}
        min={toLocalInput(new Date(Date.now() + 60_000).toISOString())}
        onChange={(e) => change(e.target.value)}
        error={error ?? (passed ? "This date has passed, so the form no longer takes answers." : undefined)}
        hint={
          value === undefined
            ? "Leave empty to keep it open until you close it."
            : `Closes ${new Date(value).toLocaleString("en", { dateStyle: "long", timeStyle: "short" })}, ${zoneName()} time.`
        }
      />
      {text !== "" ? (
        <Button className={s.fieldAction} variant="ghost" size="sm" icon="x" onClick={() => change("")}>
          No date
        </Button>
      ) : null}
    </div>
  );
}

interface NameCheck {
  name: string;
  available: boolean;
  owner?: string;
  message?: string;
}

function ReadersPanel({ def, update, ownerName }: TabProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const me = normalizeNameInput(ownerName);

  const add = async () => {
    const name = normalizeNameInput(text.trim().replace(/^@+/, ""));
    if (!name) return setError("Type their @name.");
    if (name === me) return setError("That's you. Answers are always sealed to you.");
    if (def.readers.some((r) => r.name === name)) return setError(`@${name} already reads answers.`);
    if (def.readers.length >= MAX_READERS) return setError("A form can have up to 10 readers besides you.");
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<NameCheck>(`/names/${encodeURIComponent(name)}`);
      if (!r.owner) {
        setError(
          r.available
            ? `No one has @${name} yet. Check the spelling.`
            : (r.message ?? `@${name} is not a name anyone can have.`),
        );
        return;
      }
      const owner = r.owner;
      if (owner === def.owner) return setError("That name is yours. Answers are always sealed to you.");
      if (def.readers.some((x) => x.address === owner)) return setError(`That account already reads answers.`);
      try {
        await api.get(`/cards/${owner}`);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 404) {
          setError(
            `@${name} has not finished setting up Mizuhiki, so answers cannot be sealed to them yet. Ask them to open Mizuhiki once, then add them again.`,
          );
          return;
        }
        throw e;
      }
      update((d) =>
        d.readers.some((x) => x.address === owner)
          ? d
          : { ...d, readers: [...d.readers, { address: owner, name: r.name.slice(0, 40), note: "" }] },
      );
      setText("");
      toast.show(`@${name} can read new answers`);
    } catch (e) {
      setError(failureText(e, "Could not look up that name. Nothing changed."));
    } finally {
      setBusy(false);
    }
  };

  const remove = (address: string, name: string) => {
    update((d) => ({ ...d, readers: d.readers.filter((r) => r.address !== address) }));
    toast.show(`@${name} removed. Answers already sent stay readable to them.`);
  };

  return (
    <Panel title="Who can read answers" kicker="よみて">
      <div className={s.stack}>
        <LockLine>Answers are sealed to you{def.readers.length ? " and the readers below" : ""}.</LockLine>
        <ul className={s.readerList}>
          <li className={s.reader}>
            <span className={[s.readerIcon, s.readerIconYou].join(" ")}>
              <Icon name="key" size={18} />
            </span>
            <span className={s.readerMain}>
              <b>@{ownerName}</b>
              <small>You, always</small>
            </span>
            <span />
          </li>
          {def.readers.map((r) => (
            <li key={r.address} className={s.reader}>
              <span className={s.readerIcon}>
                <Icon name="users" size={18} />
              </span>
              <span className={s.readerMain}>
                <b>@{r.name}</b>
                <TextField
                  label={`Note for @${r.name}`}
                  hideLabel
                  placeholder="Add a note, like assistant"
                  maxLength={60}
                  value={r.note}
                  onChange={(e) => {
                    const note = e.target.value.slice(0, 60);
                    update(
                      (d) => ({
                        ...d,
                        readers: d.readers.map((x) => (x.address === r.address ? { ...x, note } : x)),
                      }),
                      `reader-note-${r.address}`,
                    );
                  }}
                />
              </span>
              <IconButton
                icon="trash"
                label={`Remove @${r.name}`}
                size="sm"
                onClick={() => remove(r.address, r.name)}
              />
            </li>
          ))}
        </ul>
        <form
          className={s.fieldRow}
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <TextField
            label="Add a reader (e.g. an assistant)"
            prefix="@"
            placeholder="name"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            error={error ?? undefined}
            hint="They need their own Mizuhiki. Only answers sent after you publish are sealed to them."
          />
          <Button
            className={s.fieldAction}
            type="submit"
            variant="line"
            icon="plus"
            busy={busy}
            disabled={!text.trim() || def.readers.length >= MAX_READERS}
          >
            Add reader
          </Button>
        </form>
        <ToggleRow
          title="Hide who can read answers"
          detail="Respondents won't see the list. The readers' accounts are still named in the form's public definition."
          checked={def.hideReaders}
          onChange={(hideReaders) => update((d) => ({ ...d, hideReaders }))}
        />
        <div className={s.stack}>
          <p className={s.subhead}>What respondents see</p>
          <Readers
            hidden={def.hideReaders}
            readers={[
              { label: `@${ownerName}` },
              ...def.readers.map((r) => ({ label: `@${r.name}`, detail: r.note || undefined })),
            ]}
          />
        </div>
      </div>
    </Panel>
  );
}

function DesignPanel({ def, update, token }: TabProps) {
  const toast = useToast();
  const [uploading, setUploading] = useState<"logo" | "cover" | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const accent = def.design.accent;
  const [hex, setHex] = useState(accent ?? "");
  const [hexError, setHexError] = useState<string | null>(null);
  useEffect(() => {
    setHex(accent ?? "");
    setHexError(null);
  }, [accent]);

  const upload = async (blob: Blob, slot: "logo" | "cover") => {
    setUploading(slot);
    try {
      const t = await token();
      const m = await api.put<{ hash: string; type: string }>("/media", new Uint8Array(await blob.arrayBuffer()), {
        token: t,
      });
      update((d) => ({ ...d, design: { ...d.design, [slot]: { hash: m.hash, type: m.type } } }));
      toast.show(slot === "logo" ? "Logo added" : "Cover added");
    } catch (e) {
      toast.show(failureText(e, "The image was not uploaded. Nothing changed."), {
        tone: "error",
      });
    } finally {
      setUploading(null);
    }
  };
  const removeImage = (slot: "logo" | "cover") =>
    update((d) => {
      const { [slot]: _gone, ...rest } = d.design;
      return { ...d, design: rest };
    });
  const pickCover = async (f: File) => {
    try {
      setUploading("cover");
      await upload(await shrinkImage(f, 1920, 1080), "cover");
    } catch (e) {
      setUploading(null);
      toast.show(failureText(e, "The image was not uploaded."), { tone: "error" });
    }
  };

  const setAccent = (v: string | undefined) =>
    update((d) => {
      const { accent: _old, ...rest } = d.design;
      return { ...d, design: v === undefined ? rest : { ...rest, accent: v } };
    }, "design-accent");
  const typeHex = (raw: string) => {
    const t = raw.trim();
    setHex(t);
    if (t === "") {
      setHexError(null);
      setAccent(undefined);
      return;
    }
    const v = (t.startsWith("#") ? t : `#${t}`).toLowerCase();
    if (!HEX_RE.test(v)) return setHexError("Use six hex digits, like #c2300f.");
    const ratio = contrast(v, "#ffffff");
    if (ratio < MIN_CONTRAST)
      return setHexError(
        `White text on this colour is ${ratio.toFixed(1)}:1, too faint to read. Pick a darker colour (4.5:1 or more): it carries button labels and question numbers.`,
      );
    setHexError(null);
    setAccent(v);
  };

  return (
    <Panel title="Design" kicker="デザイン">
      <div className={s.stack}>
        <p className={s.help}>
          The form uses your page&rsquo;s theme: fonts, wallpaper and buttons. Add a logo, a cover and an accent colour
          here. Images are public, like your page.
        </p>
        {logoFile ? (
          <AvatarCrop
            file={logoFile}
            onCancel={() => setLogoFile(null)}
            onDone={(b) => {
              setLogoFile(null);
              void upload(b, "logo");
            }}
          />
        ) : (
          <div className={s.images}>
            <div className={s.imageSlot}>
              <p className={s.subhead}>Logo</p>
              <button
                type="button"
                className={[s.thumb, s.thumbLogo].join(" ")}
                onClick={() => logoInput.current?.click()}
                aria-label={def.design.logo ? "Change logo" : "Add a logo"}
              >
                {def.design.logo ? (
                  <img src={mediaUrl(def.design.logo.hash)} alt="" />
                ) : (
                  <Icon name="image" size={26} />
                )}
              </button>
              <div className={s.row}>
                <Button size="sm" variant="line" busy={uploading === "logo"} onClick={() => logoInput.current?.click()}>
                  {def.design.logo ? "Change" : "Add logo"}
                </Button>
                {def.design.logo ? (
                  <Button size="sm" variant="ghost" onClick={() => removeImage("logo")}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
            <div className={s.imageSlot}>
              <p className={s.subhead}>Cover</p>
              <button
                type="button"
                className={[s.thumb, s.thumbCover].join(" ")}
                onClick={() => coverInput.current?.click()}
                aria-label={def.design.cover ? "Change cover" : "Add a cover"}
              >
                {def.design.cover ? (
                  <img src={mediaUrl(def.design.cover.hash)} alt="" />
                ) : (
                  <Icon name="image" size={26} />
                )}
              </button>
              <div className={s.row}>
                <Button
                  size="sm"
                  variant="line"
                  busy={uploading === "cover"}
                  onClick={() => coverInput.current?.click()}
                >
                  {def.design.cover ? "Change" : "Add cover"}
                </Button>
                {def.design.cover ? (
                  <Button size="sm" variant="ghost" onClick={() => removeImage("cover")}>
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        )}
        <p className={s.help}>
          PNG, JPEG or WebP. The logo is cropped square; the cover is shrunk to fit 1920 × 1080 and shown as a wide
          strip.
        </p>
        <input
          ref={logoInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setLogoFile(f);
            e.target.value = "";
          }}
        />
        <input
          ref={coverInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickCover(f);
            e.target.value = "";
          }}
        />

        <p className={s.subhead}>Accent colour</p>
        <div className={s.swatches} role="radiogroup" aria-label="Accent colour">
          <button
            type="button"
            role="radio"
            aria-checked={accent === undefined}
            aria-label="Page colour (cord red)"
            title="Page colour"
            className={[s.swatch, s.swatchPage, accent === undefined ? s.swatchOn : ""].join(" ")}
            onClick={() => setAccent(undefined)}
          >
            {accent === undefined ? <Icon name="check" size={18} /> : null}
          </button>
          {SWATCHES.map((w) => (
            <button
              key={w.hex}
              type="button"
              role="radio"
              aria-checked={accent === w.hex}
              aria-label={w.name}
              title={w.name}
              className={[s.swatch, accent === w.hex ? s.swatchOn : ""].join(" ")}
              style={{ background: w.hex }}
              onClick={() => setAccent(w.hex)}
            >
              {accent === w.hex ? <Icon name="check" size={18} /> : null}
            </button>
          ))}
        </div>
        <div className={s.fieldRow}>
          <TextField
            label="Hex colour"
            placeholder="#c2300f"
            maxLength={7}
            spellCheck={false}
            autoCapitalize="none"
            value={hex}
            onChange={(e) => typeHex(e.target.value)}
            error={hexError ?? undefined}
            hint="Leave empty to use your page colour. It must keep white text readable."
          />
          <span
            className={[s.accentSample, s.fieldAction].join(" ")}
            style={{ background: accent ?? "var(--cord)" }}
            aria-hidden="true"
          >
            Start <Icon name="arrow" size={14} />
          </span>
        </div>
      </div>
    </Panel>
  );
}

function LinkPanel({ def, update, published, ownerName, token }: TabProps) {
  const [slug, setSlug] = useState(def.slug);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<string[]>([]);
  useEffect(() => {
    setSlug(def.slug);
    setError(null);
  }, [def.slug]);
  // The owner's other forms, so a link clash shows here instead of at publish.
  useEffect(() => {
    const life = { alive: true };
    void token()
      .then((t) => api.get<{ forms: { id: string; slug: string }[] }>("/owner/forms", { token: t }))
      .then(
        (r) => {
          if (life.alive) setTaken(r.forms.filter((f) => f.id !== def.id).map((f) => f.slug));
        },
        () => undefined,
      );
    return () => {
      life.alive = false;
    };
  }, [token, def.id]);

  const typeSlug = (raw: string) => {
    const v = raw.toLowerCase().replace(/[\s_]+/g, "-");
    setSlug(v);
    if (!v) return setError("The link needs a name: letters, numbers and dashes.");
    if (!SLUG_RE.test(v)) return setError("Use lowercase letters, numbers and dashes, up to 48.");
    if (taken.includes(v)) return setError(`You already have a form at /f/${v}. Pick another.`);
    setError(null);
    update((d) => ({ ...d, slug: v }), "settings-slug");
  };

  const host = SITE_HOST;
  const title = def.preview.title.trim() || def.title.trim() || "Untitled form";
  // Same fallbacks as the form page's metadata (app/p/[name]/[[...path]]/page.tsx).
  const description =
    def.preview.description.trim() ||
    def.description.trim() ||
    `A form by @${ownerName}. Answers are sealed on your device; only @${ownerName} can read them.`;
  const preview = (patch: Partial<FormDef["preview"]>, key: string) =>
    update((d) => ({ ...d, preview: { ...d.preview, ...patch } }), key);

  return (
    <Panel title="Link and preview" kicker="リンク">
      <div className={s.stack}>
        <TextField
          label="Form link"
          prefix={`${host}/@${ownerName}/f/`}
          maxLength={48}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          value={slug}
          onChange={(e) => typeSlug(e.target.value)}
          error={error ?? undefined}
          hint="Lowercase letters, numbers and dashes."
        />
        <p className={s.urlPreview}>
          {host}/@{ownerName}/f/<b>{SLUG_RE.test(slug) ? slug : def.slug}</b>
        </p>
        {published && published.slug !== def.slug ? (
          <p className={s.note}>
            <Icon name="alert" size={16} />
            <span className={s.noteGrow}>
              <b>The link changes when you publish.</b> /f/{published.slug} stops working then, so update anywhere you
              shared it, including the button on your page.
            </span>
          </p>
        ) : null}

        <p className={s.subhead}>Link preview</p>
        <p className={s.help}>What chat apps and social sites show when someone shares the link.</p>
        <TextField
          label="Preview title"
          placeholder={def.title || "Your form title"}
          maxLength={120}
          counter
          value={def.preview.title}
          onChange={(e) => preview({ title: e.target.value.slice(0, 120) }, "preview-title")}
          hint="Leave empty to use the form title."
        />
        <TextArea
          label="Preview description"
          placeholder={def.description || "One line about what the form is for"}
          maxLength={240}
          counter
          rows={3}
          value={def.preview.description}
          onChange={(e) => preview({ description: e.target.value.slice(0, 240) }, "preview-description")}
          hint="Leave empty to use the form description."
        />
        <div className={s.card} aria-label="Link preview">
          <div className={s.cardText}>
            <small>Mizuhiki · {host}</small>
            <b>{title}</b>
            <span>{description}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
