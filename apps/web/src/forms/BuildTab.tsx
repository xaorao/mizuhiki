"use client";
/**
 * The doc-style builder (Tally): the form reads like a page; type "/" on the
 * insert line (or press +) to add a block; blocks are edited in place; drag
 * the six dots or use the menu to move; Ctrl+D duplicates, Ctrl+H hides.
 * The welcome screen and endings (Typeform) sit above and below.
 */
import { useEffect, useState } from "react";
import { Button, Chip, Icon, IconButton, Switch, TextField } from "@mizuhiki/ui";
import { isQuestion, minutesToComplete, type Ending, type FormBlock } from "@mizuhiki/core";
import { KINDS, blankBlock, newId, type KindInfo } from "./model";
import { BlockEditor } from "./BlockEditor";
import { InsertPicker } from "./InsertPicker";
import { fromDisplay, toDisplay } from "./mentions";
import type { TabProps } from "./tabTypes";
import s from "./forms.module.css";

export function BuildTab({ def, update }: TabProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ at: number; query: string } | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const blocks = def.blocks;
  const numbers = new Map<string, number>();
  blocks.filter(isQuestion).forEach((q, i) => numbers.set(q.id, i + 1));

  const setBlocks = (next: FormBlock[], coalesce?: string) => update((d) => ({ ...d, blocks: next }), coalesce);
  const insert = (kind: KindInfo["kind"], at: number) => {
    const b = blankBlock(kind);
    setBlocks([...blocks.slice(0, at), b, ...blocks.slice(at)]);
    setSelected(b.id);
    setPicker(null);
  };
  const duplicate = (i: number) => {
    const b = blocks[i];
    if (!b) return;
    const copy = {
      ...b,
      id: `q${newId(6)}`,
      ...("choices" in b ? { choices: b.choices.map((c) => ({ ...c, id: `c${newId(5)}` })) } : {}),
    } as FormBlock;
    setBlocks([...blocks.slice(0, i + 1), copy, ...blocks.slice(i + 1)]);
    setSelected(copy.id);
  };
  const remove = (i: number) => {
    const b = blocks[i];
    if (!b) return;
    // Rules that pointed at this block go with it, so logic never points at nothing.
    update((d) => ({
      ...d,
      blocks: d.blocks.filter((x) => x.id !== b.id),
      logic: d.logic
        .filter((l) => l.after !== b.id)
        .map((l) => ({
          ...l,
          rules: l.rules.filter((r) => r.to !== b.id && r.when.every((c) => c.q !== b.id)),
          otherwise: l.otherwise === b.id ? "" : l.otherwise,
        })),
    }));
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to > blocks.length - 1 || from === to) return;
    const next = [...blocks];
    const [b] = next.splice(from, 1);
    if (!b) return;
    next.splice(to, 0, b);
    setBlocks(next);
  };

  // Ctrl+D duplicate, Ctrl+H hide the selected block (Tally's shortcuts).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!selected || !(e.metaKey || e.ctrlKey)) return;
      const i = blocks.findIndex((b) => b.id === selected);
      const b = blocks[i];
      if (!b) return;
      if (e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicate(i);
      } else if (e.key.toLowerCase() === "h" && isQuestion(b)) {
        e.preventDefault();
        setBlocks(blocks.map((x) => (x.id === b.id ? { ...b, hidden: !b.hidden } : x)));
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const setEnding = (id: string, patch: Partial<Ending>, coalesce?: string) =>
    update((d) => ({ ...d, endings: d.endings.map((e) => (e.id === id ? { ...e, ...patch } : e)) }), coalesce);

  return (
    <div className={s.build}>
      <div className={s.doc}>
        <input
          className={s.formTitle}
          value={def.title}
          placeholder="Form title"
          aria-label="Form title"
          maxLength={200}
          onChange={(e) => update((d) => ({ ...d, title: e.target.value }), "title")}
        />
        <textarea
          className={s.formDesc}
          value={def.description}
          placeholder="What is this form for? (shown on the welcome screen)"
          aria-label="Form description"
          maxLength={1000}
          rows={2}
          onChange={(e) => update((d) => ({ ...d, description: e.target.value }), "desc")}
        />
        <p className={s.docHint}>
          Type <kbd>/</kbd> to insert blocks and <kbd>@</kbd> to mention an earlier answer.
        </p>

        <section className={s.welcome} aria-label="Welcome screen">
          <div className={s.welcomeHead}>
            <b>
              <Icon name="sparkle" size={15} /> Welcome screen
            </b>
            <Switch
              checked={def.welcome.enabled}
              label="Show a welcome screen"
              size="sm"
              onChange={(v) => update((d) => ({ ...d, welcome: { ...d.welcome, enabled: v } }))}
            />
          </div>
          {def.welcome.enabled ? (
            <div className={s.welcomeBody}>
              <TextField
                label="Start button"
                value={def.welcome.button}
                maxLength={24}
                counter
                onChange={(e) => update((d) => ({ ...d, welcome: { ...d.welcome, button: e.target.value } }), "wbtn")}
              />
              <label className={s.inline}>
                <Switch
                  checked={def.welcome.showTime}
                  label="Show time to complete"
                  size="sm"
                  onChange={(v) => update((d) => ({ ...d, welcome: { ...d.welcome, showTime: v } }))}
                />
                Show “Takes {minutesToComplete(def)} min”
              </label>
            </div>
          ) : null}
        </section>

        <ol className={s.blocks} aria-label="Blocks">
          {blocks.map((b, i) => (
            <li
              key={b.id}
              className={[dropAt === i && dragFrom !== null ? s.dropBefore : ""].join(" ")}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDropAt(i);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) move(dragFrom, dragFrom < i ? i - 1 : i);
                setDragFrom(null);
                setDropAt(null);
              }}
            >
              <InsertLine onOpen={(query) => setPicker({ at: i, query })} compact />
              <BlockEditor
                block={b}
                index={i}
                number={numbers.get(b.id) ?? 0}
                blocks={blocks}
                selected={selected === b.id}
                onSelect={() => setSelected(b.id)}
                onChange={(nb, coalesce) =>
                  setBlocks(
                    blocks.map((x) => (x.id === b.id ? nb : x)),
                    coalesce,
                  )
                }
                onDuplicate={() => duplicate(i)}
                onDelete={() => remove(i)}
                onMove={(dir) => move(i, i + dir)}
                dragProps={{
                  draggable: true,
                  onDragStart: (e) => {
                    setDragFrom(i);
                    e.dataTransfer.effectAllowed = "move";
                  },
                  onDragEnd: () => {
                    setDragFrom(null);
                    setDropAt(null);
                  },
                }}
              />
            </li>
          ))}
        </ol>
        <InsertLine
          onOpen={(query) => setPicker({ at: blocks.length, query })}
          onPick={(k) => insert(k, blocks.length)}
        />
        {blocks.length === 0 ? (
          <p className={s.emptyDoc}>Press Enter on the line above, or type / to add your first question.</p>
        ) : null}

        <section className={s.endings} aria-label="Endings">
          <h2>
            Endings <Chip tone="white">{def.endings.length}</Chip>
          </h2>
          {def.endings.map((e, i) => (
            <div key={e.id} className={s.ending}>
              <div className={s.endingHead}>
                <b>Ending {i + 1}</b>
                <IconButton
                  icon="trash"
                  label={`Remove ending ${i + 1}`}
                  size="sm"
                  disabled={def.endings.length === 1}
                  onClick={() =>
                    update((d) => ({
                      ...d,
                      endings: d.endings.filter((x) => x.id !== e.id),
                      logic: d.logic.map((l) => ({
                        ...l,
                        rules: l.rules.filter((r) => r.to !== e.id),
                        otherwise: l.otherwise === e.id ? "" : l.otherwise,
                      })),
                    }))
                  }
                />
              </div>
              <TextField
                label="Title"
                value={toDisplay(e.title, blocks)}
                placeholder="Say bye! Recall information with @"
                maxLength={300}
                onChange={(ev) =>
                  setEnding(e.id, { title: fromDisplay(ev.target.value, blocks, blocks.length) }, `et:${e.id}`)
                }
              />
              <TextField
                label="Message (optional)"
                value={toDisplay(e.body, blocks)}
                maxLength={2000}
                onChange={(ev) =>
                  setEnding(e.id, { body: fromDisplay(ev.target.value, blocks, blocks.length) }, `eb:${e.id}`)
                }
              />
              <EndingLinks ending={e} onChange={(p) => setEnding(e.id, p)} />
            </div>
          ))}
          <Button
            variant="line"
            icon="plus"
            disabled={def.endings.length >= 10}
            onClick={() =>
              update((d) => ({ ...d, endings: [...d.endings, { id: `e${newId(6)}`, title: "Thanks!", body: "" }] }))
            }
          >
            Add an ending
          </Button>
        </section>
      </div>

      <InsertPicker
        open={picker !== null}
        initial={picker?.query ?? ""}
        onClose={() => setPicker(null)}
        onPick={(k) => insert(k, picker?.at ?? blocks.length)}
      />
    </div>
  );
}

