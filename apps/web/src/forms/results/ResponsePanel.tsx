"use client";
/**
 * One response, opened on this device: every question and answer rendered by
 * kind (choice labels, "Other" text, stars, scales, links, files that unseal
 * here with preview and save, the drawn signature), the ending reached, hidden
 * fields, and the owner's sealed tags.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Button, Chip, Icon, IconButton } from "@mizuhiki/ui";
import { decryptFile, isAnswered, type FileFacts, type FormDef, type Question } from "@mizuhiki/core";
import { api } from "@/lib/api";
import { fmtBytes } from "@/public/MessageSheet";
import {
  NONE,
  NONE_LABEL,
  OTHER,
  REMOVED_CHOICE,
  clock,
  localStamp,
  pickedKeys,
  rawText,
  type OpenedResponse,
} from "./aggregate";
import { MAX_TAG, tidyTag } from "./tags";
import s from "../results.module.css";

type Unseal = { s: "idle" } | { s: "busy"; p: number } | { s: "ready"; url: string } | { s: "failed"; why: string };

function useUnseal(f: FileFacts) {
  const [state, setState] = useState<Unseal>({ s: "idle" });
  useEffect(
    () => () => {
      if (state.s === "ready") URL.revokeObjectURL(state.url);
    },
    [state],
  );
  const unseal = async (): Promise<string | null> => {
    if (state.s === "ready") return state.url;
    setState({ s: "busy", p: 0 });
    try {
      const parts = await decryptFile({
        facts: f,
        fetchChunk: (h) => api.bytes(`/blobs/${h}`),
        onProgress: (d, t) => setState({ s: "busy", p: d / Math.max(1, t) }),
      });
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: f.type || "application/octet-stream" }));
      setState({ s: "ready", url });
      return url;
    } catch {
      setState({ s: "failed", why: "This file could not be unsealed. It may have expired, or a piece was changed." });
      return null;
    }
  };
  return { state, unseal };
}

function FileRow({ f }: { f: FileFacts }) {
  const { state, unseal } = useUnseal(f);
  const isImage = f.type.startsWith("image/") && !f.type.includes("svg");
  const save = async () => {
    const url = await unseal();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.click();
  };
  return (
    <li className={s.file}>
      <span className={s.fileIcon}>
        <Icon name={isImage ? "image" : "file"} size={20} />
      </span>
      <span className={s.fileText}>
        <b>{f.name}</b>
        <small>
          {fmtBytes(f.size)} ·{" "}
          {state.s === "busy"
            ? `Unsealing ${Math.round(state.p * 100)}%`
            : state.s === "ready"
              ? "Unsealed on this device"
              : "Sealed"}
        </small>
      </span>
      <span className={s.fileActions}>
        {isImage && state.s !== "ready" ? (
          <Button variant="line" size="sm" icon="eye" onClick={() => void unseal()} disabled={state.s === "busy"}>
            Preview
          </Button>
        ) : null}
        <Button variant="line" size="sm" icon="download" onClick={() => void save()} disabled={state.s === "busy"}>
          Save
        </Button>
      </span>
      {state.s === "ready" && isImage ? (
        <img className={s.preview} src={state.url} alt={`Preview of ${f.name}`} />
      ) : null}
      {state.s === "failed" ? <p className={s.fileErr}>{state.why}</p> : null}
    </li>
  );
}

/** A drawn signature unseals by itself: it is small and it is the answer. */
function Signature({ f }: { f: FileFacts }) {
  const { state, unseal } = useUnseal(f);
  useEffect(() => {
    if (state.s === "idle") void unseal();
  }, [state.s, unseal]);
  if (state.s === "ready")
    return <img className={s.signature} src={state.url} alt="The respondent's drawn signature" />;
  if (state.s === "failed") return <p className={s.fileErr}>{state.why}</p>;
  return <p className={s.quiet}>Unsealing the signature…</p>;
}

