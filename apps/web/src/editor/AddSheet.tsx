"use client";
/**
 * The Add sheet (Linktree's today): one search-or-paste field, big tiles for
 * the most used blocks, a categories rail and the list. Pasting a link turns
 * it straight into a Link block.
 */
import { useMemo, useState } from "react";
import { Icon, Sheet } from "@mizuhiki/ui";
import { newId, type Block } from "@mizuhiki/core";
import { CATALOG, CATEGORIES, linkFromPaste, titleFromUrl, type Category } from "./blocks";
import s from "./editor.module.css";

const TILES = ["message", "pay", "link", "text"] as const;

export function AddSheet({
  open,
  onClose,
  onAdd,
  firstName,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (b: Block) => void;
  firstName: string;
}) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<Category>("suggested");
  const pasted = linkFromPaste(q);
  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (term && !pasted) return CATALOG.filter((c) => `${c.title} ${c.detail}`.toLowerCase().includes(term));
    return CATALOG.filter((c) => c.categories.includes(cat));
  }, [q, cat, pasted]);
  const add = (b: Block) => {
    onAdd(b);
    setQ("");
    onClose();
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add" wide>
      <form
        className={s.addSearch}
        onSubmit={(e) => {
          e.preventDefault();
          if (pasted)
            add({
              id: newId(),
              type: "link",
              on: true,
              archived: false,
              title: titleFromUrl(pasted),
              subtitle: "",
              url: pasted.toString(),
            });
          else if (list[0]) add(list[0].make({ firstName }));
        }}
      >
        <Icon name="search" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Paste a link or search"
          aria-label="Paste a link or search"
          autoFocus
        />
      </form>
      {pasted ? (
        <button
          type="button"
          className={s.pasteHit}
          onClick={() =>
            add({
              id: newId(),
              type: "link",
              on: true,
              archived: false,
              title: titleFromUrl(pasted),
              subtitle: "",
              url: pasted.toString(),
            })
          }
        >
          <Icon name="link" />
          <span>
            <b>Add a link to {pasted.hostname.replace(/^www\./, "")}</b>
            <small>{pasted.toString()}</small>
          </span>
          <Icon name="plus" />
        </button>
      ) : null}
      {!q ? (
        <div className={s.tiles}>
          {TILES.map((t) => {
            const c = CATALOG.find((x) => x.type === t);
            if (!c) return null;
            return (
              <button key={t} type="button" className={s.addTile} onClick={() => add(c.make({ firstName }))}>
                <span className={s.addTileIcon}>
                  <Icon name={c.icon} size={22} />
                </span>
                <b>{c.title}</b>
              </button>
            );
          })}
        </div>
      ) : null}
      <div className={s.addBody}>
        {!q ? (
          <nav className={s.cats} aria-label="Categories">
            {CATEGORIES.map((c) => (
              <button key={c.id} type="button" aria-pressed={cat === c.id} onClick={() => setCat(c.id)}>
                <Icon name={c.icon} size={18} />
                {c.label}
              </button>
            ))}
          </nav>
        ) : null}
        <ul className={s.catalog}>
          {list.map((c) => (
            <li key={c.type}>
              <button type="button" onClick={() => add(c.make({ firstName }))}>
                <span className={s.addTileIcon}>
                  <Icon name={c.icon} size={20} />
                </span>
                <span>
                  <b>{c.title}</b>
                  <small>{c.detail}</small>
                </span>
                <Icon name="chev" />
              </button>
            </li>
          ))}
          {list.length === 0 && !pasted ? (
            <li className={s.noHit}>Nothing matches “{q}”. Try another word, or paste a link.</li>
          ) : null}
        </ul>
      </div>
    </Sheet>
  );
}
