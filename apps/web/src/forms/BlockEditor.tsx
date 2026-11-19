"use client";
/**
 * One block, edited in place (Tally): title with @ mentions, description,
 * choices, and the six-dot menu (Required, Min/Max, Duplicate, Hide, Half
 * width, Turn into, Move, Delete). Kind-specific settings open below it.
 */
import { useRef, useState } from "react";
import { Icon, IconButton, Switch } from "@mizuhiki/ui";
import { QUESTION_KINDS, isQuestion, type FormBlock, type Question, type QuestionKind } from "@mizuhiki/core";
import { KINDS, newId, turnInto } from "./model";
import { fromDisplay, mentionable, toDisplay } from "./mentions";
import s from "./forms.module.css";

const kindInfo = (k: string) => KINDS.find((x) => x.kind === k);

export function BlockEditor({
  block,
  index,
  number,
  blocks,
  selected,
  onSelect,
  onChange,
  onDuplicate,
  onDelete,
  onMove,
  dragProps,
}: {
  block: FormBlock;
  index: number;
  number: number;
  blocks: FormBlock[];
  selected: boolean;
  onSelect: () => void;
  onChange: (b: FormBlock, coalesce?: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  dragProps: React.HTMLAttributes<HTMLButtonElement> & { draggable: boolean };
}) {
  const [menu, setMenu] = useState(false);
  const [mention, setMention] = useState(false);
  const title = useRef<HTMLInputElement>(null);
  const info = kindInfo(block.kind);
  const q = isQuestion(block) ? block : null;
  const setQ = (patch: Partial<Question>, coalesce?: string) => q && onChange({ ...q, ...patch } as Question, coalesce);
  const mentions = mentionable(blocks, index);

  if (block.kind === "page")
    return (
      <div className={s.pageBreak} onClick={onSelect}>
        <span>New section</span>
        <IconButton icon="trash" label="Remove this section break" size="sm" onClick={onDelete} />
      </div>
    );

  const typeTitle = (v: string) => {
    const stored = fromDisplay(v, blocks, index);
    if ("title" in block) onChange({ ...block, title: stored }, `title:${block.id}`);
    setMention(v.endsWith("@") && mentions.length > 0);
  };

  return (
    <div
      className={[s.block, selected ? s.blockOn : "", q?.hidden ? s.blockHidden : "", q?.half ? s.blockHalf : ""].join(
        " ",
      )}
      onClick={onSelect}
    >
      <div className={s.gutter}>
        <button type="button" className={s.handle} aria-label={`Drag to move block ${index + 1}`} {...dragProps}>
          <Icon name="grip" size={16} />
        </button>
        <IconButton icon="more" label={`Menu for block ${index + 1}`} size="sm" onClick={() => setMenu((m) => !m)} />
      </div>
      <div className={s.blockMain}>
        <div className={s.blockHead}>
          {info ? (
            <span className={s.kindTag}>
              <Icon name={info.icon} size={13} /> {number ? `Q${number} · ` : ""}
              {info.label}
            </span>
          ) : null}
          {q?.required ? <span className={s.reqTag}>Required</span> : null}
          {q?.hidden ? <span className={s.hiddenTag}>Hidden</span> : null}
          {q?.half ? <span className={s.hiddenTag}>Half width</span> : null}
        </div>
        {"title" in block ? (
          <div className={s.titleWrap}>
            <input
              ref={title}
              className={block.kind === "heading" ? s.headingInput : s.titleInput}
              value={toDisplay(block.title, blocks)}
              placeholder={
                block.kind === "heading"
                  ? "Section title"
                  : block.kind === "statement"
                    ? "Say something between questions"
                    : "Your question here. Recall information with @"
              }
              aria-label={block.kind === "heading" ? "Heading" : `Question ${number || index + 1} title`}
              maxLength={500}
              onChange={(e) => typeTitle(e.target.value)}
              onBlur={() => setTimeout(() => setMention(false), 150)}
            />
            {mention ? (
              <ul className={s.mentionMenu} role="listbox" aria-label="Recall information from">
                <li className={s.mentionHead}>Recall information from…</li>
                {mentions.map((m) => (
                  <li key={m.tag}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const shown = toDisplay("title" in block ? block.title : "", blocks).replace(/@$/, "");
                        typeTitle(`${shown}${m.tag} `);
                        setMention(false);
                        title.current?.focus();
                      }}
                    >
                      <b>{m.tag}</b> {m.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {q || block.kind === "statement" ? (
          <input
            className={s.descInput}
            value={toDisplay("description" in block ? block.description : "", blocks)}
            placeholder="Description (optional)"
            aria-label="Description"
            maxLength={block.kind === "statement" ? 2000 : 1000}
            onChange={(e) =>
              "description" in block &&
              onChange({ ...block, description: fromDisplay(e.target.value, blocks, index) }, `desc:${block.id}`)
            }
          />
        ) : null}

        {q && "choices" in q ? (
          <ol className={s.choices}>
            {q.choices.map((c, i) => (
              <li key={c.id}>
                <span className={s.choiceKey}>{String.fromCharCode(65 + i)}</span>
                <input
                  value={c.label}
                  aria-label={`Choice ${i + 1}`}
                  maxLength={200}
                  onChange={(e) =>
                    setQ(
                      {
                        choices: q.choices.map((x) => (x.id === c.id ? { ...x, label: e.target.value } : x)),
                      },
                      `choice:${c.id}`,
                    )
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      setQ({
                        choices: [
                          ...q.choices.slice(0, i + 1),
                          { id: `c${newId(5)}`, label: "" },
                          ...q.choices.slice(i + 1),
                        ],
                      });
                    }
                  }}
                />
                <IconButton
                  icon="x"
                  label={`Remove choice ${i + 1}`}
                  size="sm"
                  disabled={q.choices.length <= 1}
                  onClick={() => setQ({ choices: q.choices.filter((x) => x.id !== c.id) })}
                />
              </li>
            ))}
            <li>
              <button
                type="button"
                className={s.addChoice}
                onClick={() =>
                  setQ({
                    choices: [...q.choices, { id: `c${newId(5)}`, label: `Choice ${q.choices.length + 1}` }],
                  })
                }
              >
                <Icon name="plus" size={14} /> Add choice
              </button>
            </li>
          </ol>
        ) : null}

        {selected && q ? <KindSettings q={q} setQ={setQ} /> : null}
      </div>

      {menu ? (
        <div
          className={s.blockMenu}
          role="menu"
          aria-label={`Block ${index + 1} options`}
          onClick={(e) => e.stopPropagation()}
        >
          {q ? (
            <>
              <label className={s.menuRow}>
                <span>Required</span>
                <Switch checked={q.required} label="Required" size="sm" onChange={(v) => setQ({ required: v })} />
              </label>
              <label className={s.menuRow}>
                <span>Hide (skip for now)</span>
                <Switch checked={q.hidden} label="Hide" size="sm" onChange={(v) => setQ({ hidden: v })} />
              </label>
              <label className={s.menuRow}>
                <span>Half width (two columns)</span>
                <Switch checked={q.half} label="Half width" size="sm" onChange={(v) => setQ({ half: v })} />
              </label>
              <label className={s.menuRow}>
                <span>Turn into</span>
                <select
                  value={q.kind}
                  aria-label="Turn into"
                  onChange={(e) => onChange(turnInto(q, e.target.value as QuestionKind))}
                >
                  {QUESTION_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {kindInfo(k)?.label ?? k}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onDuplicate();
              setMenu(false);
            }}
          >
            <Icon name="copy" size={14} /> Duplicate <kbd>Ctrl D</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMove(-1);
              setMenu(false);
            }}
          >
            <Icon name="arrow" size={14} className={s.rotUp} /> Move up
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMove(1);
              setMenu(false);
            }}
          >
            <Icon name="arrow" size={14} className={s.rotDown} /> Move down
          </button>
          <button type="button" role="menuitem" className={s.danger} onClick={onDelete}>
            <Icon name="trash" size={14} /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

const num = (v: string): number | undefined =>
  v.trim() === "" || Number.isNaN(Number(v)) ? undefined : Math.round(Number(v));

function KindSettings({ q, setQ }: { q: Question; setQ: (p: Partial<Question>, c?: string) => void }) {
  const field = (
    label: string,
    value: number | undefined,
    on: (v: number | undefined) => void,
    min = 0,
    max = 100000,
  ) => (
    <label className={s.setting}>
      <span>{label}</span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(e) => on(num(e.target.value))}
      />
    </label>
  );
  return (
    <div className={s.kindSettings} onClick={(e) => e.stopPropagation()}>
      {q.kind === "short" || q.kind === "long" ? (
        <>
          <label className={s.setting}>
            <span>Placeholder</span>
            <input
              value={q.placeholder}
              maxLength={120}
              onChange={(e) => setQ({ placeholder: e.target.value }, `ph:${q.id}`)}
            />
          </label>
          {field("Min characters", q.minChars, (v) => setQ({ minChars: v }))}
          {field("Max characters", q.maxChars, (v) => setQ({ maxChars: v }), 1)}
        </>
      ) : null}
      {q.kind === "checkboxes" ? (
        <>
          {field("Least choices", q.minPick, (v) => setQ({ minPick: v }), 0, 50)}
          {field("Most choices", q.maxPick, (v) => setQ({ maxPick: v }), 1, 50)}
        </>
      ) : null}
      {q.kind === "choice" || q.kind === "checkboxes" ? (
        <>
          <label className={s.setting}>
            <span>“Other” option</span>
            <Switch checked={q.other} label="Other option" size="sm" onChange={(v) => setQ({ other: v })} />
          </label>
          {q.kind === "checkboxes" ? (
            <label className={s.setting}>
              <span>“None of the above”</span>
              <Switch checked={q.none} label="None option" size="sm" onChange={(v) => setQ({ none: v })} />
            </label>
          ) : null}
          <label className={s.setting}>
            <span>Shuffle choices</span>
            <Switch checked={q.randomize} label="Shuffle" size="sm" onChange={(v) => setQ({ randomize: v })} />
          </label>
        </>
      ) : null}
      {q.kind === "rating" ? (
        <>
          {field("Out of", q.max, (v) => setQ({ max: Math.min(10, Math.max(3, v ?? 5)) }), 3, 10)}
          <label className={s.setting}>
            <span>Shape</span>
            <select value={q.icon} onChange={(e) => setQ({ icon: e.target.value as "star" | "heart" })}>
              <option value="star">Stars</option>
              <option value="heart">Hearts</option>
            </select>
          </label>
        </>
      ) : null}
      {q.kind === "scale" ? (
        <>
          <label className={s.setting}>
            <span>From</span>
            <select value={q.from} onChange={(e) => setQ({ from: Number(e.target.value) })}>
              <option value={0}>0</option>
              <option value={1}>1</option>
            </select>
          </label>
          {field("To", q.to, (v) => setQ({ to: Math.min(10, Math.max(2, v ?? 5)) }), 2, 10)}
          {(["left", "center", "right"] as const).map((k) => (
            <label key={k} className={s.setting}>
              <span>{k === "left" ? "Left label" : k === "center" ? "Middle label" : "Right label"}</span>
              <input value={q[k]} maxLength={40} onChange={(e) => setQ({ [k]: e.target.value }, `${k}:${q.id}`)} />
            </label>
          ))}
        </>
      ) : null}
      {q.kind === "number" ? (
        <>
          {field("Lowest", q.min, (v) => setQ({ min: v }), -1e9, 1e9)}
          {field("Highest", q.max, (v) => setQ({ max: v }), -1e9, 1e9)}
        </>
      ) : null}
      {q.kind === "file" ? (
        <>
          {field("Files allowed", q.maxFiles, (v) => setQ({ maxFiles: Math.min(10, Math.max(1, v ?? 1)) }), 1, 10)}
          {field("Largest file (MB)", q.maxMB, (v) => setQ({ maxMB: Math.min(500, Math.max(1, v ?? 25)) }), 1, 500)}
          <p className={s.settingNote}>
            <Icon name="lock" size={12} /> Files are encrypted on the respondent&apos;s device before they upload.
          </p>
        </>
      ) : null}
    </div>
  );
}
