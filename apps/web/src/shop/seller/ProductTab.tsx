"use client";
/**
 * Product tab (Gumroad 3.1): name, description, link, covers, thumbnail,
 * product info, then Pricing, the settings of this kind of product, and
 * how it is delivered.
 */
import { useRef, useState } from "react";
import { Button, CopyValue, Icon, IconButton, Panel, TextArea, TextField, useToast } from "@mizuhiki/ui";
import type { ProductDef } from "@mizuhiki/core";
import { mediaUrl, ApiFailure } from "@/lib/api";
import { SITE_URL } from "@/lib/site";
import { slugify, uploadImage } from "../engine";
import { move, productPath, wrapSelection } from "./model";
import type { EditorProps } from "./editorTypes";
import { PricingPanel } from "./PricingPanel";
import { KindPanel } from "./KindPanel";
import { DeliveryPanel } from "./DeliveryPanel";
import s from "./seller.module.css";

const CTAS: ProductDef["cta"][] = ["I want this!", "Buy this", "Pay", "Book a time", "Support"];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

export function ProductTab(props: EditorProps) {
  const { draft, patch, name, slugError } = props;
  const def = draft.def;
  const toast = useToast();
  const link = `${SITE_URL}${productPath(name, def.slug)}`;
  const slugBad = !/^[a-z0-9-]{1,48}$/.test(def.slug) ? "Use lowercase letters, numbers and dashes (up to 48)." : null;

  return (
    <div className={s.tabStack}>
      <Panel title="Product" kicker="しょうひん">
        <div className={s.stack}>
          <TextField
            label="Name"
            value={def.title}
            maxLength={120}
            onChange={(e) => patch({ title: e.target.value }, "title")}
            error={def.title.trim() ? undefined : "Give the product a name."}
          />
          <Description value={def.description} onChange={(v) => patch({ description: v }, "description")} />
          <div className={s.stack}>
            <TextField
              label="Link"
              prefix={`/@${name}/p/`}
              value={def.slug}
              maxLength={48}
              spellCheck={false}
              autoCapitalize="none"
              onChange={(e) =>
                patch(
                  {
                    slug: e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9-]/g, "-")
                      .slice(0, 48),
                  },
                  "slug",
                )
              }
              onBlur={() => {
                const clean = slugify(def.slug);
                if (clean && clean !== def.slug) patch({ slug: clean });
              }}
              error={slugBad ?? slugError ?? undefined}
              hint={
                props.row.record && props.row.record.body.slug !== def.slug
                  ? "Changing the link breaks the old one once you publish."
                  : undefined
              }
            />
            <div className={s.linkLine}>
              <CopyValue
                value={link}
                label="product link"
                onCopied={(ok) =>
                  toast.show(ok ? "Link copied" : "Copy is not allowed here", ok ? {} : { tone: "error" })
                }
              />
              {!props.row.record || props.row.status !== "published" ? (
                <small className={s.muted}>Live once you publish.</small>
              ) : null}
            </div>
          </div>
        </div>
      </Panel>

      <Images {...props} />

      <Panel title="Product info" kicker="くわしく">
        <div className={s.stack}>
          <label className={s.selectField}>
            <span>Call to action</span>
            <select value={def.cta} onChange={(e) => patch({ cta: e.target.value as ProductDef["cta"] })}>
              {CTAS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Summary"
            value={def.summary}
            maxLength={200}
            counter
            placeholder="You'll get…"
            onChange={(e) => patch({ summary: e.target.value }, "summary")}
          />
          <Details def={def} patch={patch} />
        </div>
      </Panel>

      <PricingPanel {...props} />
      <KindPanel {...props} />
      <DeliveryPanel {...props} />
    </div>
  );
}

