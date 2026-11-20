"use client";
/**
 * The respondent's form (spec 5.9), Typeform's flow: welcome with "Takes X
 * min", one question per screen (two half-width fields share a screen on wide
 * displays), lettered choices, Enter to continue, Shift+Enter for a new line,
 * the error staying on the question, progress, recall of earlier answers,
 * logic jumps and several endings. Answers are kept only in this browser until
 * Submit, then sealed here ("Encrypting… Sent"). In preview nothing is sent.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Button, Icon, Musubi, Oops, SealMoment, type SealStep } from "@mizuhiki/ui";
import {
  answerProblem,
  isQuestion,
  minutesToComplete,
  nextAfter,
  pickHint,
  recall,
  type AnswerValue,
  type FormBlock,
  type FormDef,
  type Question,
  type RecipientCard,
} from "@mizuhiki/core";
import { mediaUrl } from "@/lib/api";
import { qorex } from "@/lib/pay";
import { NETWORK } from "@mizuhiki/chain";
import { SUBMIT_LABEL, SubmitFailure, formEvent, submitAnswers, type SubmitStep } from "./submit";
import { SignaturePad } from "./SignaturePad";
import s from "./runner.module.css";
import { useSearch } from "@/lib/useClient";

interface Step {
  ids: string[];
  heading: string;
}

/** Screens in order: hidden questions skipped, consecutive half-width questions share one. */
export function buildSteps(def: Pick<FormDef, "blocks">): Step[] {
  const out: Step[] = [];
  let heading = "";
  for (const b of def.blocks) {
    if (b.kind === "page") {
      heading = "";
      continue;
    }
    if (b.kind === "heading") {
      heading = b.title;
      continue;
    }
    if (isQuestion(b) && b.hidden) continue;
    const prev = out[out.length - 1];
    const prevBlock = prev ? def.blocks.find((x) => x.id === prev.ids[prev.ids.length - 1]) : undefined;
    if (isQuestion(b) && b.half && prev && prevBlock && isQuestion(prevBlock) && prevBlock.half && prev.ids.length < 2)
      prev.ids.push(b.id);
    else out.push({ ids: [b.id], heading });
  }
  return out;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const without = (o: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
const draftKey = (def: FormDef) => `mzk:form-draft:${def.id}:${def.version}`;

export function FormRunner({
  def,
  ownerCard,
  ownerName,
  pageStyle,
  closedReason,
  preview = false,
}: {
  def: FormDef;
  ownerCard: RecipientCard | null;
  ownerName: string;
  pageStyle?: CSSProperties | undefined;
  closedReason?: string | null | undefined;
  preview?: boolean;
}) {
  const steps = useMemo(() => buildSteps(def), [def]);
  const blockById = useMemo(() => new Map(def.blocks.map((b) => [b.id, b])), [def.blocks]);
  const [at, setAt] = useState<number>(def.welcome.enabled ? -1 : 0);
  const [history, setHistory] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [files, setFiles] = useState<Record<string, File[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<"form" | "sending" | "done" | "failed">("form");
  const [sendSteps, setSendSteps] = useState<SealStep[]>([]);
  const [progress, setProgress] = useState(0);
  const [ending, setEnding] = useState<string>(def.endings[0]?.id ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const started = useRef<{ at: number; sent: boolean }>({ at: 0, sent: false });
  // Read through useClient so the server's HTML and the first browser render agree (no hydration mismatch).
  const search = useSearch();
  const hidden = useMemo(() => {
    const p = new URLSearchParams(search);
    const h: Record<string, string> = {};
    p.forEach((v, k) => {
      if (k !== "embed" && Object.keys(h).length < 10) h[k.slice(0, 40)] = v.slice(0, 200);
    });
    return h;
  }, [search]);
  // Inside another site's page (embed.js adds ?embed=1): fit the frame, no outer page chrome.
  const embedded = useMemo(() => new URLSearchParams(search).get("embed") === "1", [search]);
  const readerNames = [`@${ownerName}`, ...def.readers.map((r) => `@${r.name}`)];

  // Restore a partial answer kept in this browser (never uploaded).
  useEffect(() => {
    if (preview) return;
    try {
      const raw = localStorage.getItem(draftKey(def));
      if (raw) {
        const d = JSON.parse(raw) as { answers: Record<string, AnswerValue>; at: number };
        setAnswers(d.answers);
      }
    } catch {
      // storage blocked: start fresh
    }
    // One view per tab session, like page views.
    try {
      const k = `mzk:form-viewed:${def.id}`;
      if (sessionStorage.getItem(k)) return;
      sessionStorage.setItem(k, "1");
    } catch {
      // storage blocked: count this load once
    }
    formEvent(def.id, { kind: "view" });
  }, [def, preview]);
  useEffect(() => {
    if (preview || phase !== "form") return;
    try {
      localStorage.setItem(draftKey(def), JSON.stringify({ answers, at: Date.now() }));
    } catch {
      // storage blocked: answers stay in memory only
    }
  }, [answers, def, phase, preview]);

  const step = at >= 0 ? steps[at] : undefined;
  useEffect(() => {
    if (preview || !step) return;
    for (const id of step.ids)
      if (isQuestion(blockById.get(id) as FormBlock)) formEvent(def.id, { kind: "reach", q: id });
  }, [step, blockById, def.id, preview]);

  const setAnswer = (id: string, v: AnswerValue) => {
    if (!started.current.sent && !preview) {
      started.current = { at: Date.now(), sent: true };
      formEvent(def.id, { kind: "start" });
    } else if (!started.current.at) started.current.at = Date.now();
    setAnswers((a) => ({ ...a, [id]: v }));
    setErrors((e) => without(e, id));
  };

  /** Where Continue goes from the current step: another step, an ending, or the end. */
  const target = useCallback((): { step: number } | { ending: string } => {
    if (!step) return { step: 0 };
    for (const id of step.ids) {
      const t = nextAfter(def, id, answers);
      if (t) {
        if (def.endings.some((e) => e.id === t)) return { ending: t };
        const idx = steps.findIndex((x) => x.ids.includes(t));
        if (idx >= 0) return { step: idx };
      }
    }
    return at + 1 < steps.length ? { step: at + 1 } : { ending: def.endings[0]?.id ?? "" };
  }, [answers, at, def, step, steps]);

  const validate = (): boolean => {
    if (!step) return true;
    const errs: Record<string, string> = {};
    for (const id of step.ids) {
      const b = blockById.get(id);
      if (!b || !isQuestion(b)) continue;
      const p = answerProblem(b, answers[id], files[id]?.length ?? 0);
      if (p) errs[id] = p;
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async (endingId: string) => {
    setEnding(endingId);
    if (preview) {
      setPhase("done");
      return;
    }
    const order: SubmitStep[] = [
      "keys",
      ...(Object.values(files).some((f) => f.length) ? (["files"] as const) : []),
      "seal",
      "stamp",
      "send",
    ];
    setSendSteps(order.map((k) => ({ label: SUBMIT_LABEL[k], state: "waiting" })));
    setPhase("sending");
    try {
      const submittedAt = new Date();
      // Respondents may type into "Other": keep that text with the choice.
      const merged: Record<string, AnswerValue> = { ...answers };
      for (const [qid, t] of Object.entries(other)) if (t.trim()) merged[`${qid}:other`] = t.trim();
      await submitAnswers({
        def,
        ownerCard,
        files,
        payload: {
          v: 1,
          formId: def.id,
          formVersion: def.version,
          answers: merged,
          hidden,
          ending: endingId,
          startedAt: new Date(started.current.at || Date.now()).toISOString(),
          submittedAt: submittedAt.toISOString(),
        },
        onStep: (k, p) => {
          const i = order.indexOf(k);
          setSendSteps(
            order.map((x, j) => ({ label: SUBMIT_LABEL[x], state: j < i ? "done" : j === i ? "running" : "waiting" })),
          );
          setProgress(p);
        },
      });
      formEvent(def.id, {
        kind: "submit",
        seconds: Math.round((Date.now() - (started.current.at || Date.now())) / 1000),
      });
      try {
        localStorage.removeItem(draftKey(def));
      } catch {
        // nothing kept
      }
      setPhase("done");
      const e = def.endings.find((x) => x.id === endingId);
      if (e?.redirect) setTimeout(() => window.location.assign(e.redirect ?? "/"), 2200);
    } catch (e) {
      setFailure(
        e instanceof SubmitFailure ? e.message : "Your answers could not be sent. They are still here; try again.",
      );
      setPhase("failed");
    }
  };

  const next = () => {
    if (at === -1) {
      setAt(0);
      return;
    }
    if (!validate()) return;
    const t = target();
    if ("ending" in t) void submit(t.ending);
    else {
      setHistory((h) => [...h, at]);
      setAt(t.step);
    }
  };
  const back = () => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev !== undefined) setAt(prev);
      else if (def.welcome.enabled) setAt(-1);
      return h.slice(0, -1);
    });
  };
  const isLast = step ? "ending" in target() : false;

  const onKey = (e: KeyboardEvent) => {
    if (phase !== "form") return;
    const el = e.target as HTMLElement;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      next();
      return;
    }
    // Enter continues everywhere (Shift+Enter makes a line break in long answers).
    if (e.key === "Enter" && !e.shiftKey) {
      // A focused button does its own thing on Enter (pick a choice, press OK); do not also move on.
      if (el.tagName === "BUTTON" || el.tagName === "A") return;
      e.preventDefault();
      next();
      return;
    }
    // Lettered keys pick choices when typing is not happening.
    if (
      step?.ids.length === 1 &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) &&
      /^[a-z]$/i.test(e.key) &&
      !e.metaKey &&
      !e.ctrlKey
    ) {
      const q = blockById.get(step.ids[0] ?? "");
      if (q && (q.kind === "choice" || q.kind === "checkboxes" || q.kind === "yesno")) {
        const i = LETTERS.indexOf(e.key.toUpperCase());
        const opts = q.kind === "yesno" ? ["yes", "no"] : q.choices.map((c) => c.id);
        const pick = opts[i];
        if (pick) {
          e.preventDefault();
          if (q.kind === "checkboxes") {
            const cur = (answers[q.id] as string[] | undefined) ?? [];
            setAnswer(q.id, cur.includes(pick) ? cur.filter((x) => x !== pick) : [...cur, pick]);
          } else setAnswer(q.id, q.kind === "yesno" ? pick === "yes" : pick);
        }
      }
    }
  };

  // Keys work wherever focus is on the page (Typeform: letters pick, Enter continues).
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const style: CSSProperties = {
    ...pageStyle,
    ...(def.design.accent ? ({ "--form-accent": def.design.accent } as CSSProperties) : {}),
  };
  const qIndex = (id: string) => def.blocks.filter((b) => isQuestion(b) && !b.hidden).findIndex((b) => b.id === id) + 1;
  const pct = at < 0 ? 0 : Math.round((at / Math.max(1, steps.length)) * 100);
  const consent = def.hideReaders
    ? "Your answers are encrypted on this device. Only the form's readers can open them."
    : `Your answers are encrypted on this device. Only ${readerNames.join(" and ")} can read them.`;

  if (closedReason && !preview)
    return (
      <div className={s.stage} style={style}>
        <div className={s.card}>
          <Musubi face="sleepy" size={110} />
          <h1 className={s.title}>{def.title}</h1>
          <p className={s.desc}>{closedReason.replace(/ Nothing was stored\.$/, "")}</p>
        </div>
      </div>
    );

  const endingDef = def.endings.find((e) => e.id === ending) ?? def.endings[0];
  return (
    <div className={[s.stage, embedded ? s.embedded : ""].join(" ")} style={style}>
      {def.settings.progress && phase === "form" ? (
        <div
          className={s.progress}
          role="progressbar"
          aria-label="Progress"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {preview ? (
        <p className={s.previewBanner}>Preview. Answers here are not sent; publish the form to collect real answers.</p>
      ) : null}
      {def.design.cover && !embedded ? <img className={s.cover} src={mediaUrl(def.design.cover.hash)} alt="" /> : null}
      <main className={s.main}>
        {def.design.logo ? <img className={s.logo} src={mediaUrl(def.design.logo.hash)} alt="" /> : null}
        {phase === "form" && at === -1 ? (
          <section className={s.screen} key="welcome">
            <h1 className={s.title}>{def.title}</h1>
            {def.description ? <p className={s.desc}>{def.description}</p> : null}
            <div className={s.okRow}>
              <Button variant="cord" size="lg" onClick={next} autoFocus>
                {def.welcome.button || "Start"}
              </Button>
              <span className={s.hint}>press Enter ↵</span>
            </div>
            {def.welcome.showTime ? (
              <p className={s.time}>
                <Icon name="clock" size={14} /> Takes {minutesToComplete(def)} min
              </p>
            ) : null}
          </section>
        ) : null}

        {phase === "form" && step ? (
          <section className={[s.screen, step.ids.length > 1 ? s.two : ""].join(" ")} key={`step-${at}`}>
            {step.heading ? <p className={s.kicker}>{step.heading}</p> : null}
            {step.ids.map((id, i) => {
              const b = blockById.get(id);
              if (!b) return null;
              if (b.kind === "statement")
                return (
                  <div key={id} className={s.q}>
                    <h2 className={s.qTitle}>{recall(b.title, def, answers)}</h2>
                    {b.description ? <p className={s.desc}>{recall(b.description, def, answers)}</p> : null}
                  </div>
                );
              if (!isQuestion(b)) return null;
              return (
                <QuestionView
                  key={id}
                  q={b}
                  number={def.settings.numbers ? qIndex(id) : 0}
                  title={recall(b.title, def, answers)}
                  description={recall(b.description, def, answers)}
                  value={answers[id]}
                  files={files[id] ?? []}
                  other={other[id] ?? ""}
                  error={errors[id]}
                  autoFocus={i === 0}
                  onChange={(v) => setAnswer(id, v)}
                  onFiles={(f) => {
                    setFiles((x) => ({ ...x, [id]: f }));
                    setErrors((e) => without(e, id));
                    if (!started.current.sent && !preview) {
                      started.current = { at: Date.now(), sent: true };
                      formEvent(def.id, { kind: "start" });
                    }
                  }}
                  onOther={(t) => setOther((o) => ({ ...o, [id]: t }))}
                />
              );
            })}
            <div className={s.okRow}>
              <Button variant="cord" size="lg" onClick={next} icon={isLast ? "lock" : undefined}>
                {isLast ? "Submit" : "OK"}
              </Button>
              <span className={s.hint}>{isLast ? "press Ctrl + Enter ↵" : "press Enter ↵"}</span>
            </div>
          </section>
        ) : null}

        {phase === "sending" ? (
          <section className={s.screen} aria-live="polite">
            <p className={s.kicker}>Encrypting…</p>
            <SealMoment steps={sendSteps} progress={progress} />
          </section>
        ) : null}

        {phase === "done" && endingDef ? (
          <section className={s.screen} aria-live="polite">
            <p className={s.sent}>
              <Icon name="check" size={16} /> {preview ? "Preview finished. Nothing was sent." : "Sent, sealed."}
            </p>
            <Musubi face="happy" size={110} />
            <h1 className={s.title}>{recall(endingDef.title, def, answers)}</h1>
            {endingDef.body ? <p className={s.desc}>{recall(endingDef.body, def, answers)}</p> : null}
            {endingDef.redirect ? <p className={s.hint}>Taking you to {new URL(endingDef.redirect).host}…</p> : null}
            {endingDef.button ? (
              <a className={s.endBtn} href={endingDef.button.url} rel="noreferrer">
                {endingDef.button.label}
              </a>
            ) : null}
          </section>
        ) : null}

        {phase === "failed" ? (
          <section className={s.screen}>
            <Oops
              title="Not sent"
              action={
                <Button variant="line" onClick={() => setPhase("form")}>
                  Back to the form
                </Button>
              }
            >
              {failure}
            </Oops>
          </section>
        ) : null}
      </main>
      <footer className={s.foot}>
        <p className={s.consent}>
          <Icon name="lock" size={13} /> {consent}
        </p>
        {phase === "form" && at >= 0 ? (
          <div className={s.nav}>
            <button
              type="button"
              aria-label="Previous"
              onClick={back}
              disabled={history.length === 0 && !def.welcome.enabled}
            >
              <Icon name="chev" size={18} className={s.up} />
            </button>
            <button type="button" aria-label="Next" onClick={next}>
              <Icon name="chev" size={18} className={s.down} />
            </button>
          </div>
        ) : null}
      </footer>
    </div>
  );
}

function QuestionView({
  q,
  number,
  title,
  description,
  value,
  files,
  other,
  error,
  autoFocus,
  onChange,
  onFiles,
  onOther,
}: {
  q: Question;
  number: number;
  title: string;
  description: string;
  value: AnswerValue | undefined;
  files: File[];
  other: string;
  error: string | undefined;
  autoFocus: boolean;
  onChange: (v: AnswerValue) => void;
  onFiles: (f: File[]) => void;
  onOther: (t: string) => void;
}) {
  const [fileErr, setFileErr] = useState<string | null>(null);
  const order = useMemo(() => {
    if (!("choices" in q)) return [];
    const c = [...q.choices];
    if ("randomize" in q && q.randomize) c.sort(() => Math.random() - 0.5);
    return c;
  }, [q]);
  const hint = pickHint(q);
  const str = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const picked = Array.isArray(value) ? value : [];
  const errId = `${q.id}-err`;
  const common = { "aria-invalid": error ? true : undefined, "aria-describedby": error ? errId : undefined } as const;

  return (
    <div className={s.q} role="group" aria-labelledby={`${q.id}-t`}>
      <h2 className={s.qTitle} id={`${q.id}-t`}>
        {number ? <span className={s.num}>{number} →</span> : null}
        {title}
        {q.required ? (
          <span className={s.req} aria-label="required">
            *
          </span>
        ) : null}
      </h2>
      {description ? <p className={s.desc}>{description}</p> : null}
      {hint ? <p className={s.pickHint}>{hint}</p> : null}

      {q.kind === "short" ||
      q.kind === "email" ||
      q.kind === "phone" ||
      q.kind === "link" ||
      q.kind === "number" ||
      q.kind === "wallet" ? (
        <>
          <input
            className={s.line}
            aria-labelledby={`${q.id}-t`}
            autoFocus={autoFocus}
            type={
              q.kind === "email"
                ? "email"
                : q.kind === "phone"
                  ? "tel"
                  : q.kind === "link"
                    ? "url"
                    : q.kind === "number"
                      ? "number"
                      : "text"
            }
            inputMode={q.kind === "number" ? "decimal" : undefined}
            placeholder={
              q.kind === "short"
                ? q.placeholder || "Type your answer here..."
                : q.kind === "email"
                  ? "name@example.com"
                  : q.kind === "phone"
                    ? "+81 90 1234 5678"
                    : q.kind === "link"
                      ? "https://"
                      : q.kind === "wallet"
                        ? "qor1…"
                        : "Type a number"
            }
            value={str}
            spellCheck={q.kind === "short"}
            onChange={(e) =>
              onChange(q.kind === "number" ? (e.target.value === "" ? null : Number(e.target.value)) : e.target.value)
            }
            {...common}
          />
          {q.kind === "wallet" && qorex() ? (
            <button
              type="button"
              className={s.walletBtn}
              onClick={() => {
                const w = qorex();
                if (!w) return;
                void w
                  .enable(NETWORK.chainId)
                  .then(() => w.getKey(NETWORK.chainId))
                  .then(
                    (k) => onChange(k.bech32Address),
                    () => undefined,
                  );
              }}
            >
              <Icon name="wallet" size={15} /> Use my QoreX address
            </button>
          ) : null}
        </>
      ) : null}

      {q.kind === "long" ? (
        <>
          <textarea
            className={s.area}
            aria-labelledby={`${q.id}-t`}
            autoFocus={autoFocus}
            placeholder={q.placeholder || "Type your answer here..."}
            value={str}
            rows={4}
            onChange={(e) => onChange(e.target.value)}
            {...common}
          />
          <p className={s.hint}>Shift ⇧ + Enter ↵ to make a line break</p>
        </>
      ) : null}

      {q.kind === "choice" || q.kind === "checkboxes" ? (
        <div className={s.choices} role={q.kind === "choice" ? "radiogroup" : "group"} aria-labelledby={`${q.id}-t`}>
          {order.map((c, i) => {
            const on = q.kind === "choice" ? value === c.id : picked.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                data-choice="1"
                role={q.kind === "choice" ? "radio" : "checkbox"}
                aria-checked={on}
                className={[s.choice, on ? s.on : ""].join(" ")}
                onClick={() =>
                  onChange(q.kind === "choice" ? c.id : on ? picked.filter((x) => x !== c.id) : [...picked, c.id])
                }
                autoFocus={autoFocus && i === 0}
              >
                <kbd>{LETTERS[i]}</kbd>
                {c.label}
                {on ? <Icon name="check" size={16} className={s.tick} /> : null}
              </button>
            );
          })}
          {q.other ? (
            <label className={[s.choice, s.otherBox].join(" ")}>
              <kbd>{LETTERS[order.length]}</kbd>
              <input
                placeholder="Other"
                value={other}
                onChange={(e) => {
                  onOther(e.target.value);
                  if (e.target.value && q.kind === "choice") onChange("other");
                  if (e.target.value && q.kind === "checkboxes" && !picked.includes("other"))
                    onChange([...picked, "other"]);
                }}
              />
            </label>
          ) : null}
          {q.kind === "checkboxes" && q.none ? (
            <button
              type="button"
              data-choice="1"
              role="checkbox"
              aria-checked={picked.includes("none")}
              className={[s.choice, picked.includes("none") ? s.on : ""].join(" ")}
              onClick={() => onChange(picked.includes("none") ? [] : ["none"])}
            >
              <kbd>{LETTERS[order.length + (q.other ? 1 : 0)]}</kbd>
              None of the above
            </button>
          ) : null}
        </div>
      ) : null}

      {q.kind === "dropdown" ? (
        <select
          className={s.select}
          aria-labelledby={`${q.id}-t`}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          {...common}
        >
          <option value="">Choose…</option>
          {q.choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      ) : null}

      {q.kind === "yesno" ? (
        <div className={s.choices} role="radiogroup" aria-labelledby={`${q.id}-t`}>
          {[
            ["yes", "Yes"],
            ["no", "No"],
          ].map(([v, l], i) => (
            <button
              key={v}
              type="button"
              data-choice="1"
              role="radio"
              aria-checked={value === (v === "yes")}
              className={[s.choice, value === (v === "yes") ? s.on : ""].join(" ")}
              onClick={() => onChange(v === "yes")}
              autoFocus={autoFocus && i === 0}
            >
              <kbd>{LETTERS[i]}</kbd>
              {l}
            </button>
          ))}
        </div>
      ) : null}

      {q.kind === "rating" ? (
        <div className={s.rating} role="radiogroup" aria-labelledby={`${q.id}-t`}>
          {Array.from({ length: q.max }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              data-choice="1"
              role="radio"
              aria-checked={value === n}
              aria-label={`${n} of ${q.max}`}
              className={[s.star, typeof value === "number" && n <= value ? s.starOn : ""].join(" ")}
              onClick={() => onChange(n)}
            >
              <Icon name={q.icon === "heart" ? "heart" : "star"} size={30} />
            </button>
          ))}
        </div>
      ) : null}

      {q.kind === "scale" ? (
        <div>
          <div className={s.scale} role="radiogroup" aria-labelledby={`${q.id}-t`}>
            {Array.from({ length: q.to - q.from + 1 }, (_, i) => q.from + i).map((n) => (
              <button
                key={n}
                type="button"
                data-choice="1"
                role="radio"
                aria-checked={value === n}
                className={[s.scaleBtn, value === n ? s.on : ""].join(" ")}
                onClick={() => onChange(n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div className={s.scaleLabels}>
            <span>{q.left}</span>
            <span>{q.center}</span>
            <span>{q.right}</span>
          </div>
        </div>
      ) : null}

      {q.kind === "date" ? (
        <input
          className={s.line}
          type="date"
          aria-labelledby={`${q.id}-t`}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          {...common}
        />
      ) : null}

      {q.kind === "file" ? (
        <div className={s.fileBox}>
          {files.length ? (
            <ul className={s.files}>
              {files.map((f, i) => (
                <li key={`${f.name}-${i}`}>
                  <Icon name="file" size={15} /> {f.name} · {(f.size / 1024 / 1024).toFixed(1)} MB
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => onFiles(files.filter((_, j) => j !== i))}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {files.length < q.maxFiles ? (
            <label className={s.drop}>
              <Icon name="upload" size={18} /> Choose {q.maxFiles > 1 ? `up to ${q.maxFiles} files` : "a file"} · up to{" "}
              {q.maxMB} MB each
              <input
                type="file"
                hidden
                multiple={q.maxFiles > 1}
                onChange={(e) => {
                  const picked2 = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  const tooBig = picked2.find((f) => f.size > q.maxMB * 1024 * 1024);
                  if (tooBig) {
                    setFileErr(`“${tooBig.name}” is larger than ${q.maxMB} MB. Nothing was added.`);
                    return;
                  }
                  setFileErr(null);
                  onFiles([...files, ...picked2].slice(0, q.maxFiles));
                }}
              />
            </label>
          ) : null}
          <p className={s.hint}>
            <Icon name="lock" size={12} /> Encrypted on this device before it uploads.
          </p>
          {fileErr ? <p className={s.err}>{fileErr}</p> : null}
        </div>
      ) : null}

      {q.kind === "signature" ? (
        <SignaturePad onChange={(png) => onFiles(png ? [png] : [])} has={files.length > 0} />
      ) : null}

      {error ? (
        <p className={s.err} id={errId} role="alert">
          <Icon name="alert" size={14} /> {error}
        </p>
      ) : null}
    </div>
  );
}
