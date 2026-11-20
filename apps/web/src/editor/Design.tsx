"use client";
/**
 * Design tab (spec 5.3, Linktree): header and profile, curated themes,
 * wallpaper, text, buttons, footer. Changes collect in a local copy with its
 * own undo and an explicit Save ("Unsaved changes"). A cross-setting guard
 * keeps text readable and says what it changed, with Undo.
 */
import { useEffect, useRef, useState } from "react";
import {
  Button,
  ChoiceCard,
  Icon,
  IconButton,
  Kicker,
  Musubi,
  Oops,
  PhoneFrame,
  Segmented,
  Skeleton,
  StatusChip,
  TextArea,
  TextField,
  ToggleRow,
  useToast,
} from "@mizuhiki/ui";
import { DEFAULT_THEME, type Manifest, type Theme } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { PageView } from "@/page/PageView";
import { contrast } from "@/page/theme";
import { api, mediaUrl } from "@/lib/api";
import { AvatarCrop } from "@/onboarding/AvatarCrop";
import { TEMPLATES } from "@/onboarding/model";
import { markChecklist } from "./checklist";
import s from "./design.module.css";
import { failureText } from "@/lib/failure";

type Look = Pick<Manifest, "theme" | "displayName" | "bio" | "avatar">;

const FONT_CARDS: { id: Theme["font"]; name: string; line: string }[] = [
  { id: "round", name: "Rounded", line: "Friendly and soft. Mizuhiki's own voice." },
  { id: "sans", name: "Clean", line: "Calm and exact. Good for clinics and firms." },
  { id: "jp", name: "Maru", line: "Rounded Japanese gothic. Warm, a little playful." },
];