function Description({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const wrap = (k: "b" | "i" | "a") => {
    const el = ref.current;
    if (!el) return;
    const r = wrapSelection(value, el.selectionStart, el.selectionEnd, k);
    onChange(r.value.slice(0, 8000));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.start, r.end);
    });
  };
  return (
    <div className={s.descField}>
      <div className={s.toolbar} role="toolbar" aria-label="Formatting">
        <button type="button" onClick={() => wrap("b")} aria-label="Bold" title="Bold">
          <b>B</b>
        </button>
        <button type="button" onClick={() => wrap("i")} aria-label="Italic" title="Italic">
          <i>I</i>
        </button>
        <button type="button" onClick={() => wrap("a")} aria-label="Link" title="Link">
          <Icon name="link" size={16} />
        </button>
        <small>A blank line starts a new paragraph.</small>
      </div>
      <TextArea
        ref={ref}
        label="Description"
        hideLabel
        value={value}
        maxLength={8000}
        rows={7}
        placeholder="Describe your product…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!(e.metaKey || e.ctrlKey)) return;
          const k = e.key.toLowerCase();
          if (k === "b" || k === "i" || k === "k") {
            e.preventDefault();
            wrap(k === "b" ? "b" : k === "i" ? "i" : "a");
          }
        }}
      />
    </div>
  );
}