/** "Type '/' to insert blocks": typing / or pressing Enter opens the picker; + does too. */
function InsertLine({
  onOpen,
  onPick,
  compact = false,
}: {
  onOpen: (query: string) => void;
  onPick?: (kind: KindInfo["kind"]) => void;
  compact?: boolean;
}) {
  const [v, setV] = useState("");
  const [at, setAt] = useState(0);
  // Typing "/" filters a list right here (Tally): no focus jump, so fast typing never loses letters.
  const slash = v.startsWith("/");
  const q = v.slice(1).trim().toLowerCase();
  const list = slash ? KINDS.filter((k) => !q || `${k.label} ${k.group}`.toLowerCase().includes(q)) : [];
  const pick = (k: KindInfo["kind"]) => {
    setV("");
    setAt(0);
    if (onPick) onPick(k);
  };
  return (
    <div className={[s.insertLine, compact ? s.insertCompact : ""].join(" ")}>
      <button type="button" aria-label="Insert a block here" onClick={() => onOpen("")}>
        <Icon name="plus" size={14} />
      </button>
      {compact ? null : (
        <div className={s.insertField}>
          <input
            value={v}
            role="combobox"
            aria-expanded={slash}
            aria-controls="insert-inline-list"
            aria-label="Type / to insert blocks"
            placeholder="Type '/' to insert blocks"
            onChange={(e) => {
              setV(e.target.value);
              setAt(0);
            }}
            onKeyDown={(e) => {
              if (slash && e.key === "ArrowDown") {
                e.preventDefault();
                setAt((i) => Math.min(list.length - 1, i + 1));
              } else if (slash && e.key === "ArrowUp") {
                e.preventDefault();
                setAt((i) => Math.max(0, i - 1));
              } else if (e.key === "Escape") {
                setV("");
              } else if (e.key === "Enter") {
                e.preventDefault();
                const k = list[Math.min(at, list.length - 1)];
                if (slash && k) pick(k.kind);
                else {
                  onOpen(slash ? q : v);
                  setV("");
                }
              }
            }}
          />
          {slash ? (
            <ul id="insert-inline-list" className={s.inlineList} role="listbox" aria-label="Blocks">
              {list.length === 0 ? (
                <li className={s.pickerNone}>Nothing called that. Try “email” or “choice”.</li>
              ) : null}
              {list.map((k, i) => (
                <li key={k.kind}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === at}
                    className={i === at ? s.pickOn : undefined}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(k.kind);
                    }}
                  >
                    <Icon name={k.icon} size={15} />
                    {k.label}
                    <small>{k.help}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

function EndingLinks({ ending, onChange }: { ending: Ending; onChange: (p: Partial<Ending>) => void }) {
  const [label, setLabel] = useState(ending.button?.label ?? "");
  const [url, setUrl] = useState(ending.button?.url ?? "");
  const [redirect, setRedirect] = useState(ending.redirect ?? "");
  const ok = (u: string) => {
    try {
      return new URL(u).protocol === "https:";
    } catch {
      return false;
    }
  };
  return (
    <div className={s.endingLinks}>
      <TextField
        label="Button label (optional)"
        value={label}
        maxLength={40}
        onChange={(e) => {
          setLabel(e.target.value);
          if (e.target.value && ok(url)) onChange({ button: { label: e.target.value, url } });
          if (!e.target.value) onChange({ button: undefined });
        }}
      />
      <TextField
        label="Button link"
        value={url}
        placeholder="https://"
        inputMode="url"
        error={url && !ok(url) ? "Use a full https:// address." : undefined}
        onChange={(e) => {
          setUrl(e.target.value);
          if (label && ok(e.target.value)) onChange({ button: { label, url: e.target.value } });
        }}
      />
      <TextField
        label="Or send people straight to (optional)"
        value={redirect}
        placeholder="https://"
        inputMode="url"
        error={redirect && !ok(redirect) ? "Use a full https:// address." : undefined}
        hint="Redirect to URL: the ending shows for a moment, then the page opens."
        onChange={(e) => {
          setRedirect(e.target.value);
          if (!e.target.value) onChange({ redirect: undefined });
          else if (ok(e.target.value)) onChange({ redirect: e.target.value });
        }}
      />
    </div>
  );
}
