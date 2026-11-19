"use client";
/**
 * One block in the editor (Linktree pattern): drag handle, round pastel icon,
 * title and subtitle edited in place, tap count, show/hide switch, and a menu.
 * The settings panel opens under the card with Settings and Layout tabs.
 * Delete offers Archive first ("keeps your insights, restore anytime").
 */
import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button, Icon, IconButton, Switch, Tabs, TextArea, TextField, ToggleRow } from "@mizuhiki/ui";
import { TOKENS, type Block } from "@mizuhiki/core";
import { BLOCK_LOOK } from "@/page/PageView";
import { blockProblem } from "./blocks";
import s from "./editor.module.css";

export interface BlockCardProps {
  block: Block;
  index: number;
  count: number;
  taps: number;
  collections: Block[];
  open: boolean;
  onOpen: (open: boolean) => void;
  onChange: (patch: Partial<Block>, coalesce?: string) => void;
  onMove: (to: number) => void;
  onArchive: () => void;
  onDelete: () => void;
  onShare: () => void;
  onDragStart: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  dragging: boolean;
}

export function BlockCard(p: BlockCardProps) {
  const { block: b } = p;
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<"settings" | "layout">("settings");
  const look = BLOCK_LOOK[b.type];
  const problem = blockProblem(b);
  return (
    <li className={[s.card, p.dragging ? s.dragging : "", b.on && !problem ? "" : s.off].join(" ")} data-block={b.id}>
      <div className={s.cardRow}>
        <button
          type="button"
          className={s.grip}
          aria-label={`Drag to reorder ${b.title}`}
          onPointerDown={p.onDragStart}
        >
          <Icon name="grip" />
        </button>
        <span className={`${s.tile ?? ""} ${s[`t_${look.tone}`] ?? ""}`} aria-hidden="true">
          <Icon name={look.icon} />
        </span>
        <div className={s.cardText}>
          <input
            className={s.inlineTitle}
            value={b.title}
            maxLength={80}
            aria-label="Title"
            placeholder="Title"
            onChange={(e) => p.onChange({ title: e.target.value }, `title:${b.id}`)}
          />
          {b.type !== "collection" ? (
            <input
              className={s.inlineSub}
              value={b.subtitle}
              maxLength={120}
              aria-label="Subtitle"
              placeholder="Add a short line (optional)"
              onChange={(e) => p.onChange({ subtitle: e.target.value }, `sub:${b.id}`)}
            />
          ) : (
            <span className={s.metaLine}>Collection heading</span>
          )}
          {problem ? (
            <button type="button" className={s.setup} onClick={() => p.onOpen(true)}>
              <Icon name="wrench" size={14} />
              Finish setup · {problem}
            </button>
          ) : (
            <span className={s.metaLine}>
              {p.taps} {p.taps === 1 ? "tap" : "taps"}
            </span>
          )}
        </div>
        <div className={s.cardActions}>
          <Switch
            size="sm"
            checked={b.on && !problem}
            disabled={!!problem}
            onChange={(on) => p.onChange({ on })}
            label={`Show ${b.title} on my page`}
          />
          <IconButton
            icon={p.open ? "x" : "pen"}
            label={p.open ? "Close settings" : `Edit ${b.title}`}
            size="sm"
            variant="line"
            className={s.editBtn}
            onClick={() => p.onOpen(!p.open)}
          />
          <div className={s.menuWrap}>
            <IconButton
              icon="more"
              label={`More for ${b.title}`}
              size="sm"
              variant="ghost"
              onClick={() => setMenu((m) => !m)}
              aria-expanded={menu}
              aria-haspopup="menu"
            />
            {menu ? (
              <div className={s.menu} role="menu" onMouseLeave={() => setMenu(false)}>
                <button type="button" role="menuitem" onClick={() => (p.onOpen(!p.open), setMenu(false))}>
                  <Icon name="pen" size={16} /> {p.open ? "Close settings" : "Edit settings"}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={p.index === 0}
                  onClick={() => (p.onMove(p.index - 1), setMenu(false))}
                >
                  <Icon name="back" size={16} style={{ transform: "rotate(90deg)" }} /> Move up
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={p.index === p.count - 1}
                  onClick={() => (p.onMove(p.index + 1), setMenu(false))}
                >
                  <Icon name="back" size={16} style={{ transform: "rotate(-90deg)" }} /> Move down
                </button>
                {b.type !== "collection" && b.type !== "text" ? (
                  <button type="button" role="menuitem" onClick={() => (p.onShare(), setMenu(false))}>
                    <Icon name="share" size={16} /> Share this block
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className={s.danger}
                  onClick={() => {
                    setConfirmDelete(true);
                    setMenu(false);
                  }}
                >
                  <Icon name="trash" size={16} /> Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {confirmDelete ? (
        <div className={s.confirm} role="group" aria-label="Delete or archive">
          <p>
            <b>Archive instead?</b> Archiving keeps your insights, and you can restore it anytime.
          </p>
          <div className={s.confirmRow}>
            <Button size="sm" variant="cord" icon="archive" onClick={() => (p.onArchive(), setConfirmDelete(false))}>
              Archive
            </Button>
            <Button size="sm" variant="danger" onClick={() => (p.onDelete(), setConfirmDelete(false))}>
              Delete forever
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {p.open ? (
        <div className={s.settings}>
          <Tabs
            label="Block settings"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "settings", label: "Settings" },
              { value: "layout", label: "Layout" },
            ]}
          />
          {tab === "settings" ? (
            <Settings b={b} onChange={p.onChange} />
          ) : (
            <Layout b={b} collections={p.collections} onChange={p.onChange} />
          )}
        </div>
      ) : null}
    </li>
  );
}

function Settings({ b, onChange }: { b: Block; onChange: (patch: Partial<Block>, coalesce?: string) => void }) {
  switch (b.type) {
    case "link":
      return (
        <TextField
          label="Link"
          value={b.url}
          onChange={(e) => onChange({ url: e.target.value }, `url:${b.id}`)}
          inputMode="url"
          error={blockProblem(b)?.includes("link") ? blockProblem(b) : undefined}
        />
      );
    case "text":
      return (
        <TextArea
          label="Text"
          value={b.body}
          maxLength={1000}
          counter
          onChange={(e) => onChange({ body: e.target.value }, `body:${b.id}`)}
        />
      );
    case "message":
      return (
        <div className={s.stack}>
          <TextArea
            label="Greeting"
            hint="Shown to visitors above the message box, like a first chat bubble."
            value={b.greeting}
            maxLength={200}
            counter
            onChange={(e) => onChange({ greeting: e.target.value }, `greet:${b.id}`)}
          />
          <ToggleRow
            title="Accept files"
            detail="Files are sealed on the sender's device in pieces"
            checked={b.allowFiles}
            onChange={(allowFiles) => onChange({ allowFiles })}
          />
          {b.allowFiles ? (
            <TextField
              label="Largest file, in MB"
              type="number"
              min={1}
              max={2048}
              value={String(b.maxFileMB)}
              onChange={(e) => {
                const n = Math.max(1, Math.min(2048, Math.round(Number(e.target.value) || 1)));
                onChange({ maxFileMB: n }, `max:${b.id}`);
              }}
              hint="Up to 2048 MB. Shown to senders before they upload."
            />
          ) : null}
        </div>
      );
    case "pay":
      return (
        <div className={s.stack}>
          <fieldset className={s.fieldset}>
            <legend>Accept</legend>
            {TOKENS.map((t) => (
              <label key={t} className={s.check}>
                <input
                  type="checkbox"
                  checked={b.tokens.includes(t)}
                  // At least one token stays accepted; the last one cannot be unticked.
                  disabled={b.tokens.length === 1 && b.tokens.includes(t)}
                  onChange={(e) =>
                    onChange({ tokens: e.target.checked ? [...b.tokens, t] : b.tokens.filter((x) => x !== t) })
                  }
                />
                {t === "fUSD" ? "Test dollars (fUSD)" : "Test QOR"}
              </label>
            ))}
          </fieldset>
          <PresetsField presets={b.presets} onCommit={(presets) => onChange({ presets }, `pre:${b.id}`)} />
          <ToggleRow
            title="Ask for a tip"
            detail="Shows tip presets on the pay card"
            checked={b.tip}
            onChange={(tip) => onChange({ tip })}
          />
          <TextArea
            label="Thank-you message"
            value={b.thanks}
            maxLength={200}
            counter
            onChange={(e) => onChange({ thanks: e.target.value }, `thx:${b.id}`)}
          />
          <RedirectField value={b.redirect ?? ""} onCommit={(redirect) => onChange({ redirect }, `red:${b.id}`)} />
        </div>
      );
    case "capsule":
      return (
        <p className={s.help}>
          Visitors can leave you a sealed note here. You choose who opens it and when in Capsules.
        </p>
      );
    case "collection":
      return (
        <p className={s.help}>
          Blocks you put in this collection appear under its heading. Choose a block's collection in its Layout tab.
        </p>
      );
    default:
      return <p className={s.help}>This block has no extra settings.</p>;
  }
}

function Layout({
  b,
  collections,
  onChange,
}: {
  b: Block;
  collections: Block[];
  onChange: (patch: Partial<Block>) => void;
}) {
  if (b.type === "collection") return <p className={s.help}>Collections cannot be nested.</p>;
  return (
    <label className={s.selectRow}>
      <span>Collection</span>
      <select value={b.collection ?? ""} onChange={(e) => onChange({ collection: e.target.value || undefined })}>
        <option value="">None</option>
        {collections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Preset amounts edited as free text and committed when valid, so "2." can be typed on the way to "2.5". */
function PresetsField({ presets, onCommit }: { presets: string[]; onCommit: (p: string[]) => void }) {
  const [text, setText] = useState(presets.join(", "));
  const parts = text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const bad = parts.filter((x) => !/^\d+(\.\d{1,6})?$/.test(x) || Number(x) <= 0);
  const error = bad.length
    ? `“${bad[0] ?? ""}” is not an amount. Use numbers like 10 or 2.5.`
    : parts.length > 4
      ? "Up to four presets."
      : undefined;
  return (
    <TextField
      label="Preset amounts"
      hint="Up to four, separated by commas. Payers can still type their own."
      value={text}
      error={error}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value);
        const next = e.target.value
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        if (next.length <= 4 && next.every((x) => /^\d+(\.\d{1,6})?$/.test(x) && Number(x) > 0)) onCommit(next);
      }}
      placeholder="10, 25, 50"
    />
  );
}

/** Optional page to send payers to after paying; only https addresses. */
function RedirectField({ value, onCommit }: { value: string; onCommit: (v: string | undefined) => void }) {
  const [text, setText] = useState(value);
  const valid = (v: string) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  };
  const error = text.trim() && !valid(text.trim()) ? "Use a full https:// address." : undefined;
  return (
    <TextField
      label="After paying, offer a link to (optional)"
      hint="Payers see a Continue button to this page next to your thank-you."
      value={text}
      error={error}
      inputMode="url"
      placeholder="https://"
      onChange={(e) => {
        setText(e.target.value);
        const v = e.target.value.trim();
        if (!v) onCommit(undefined);
        else if (valid(v)) onCommit(v);
      }}
    />
  );
}