function Details({ def, patch }: { def: ProductDef; patch: EditorProps["patch"] }) {
  const set = (i: number, p: Partial<{ k: string; v: string }>) =>
    patch({ details: def.details.map((d, j) => (j === i ? { ...d, ...p } : d)) }, `detail-${i}`);
  return (
    <div className={s.stack}>
      <div className={s.subHead}>
        <b>What&rsquo;s included</b>
        <small>
          Call out the features that help people decide to buy, like &ldquo;Files: 22&rdquo; or &ldquo;Updates:
          Lifetime&rdquo;.
        </small>
      </div>
      {def.details.length ? (
        <ul className={s.kvList}>
          {def.details.map((d, i) => (
            <li key={i} className={s.kvRow}>
              <TextField
                label="Detail"
                hideLabel
                placeholder="Attribute"
                value={d.k}
                maxLength={40}
                onChange={(e) => set(i, { k: e.target.value })}
                error={d.k.trim() ? undefined : "Name it"}
              />
              <TextField
                label="Value"
                hideLabel
                placeholder="Value"
                value={d.v}
                maxLength={80}
                onChange={(e) => set(i, { v: e.target.value })}
              />
              <IconButton
                icon="trash"
                label={`Remove ${d.k || "detail"}`}
                onClick={() => patch({ details: def.details.filter((_, j) => j !== i) })}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {def.details.length < 12 ? (
        <div>
          <Button
            size="sm"
            variant="line"
            icon="plus"
            onClick={() => patch({ details: [...def.details, { k: "", v: "" }] })}
          >
            Add detail
          </Button>
        </div>
      ) : (
        <small className={s.muted}>Twelve details is the most.</small>
      )}
    </div>
  );
}

/** Reads an image's size so the size hints can say plainly when it is too small. */
const sizeOf = (file: File) =>
  new Promise<{ w: number; h: number } | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });

function Images({ draft, patch, tokened }: EditorProps) {
  const def = draft.def;
  const toast = useToast();
  const [busy, setBusy] = useState<"cover" | "thumb" | null>(null);
  const [note, setNote] = useState<{ cover?: string; thumb?: string }>({});
  const coverIn = useRef<HTMLInputElement>(null);
  const thumbIn = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null, where: "cover" | "thumb") => {
    const list = [...(files ?? [])];
    if (!list.length) return;
    setBusy(where);
    setNote((n) => ({ ...n, [where]: undefined }));
    const added: { hash: string; type: string }[] = [];
    const warnings: string[] = [];
    try {
      const room = where === "cover" ? 8 - def.covers.length : 1;
      for (const f of list.slice(0, Math.max(0, room))) {
        if (!IMAGE_TYPES.includes(f.type)) {
          warnings.push(`${f.name} is not a PNG, JPEG or WebP image, so it was skipped.`);
          continue;
        }
        if (f.size > 3 * 1024 * 1024) {
          warnings.push(`${f.name} is larger than 3 MB, so it was skipped.`);
          continue;
        }
        const dim = await sizeOf(f);
        if (dim && where === "cover" && (dim.w < 1280 || dim.h < 720))
          warnings.push(`${f.name} is ${dim.w}×${dim.h}; it may look soft. At least 1280×720 looks sharp.`);
        if (dim && where === "thumb" && (dim.w < 600 || dim.h < 600 || Math.abs(dim.w - dim.h) > 2))
          warnings.push(
            `${f.name} is ${dim.w}×${dim.h}. A square of at least 600×600 looks best; it is cropped to a square.`,
          );
        added.push(await uploadImage(await tokened(), f));
      }
      if (list.length > room)
        warnings.push(
          where === "cover"
            ? "Eight covers is the most; the rest were skipped."
            : "One thumbnail; the first image was used.",
        );
      if (where === "cover" && added.length) patch({ covers: [...def.covers, ...added].slice(0, 8) });
      if (where === "thumb" && added[0]) patch({ thumbnail: added[0] });
      if (added.length)
        toast.show(
          where === "cover" ? (added.length === 1 ? "Cover added" : `${added.length} covers added`) : "Thumbnail added",
        );
    } catch (e) {
      warnings.push(e instanceof ApiFailure ? e.message : "The image did not upload. Nothing was added.");
    } finally {
      setBusy(null);
      setNote((n) => ({ ...n, [where]: warnings.join(" ") || undefined }));
    }
  };

  return (
    <Panel title="Images" kicker="しゃしん">
      <div className={s.stack}>
        <div className={s.subHead}>
          <b>Cover</b>
          <small>
            Horizontal images, at least 1280×720. Several make a carousel; the first one leads. Images are public.
          </small>
        </div>
        <ul className={s.covers}>
          {def.covers.map((c, i) => (
            <li key={c.hash} className={s.coverItem}>
              <img src={mediaUrl(c.hash)} alt={`Cover ${i + 1}`} />
              {i === 0 ? <span className={s.coverBadge}>First</span> : null}
              <div className={s.coverTools}>
                <IconButton
                  icon="back"
                  label="Move earlier"
                  disabled={i === 0}
                  onClick={() => patch({ covers: move(def.covers, i, i - 1) })}
                />
                <IconButton
                  icon="arrow"
                  label="Move later"
                  disabled={i === def.covers.length - 1}
                  onClick={() => patch({ covers: move(def.covers, i, i + 1) })}
                />
                <IconButton
                  icon="trash"
                  label={`Remove cover ${i + 1}`}
                  onClick={() => patch({ covers: def.covers.filter((_, j) => j !== i) })}
                />
              </div>
            </li>
          ))}
          {def.covers.length < 8 ? (
            <li>
              <button
                type="button"
                className={s.addImage}
                onClick={() => coverIn.current?.click()}
                disabled={busy === "cover"}
                aria-busy={busy === "cover"}
              >
                {busy === "cover" ? <span className={s.spinner} aria-hidden="true" /> : <Icon name="image" size={26} />}
                <span>{busy === "cover" ? "Uploading…" : "Upload images"}</span>
              </button>
            </li>
          ) : null}
        </ul>
        <input
          ref={coverIn}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          multiple
          hidden
          onChange={(e) => void upload(e.target.files, "cover").then(() => (e.target.value = ""))}
        />
        {note.cover ? <p className={s.warn}>{note.cover}</p> : null}

        <div className={s.thumbRow}>
          <div className={s.thumbBox}>
            {def.thumbnail ? (
              <img src={mediaUrl(def.thumbnail.hash)} alt="Thumbnail" />
            ) : def.covers[0] ? (
              <img src={mediaUrl(def.covers[0].hash)} alt="Thumbnail from the first cover" />
            ) : (
              <Icon name="image" size={28} />
            )}
          </div>
          <div className={s.stack}>
            <div className={s.subHead}>
              <b>Thumbnail</b>
              <small>
                Shows in your Shop section and the buyer&rsquo;s library. Square, at least 600×600. Without one, the
                first cover is cropped to fit.
              </small>
            </div>
            <div className={s.rowActions}>
              <Button
                size="sm"
                variant="line"
                icon="upload"
                busy={busy === "thumb"}
                onClick={() => thumbIn.current?.click()}
              >
                {def.thumbnail ? "Replace" : "Upload"}
              </Button>
              {def.thumbnail ? (
                <Button size="sm" variant="ghost" icon="trash" onClick={() => patch({ thumbnail: null })}>
                  Remove
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        <input
          ref={thumbIn}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          hidden
          onChange={(e) => void upload(e.target.files, "thumb").then(() => (e.target.value = ""))}
        />
        {note.thumb ? <p className={s.warn}>{note.thumb}</p> : null}
      </div>
    </Panel>
  );
}