export function Design() {
  const o = useOwner();
  const toast = useToast();
  const d = o.draft;
  const [look, setLook] = useState<Look | null>(null);
  const hist = useRef<{ past: Look[]; future: Look[] }>({ past: [], future: [] });
  const [, bump] = useState(0);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState<"avatar" | "wallpaper" | null>(null);
  const avatarInput = useRef<HTMLInputElement>(null);
  const wallInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (d && !look)
      setLook({
        theme: d.manifest.theme,
        displayName: d.manifest.displayName,
        bio: d.manifest.bio,
        avatar: d.manifest.avatar,
      });
  }, [d, look]);

  if (!d || !look)
    return (
      <div className={s.wrap}>
        {o.loadError ? (
          <Oops
            title="Your page did not open"
            action={
              <Button variant="line" size="sm" icon="refresh" onClick={o.reload}>
                Try again
              </Button>
            }
          >
            {o.loadError}
          </Oops>
        ) : (
          <Skeleton lines={4} />
        )}
      </div>
    );
  const saved: Look = {
    theme: d.manifest.theme,
    displayName: d.manifest.displayName,
    bio: d.manifest.bio,
    avatar: d.manifest.avatar,
  };
  const unsaved = JSON.stringify(saved) !== JSON.stringify(look);

  const change = (fn: (l: Look) => Look) => {
    const next = fn(look);
    hist.current = { past: [...hist.current.past.slice(-50), look], future: [] };
    // Cross-setting guard: text must stay readable on the wallpaper.
    const ratio = contrast(next.theme.text, next.theme.wallpaper.a);
    if (ratio < 3) {
      const fixed =
        contrast("#2b2340", next.theme.wallpaper.a) >= contrast("#ffffff", next.theme.wallpaper.a)
          ? "#2b2340"
          : "#ffffff";
      const before = look;
      setLook({ ...next, theme: { ...next.theme, text: fixed } });
      toast.show("Text colour changed so it stays readable", {
        action: { label: "Undo", onClick: () => setLook(before) },
      });
    } else setLook(next);
    bump((x) => x + 1);
  };
  const theme = (patch: Partial<Theme>) => change((l) => ({ ...l, theme: { ...l.theme, ...patch } }));
  const undo = () => {
    const p = hist.current.past.at(-1);
    if (!p) return;
    hist.current = { past: hist.current.past.slice(0, -1), future: [look, ...hist.current.future] };
    setLook(p);
    bump((x) => x + 1);
  };
  const redo = () => {
    const n = hist.current.future[0];
    if (!n) return;
    hist.current = { past: [...hist.current.past, look], future: hist.current.future.slice(1) };
    setLook(n);
    bump((x) => x + 1);
  };
  const save = () => {
    o.edit((x) => markChecklist({ ...x, manifest: { ...x.manifest, ...look } }, "design", "done"));
    toast.show("Design saved. Publish when you are ready.");
  };
  const upload = async (blob: Blob, kind: "avatar" | "wallpaper") => {
    setUploading(kind);
    try {
      const token = await o.token();
      const m = await api.put<{ hash: string; type: "image/png" | "image/jpeg" | "image/webp" }>(
        "/media",
        new Uint8Array(await blob.arrayBuffer()),
        { token },
      );
      if (kind === "avatar") change((l) => ({ ...l, avatar: m }));
      else theme({ wallpaper: { ...look.theme.wallpaper, kind: "image", image: m.hash } });
    } catch (e) {
      toast.show(failureText(e, "The image was not uploaded."), { tone: "error" });
    } finally {
      setUploading(null);
    }
  };
  const t = look.theme;

  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <header className={s.top}>
          <h1>Design</h1>
          {unsaved ? (
            <StatusChip status="wait">Unsaved changes</StatusChip>
          ) : (
            <StatusChip status="ok">Saved</StatusChip>
          )}
          <div className={s.actions}>
            <IconButton
              icon="undo"
              label="Undo"
              size="sm"
              variant="line"
              onClick={undo}
              disabled={hist.current.past.length === 0}
            />
            <IconButton
              icon="redo"
              label="Redo"
              size="sm"
              variant="line"
              onClick={redo}
              disabled={hist.current.future.length === 0}
            />
            <Button size="sm" variant="line" disabled={!unsaved} onClick={() => setLook(saved)}>
              Discard
            </Button>
            <Button size="sm" variant="cord" disabled={!unsaved} onClick={save}>
              Save
            </Button>
          </div>
        </header>

        <section className={s.sec} id="profile" aria-labelledby="h-profile">
          <Kicker>ヘッダー</Kicker>
          <h2 id="h-profile">Header</h2>
          <Segmented
            label="Header layout"
            value={t.header}
            onChange={(header) => theme({ header })}
            options={[
              { value: "classic", label: "Classic" },
              { value: "hero", label: "Hero" },
            ]}
          />
          {file ? (
            <AvatarCrop
              file={file}
              onCancel={() => setFile(null)}
              onDone={(b) => {
                setFile(null);
                void upload(b, "avatar");
              }}
            />
          ) : (
            <div className={s.avatarRow}>
              <button
                type="button"
                className={s.avatar}
                onClick={() => avatarInput.current?.click()}
                aria-label="Change profile photo"
              >
                {look.avatar ? <img src={mediaUrl(look.avatar.hash)} alt="" /> : <Icon name="image" size={28} />}
              </button>
              <div className={s.avatarText}>
                <b>Profile photo</b>
                <span>{uploading === "avatar" ? "Uploading…" : "PNG, JPEG or WebP, up to 3 MB. Public."}</span>
                <div className={s.row}>
                  <Button
                    size="sm"
                    variant="line"
                    onClick={() => avatarInput.current?.click()}
                    busy={uploading === "avatar"}
                  >
                    {look.avatar ? "Change" : "Add photo"}
                  </Button>
                  {look.avatar ? (
                    <Button size="sm" variant="ghost" onClick={() => change((l) => ({ ...l, avatar: undefined }))}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </div>
              <input
                ref={avatarInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) setFile(f);
                  e.target.value = "";
                }}
              />
            </div>
          )}
          <TextField
            label="Display name"
            value={look.displayName}
            maxLength={60}
            onChange={(e) => change((l) => ({ ...l, displayName: e.target.value }))}
            error={look.displayName.trim() ? undefined : "Add a name. It is the title of your page."}
          />
          <TextArea
            label="Bio"
            value={look.bio}
            maxLength={160}
            counter
            onChange={(e) => change((l) => ({ ...l, bio: e.target.value }))}
          />
        </section>

        <section className={s.sec} aria-labelledby="h-theme">
          <Kicker>テーマ</Kicker>
          <h2 id="h-theme">Theme</h2>
          <div className={s.themes} role="radiogroup" aria-label="Curated themes">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                type="button"
                role="radio"
                aria-checked={t.preset === tpl.id}
                className={s.theme}
                onClick={() =>
                  change((l) => ({
                    ...l,
                    theme: { ...tpl.theme, header: l.theme.header, poweredBy: l.theme.poweredBy },
                  }))
                }
              >
                <span
                  className={`${s.swatch ?? ""} seigaiha`}
                  style={{ ["--a" as string]: tpl.theme.wallpaper.a, ["--b" as string]: tpl.theme.wallpaper.b }}
                >
                  <i />
                  <i className={s.cordRow} />
                </span>
                <b>{tpl.title}</b>
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={t.preset === "custom"}
              className={s.theme}
              onClick={() => theme({ preset: "custom" })}
            >
              <span
                className={s.swatch}
                style={{ background: `linear-gradient(135deg, ${t.wallpaper.a}, ${t.wallpaper.b})` }}
              >
                <Icon name="palette" />
              </span>
              <b>Custom</b>
            </button>
          </div>
        </section>

        <section className={s.sec} aria-labelledby="h-wall">
          <Kicker>かべがみ</Kicker>
          <h2 id="h-wall">Wallpaper</h2>
          <div className={s.chips} role="radiogroup" aria-label="Wallpaper style">
            {(["fill", "gradient", "pattern", "blur", "image"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={t.wallpaper.kind === k}
                onClick={() =>
                  k === "image" && !t.wallpaper.image
                    ? wallInput.current?.click()
                    : theme({ preset: "custom", wallpaper: { ...t.wallpaper, kind: k } })
                }
              >
                {k === "fill"
                  ? "Fill"
                  : k === "gradient"
                    ? "Gradient"
                    : k === "pattern"
                      ? "Waves"
                      : k === "blur"
                        ? "Blur"
                        : "Image"}
              </button>
            ))}
          </div>
          <div className={s.colors}>
            <ColorField
              label="Colour"
              value={t.wallpaper.a}
              onChange={(a) => theme({ preset: "custom", wallpaper: { ...t.wallpaper, a } })}
            />
            <ColorField
              label="Second colour"
              value={t.wallpaper.b}
              onChange={(b) => theme({ preset: "custom", wallpaper: { ...t.wallpaper, b } })}
            />
          </div>
          {t.wallpaper.kind === "image" ? (
            <Button
              size="sm"
              variant="line"
              icon="image"
              busy={uploading === "wallpaper"}
              onClick={() => wallInput.current?.click()}
            >
              Change image
            </Button>
          ) : null}
          <input
            ref={wallInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f, "wallpaper");
              e.target.value = "";
            }}
          />
        </section>

        <section className={s.sec} aria-labelledby="h-text">
          <Kicker>もじ</Kicker>
          <h2 id="h-text">Text</h2>
          <div className={s.cards} role="radiogroup" aria-label="Font">
            {FONT_CARDS.map((f) => (
              <ChoiceCard
                key={f.id}
                selected={t.font === f.id}
                onSelect={() => theme({ font: f.id })}
                title={
                  <span
                    style={{
                      fontFamily:
                        f.id === "round"
                          ? "var(--font-round)"
                          : f.id === "sans"
                            ? "var(--font-sans)"
                            : "var(--font-jp)",
                    }}
                  >
                    {f.name} Aa
                  </span>
                }
                detail={f.line}
                tone="kinari"
              />
            ))}
          </div>
          <ColorField label="Text colour" value={t.text} onChange={(text) => theme({ text })} />
        </section>

        <section className={s.sec} aria-labelledby="h-btn">
          <Kicker>ボタン</Kicker>
          <h2 id="h-btn">Buttons</h2>
          <Segmented
            label="Button style"
            value={t.button.style}
            onChange={(style) => theme({ button: { ...t.button, style } })}
            options={[
              { value: "solid", label: "Solid" },
              { value: "glass", label: "Glass" },
              { value: "outline", label: "Outline" },
            ]}
          />
          <Segmented
            label="Corners"
            value={t.button.radius}
            onChange={(radius) => theme({ button: { ...t.button, radius } })}
            options={[
              { value: "pill", label: "Pill" },
              { value: "round", label: "Round" },
              { value: "square", label: "Square" },
            ]}
          />
          <ToggleRow
            title="Shadow"
            detail="The sticker drop under each button"
            checked={t.button.shadow}
            onChange={(shadow) => theme({ button: { ...t.button, shadow } })}
          />
          {t.button.style === "solid" ? (
            <ColorField
              label="Button colour"
              value={t.button.color}
              onChange={(color) => theme({ button: { ...t.button, color } })}
            />
          ) : null}
        </section>

        <section className={s.sec} aria-labelledby="h-foot">
          <Kicker>フッター</Kicker>
          <h2 id="h-foot">Footer</h2>
          <ToggleRow
            title="Show “Made with Mizuhiki”"
            detail="Off by default. A small credit at the bottom of your page, never an ad."
            checked={t.poweredBy}
            onChange={(poweredBy) => theme({ poweredBy })}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => change((l) => ({ ...l, theme: { ...DEFAULT_THEME, header: l.theme.header } }))}
          >
            Reset to the default look
          </Button>
        </section>
      </div>
      <aside className={s.preview} aria-label="Live preview">
        <PhoneFrame width={320}>
          <PageView manifest={{ ...d.manifest, ...look }} compact />
        </PhoneFrame>
        <span className={s.mm}>
          <Musubi face={unsaved ? "wink" : "normal"} size={96} bob />
        </span>
      </aside>
    </div>
  );
}

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className={s.color}>
      <span>{label}</span>
      <span className={s.colorBox}>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`${label} picker`} />
        <input
          value={text}
          maxLength={7}
          aria-label={`${label} hex`}
          onChange={(e) => {
            setText(e.target.value);
            if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase());
          }}
        />
      </span>
    </label>
  );
}