const safeHref = (raw: string): string | null => {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

function Answer({ q, r }: { q: Question; r: OpenedResponse }) {
  const p = r.payload;
  if (q.kind === "file" || q.kind === "signature") {
    const files = (p.files[q.id] ?? []) as FileFacts[];
    if (!files.length) return <p className={s.quiet}>No answer</p>;
    if (q.kind === "signature")
      return (
        <>
          {files.map((f) => (
            <Signature key={f.fileId} f={f} />
          ))}
        </>
      );
    return (
      <ul className={s.files}>
        {files.map((f) => (
          <FileRow key={f.fileId} f={f} />
        ))}
      </ul>
    );
  }
  const v = p.answers[q.id];
  if (!isAnswered(v) || v === undefined || v === null) return <p className={s.quiet}>No answer</p>;
  switch (q.kind) {
    case "choice":
    case "dropdown":
    case "checkboxes": {
      const other = p.answers[`${q.id}:${OTHER}`];
      return (
        <div className={s.chips}>
          {pickedKeys(q, p).map((k) => (
            <Chip key={k} tone={k === OTHER ? "butter" : "sakura"}>
              {k === OTHER
                ? `Other${typeof other === "string" && other ? `: ${other}` : ""}`
                : k === NONE && q.kind === "checkboxes"
                  ? NONE_LABEL
                  : "choices" in q
                    ? (q.choices.find((c) => c.id === k)?.label ?? REMOVED_CHOICE)
                    : k}
            </Chip>
          ))}
        </div>
      );
    }
    case "yesno":
      return (
        <Chip tone={v === true ? "matcha" : "sakura"} icon={v === true ? "check" : "x"}>
          {v === true ? "Yes" : "No"}
        </Chip>
      );
    case "rating": {
      const n = Number(v);
      return (
        <p className={s.rating} aria-label={`${n} of ${q.max}`}>
          {Array.from({ length: q.max }, (_, i) => (
            <Icon key={i} name={q.icon} size={18} className={i < n ? s.ratingOn : s.ratingOff} />
          ))}
          <b>
            {n} of {q.max}
          </b>
        </p>
      );
    }
    case "scale":
      return (
        <p className={s.answerText}>
          <b className={s.big}>{String(v)}</b> on a scale of {q.from} to {q.to}
        </p>
      );
    case "email":
      return (
        <a className={s.answerLink} href={`mailto:${String(v)}`}>
          {String(v)}
        </a>
      );
    case "phone":
      return (
        <a className={s.answerLink} href={`tel:${String(v).replace(/[^\d+]/g, "")}`}>
          {String(v)}
        </a>
      );
    case "link": {
      const href = safeHref(String(v));
      return href ? (
        <a className={s.answerLink} href={href} target="_blank" rel="noreferrer noopener">
          {String(v)} <Icon name="link" size={13} />
        </a>
      ) : (
        <p className={s.answerText}>{String(v)}</p>
      );
    }
    case "wallet":
      return <code className={s.mono}>{String(v)}</code>;
    case "date": {
      const d = new Date(`${String(v)}T00:00:00`);
      return (
        <p className={s.answerText}>
          {Number.isNaN(d.getTime())
            ? String(v)
            : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" })}
        </p>
      );
    }
    default:
      return <p className={[s.answerText, s.pre].join(" ")}>{Array.isArray(v) ? v.join(", ") : String(v)}</p>;
  }
}

function Tags({
  tags,
  onChange,
  saving,
  disabled,
}: {
  tags: string[];
  onChange: (t: string[]) => void;
  saving: string;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const add = () => {
    const t = tidyTag(draft);
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft("");
    setAdding(false);
  };
  return (
    <section className={s.tags} aria-label="Tags">
      <div className={s.tagsHead}>
        <b>Tags</b>
        <small>{saving}</small>
      </div>
      <div className={s.chips}>
        {tags.map((t) => (
          <span key={t} className={s.tag}>
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              disabled={disabled}
              onClick={() => onChange(tags.filter((x) => x !== t))}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        {adding ? (
          <form
            className={s.tagForm}
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <input
              autoFocus
              aria-label="New tag"
              placeholder="e.g. follow up"
              maxLength={MAX_TAG}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
            />
          </form>
        ) : (
          <button type="button" className={s.addTag} disabled={disabled} onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} /> Add tag
          </button>
        )}
      </div>
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function ResponseDetail({
  r,
  index,
  questions,
  earlier,
  def,
  tags,
  onTags,
  tagsDisabled,
  saving,
  onPrev,
  onNext,
}: {
  r: OpenedResponse;
  index: number;
  questions: Question[];
  earlier: string[];
  def: FormDef;
  tags: string[];
  onTags: (t: string[]) => void;
  saving: string;
  tagsDisabled: boolean;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const p = r.payload;
  const ending = def.endings.find((e) => e.id === p.ending);
  const took = Date.parse(p.submittedAt) - Date.parse(p.startedAt);
  const hidden = Object.entries(p.hidden);
  const old = earlier.filter((k) => rawText(p, k));
  return (
    <div className={s.detail}>
      <div className={s.detailNav}>
        <span className={s.kicker}>Response {index}</span>
        <span className={s.navBtns}>
          <IconButton icon="back" label="Newer response" size="sm" onClick={() => onPrev?.()} disabled={!onPrev} />
          <IconButton icon="arrow" label="Older response" size="sm" onClick={() => onNext?.()} disabled={!onNext} />
        </span>
      </div>
      <dl className={s.facts}>
        <Fact label="Submitted">{localStamp(r.at)}</Fact>
        {Number.isFinite(took) && took > 0 ? <Fact label="Time taken">{clock(took / 1000)}</Fact> : null}
        <Fact label="Ending reached">
          {ending ? ending.title || "Untitled ending" : p.ending ? "An ending no longer in the form" : "Not recorded"}
        </Fact>
        {p.formVersion !== def.version ? <Fact label="Form version">Answered version {p.formVersion}</Fact> : null}
        <Fact label="Readers">
          Sealed to {r.readers} reader{r.readers === 1 ? "" : "s"}
        </Fact>
      </dl>
      <Tags tags={tags} onChange={onTags} saving={saving} disabled={tagsDisabled} />
      <ol className={s.qa}>
        {questions.map((q, i) => (
          <li key={q.id}>
            <p className={s.qaQ}>
              <span>{i + 1}</span>
              {q.title || "Untitled question"}
            </p>
            <Answer q={q} r={r} />
          </li>
        ))}
        {old.map((k) => (
          <li key={k}>
            <p className={s.qaQ}>
              <span>·</span>A question no longer in the form ({k})
            </p>
            <p className={[s.answerText, s.pre].join(" ")}>{rawText(p, k)}</p>
          </li>
        ))}
      </ol>
      {hidden.length ? (
        <section className={s.hiddenBox}>
          <b>Hidden fields</b>
          <dl className={s.facts}>
            {hidden.map(([k, v]) => (
              <Fact key={k} label={k}>
                {v}
              </Fact>
            ))}
          </dl>
        </section>
      ) : null}
      <p className={s.lockNote}>
        <Icon name="lock" size={13} /> Opened on this device with your key. It stays in this tab only.
      </p>
    </div>
  );
}
