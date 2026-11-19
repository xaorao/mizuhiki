"use client";
/**
 * The Logic tab of the form editor (spec 5.9, Typeform's logic): for each
 * question, rule sentences "When [question] [is] [answer] go to [question or
 * ending]", "+ Add condition", "Delete rule", "+ Add branching rule", "All
 * other cases go to" and "Delete all rules"; a flow map that draws the forks;
 * and a "Try it" box that runs the same path logic as the respondent's form.
 * Rules only ever go forward, so a form cannot loop.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState, Icon, IconButton, Oops, Segmented, StatusChip, useReducedMotion } from "@mizuhiki/ui";
import { formProblems, isQuestion, type AnswerValue, type FormDef, type Logic, type Question } from "@mizuhiki/core";
import type { TabProps } from "./tabTypes";
import { toDisplay } from "./mentions";
import { buildSteps } from "./FormRunner";
import { FlowMap } from "./FlowMap";
import { KINDS } from "./model";
import {
  MAX_CONDITIONS,
  MAX_RULES,
  blockLabel,
  conditionSources,
  endingLabel,
  explainNext,
  fitCondition,
  fixProblem,
  freshCondition,
  freshRule,
  logicProblems,
  opLabel,
  opNeedsValue,
  opsFor,
  questionNumber,
  stepIndexOf,
  targetLabel,
  targetShort,
  targetsAfter,
  valueKindOf,
  valueOptions,
  visibleQuestions,
  withLogicFor,
  type Condition,
  type FlowStep,
  type LogicProblem,
  type Op,
  type Rule,
} from "./logicHelpers";
import s from "./logic.module.css";

type Change = (after: string, fn: (l: Logic) => Logic | null, coalesce?: string) => void;

const kindOf = (q: Question) => KINDS.find((k) => k.kind === q.kind);
const problemKey = (p: LogicProblem) =>
  `${p.kind}:${p.after}:${"rule" in p ? p.rule : ""}:${"cond" in p ? p.cond : ""}`;

export function LogicTab(props: TabProps) {
  const { def, update } = props;
  const reduced = useReducedMotion();
  const steps = useMemo(() => buildSteps(def), [def]);
  const questions = useMemo(() => visibleQuestions(def), [def]);
  const problems = useMemo(() => logicProblems(def, steps), [def, steps]);
  const publishProblems = useMemo(() => formProblems(def).filter((p) => /logic rule|all other cases/i.test(p)), [def]);
  const hiddenCount = def.blocks.filter((b) => isQuestion(b) && b.hidden).length;
  const withLogic = questions.filter((q) => def.logic.some((l) => l.after === q.id)).length;

  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);

  const change: Change = (after, fn, coalesce) => update((d) => withLogicFor(d, after, fn), coalesce);

  const showRules = (id: string) => {
    const el = document.getElementById(`logic-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
    clearTimeout(flashTimer.current);
    setFlash(id);
    flashTimer.current = setTimeout(() => setFlash(null), 1400);
  };

  // "Try it": sample answers and the screen they are tried on.
  const firstWithLogic = questions.find((q) => def.logic.some((l) => l.after === q.id))?.id;
  const [tryId, setTryId] = useState<string>("");
  const [sample, setSample] = useState<Record<string, AnswerValue>>({});
  const tryQ = questions.find((q) => q.id === tryId) ?? questions.find((q) => q.id === firstWithLogic) ?? questions[0];
  const tryAt = tryQ ? stepIndexOf(steps, tryQ.id) : -1;
  const tried = tryAt >= 0 ? explainNext(def, steps, tryAt, sample) : null;
  const active = tried
    ? {
        from: tryAt,
        to:
          tried.to.kind === "step"
            ? tried.to.index
            : steps.length +
              Math.max(
                0,
                def.endings.findIndex((e) => e.id === tried.to.id),
              ),
      }
    : null;

  const problemsBox =
    problems.length || publishProblems.length ? (
      <Oops title="Some rules cannot work as written">
        <span>Nothing has been sent to anyone. Fix these before you publish.</span>
        <ul className={s.problems}>
          {problems.map((p) => (
            <li key={problemKey(p)}>
              <span>{p.text}</span>
              <Button size="sm" variant="line" icon="trash" onClick={() => update((d) => fixProblem(d, p))}>
                Remove broken rule
              </Button>
            </li>
          ))}
        </ul>
      </Oops>
    ) : null;

  if (questions.length < 2)
    return (
      <div className={s.wrap}>
        {problemsBox}
        <EmptyState title="Add at least two questions to send people different ways." face="sleepy" />
      </div>
    );

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <div>
          <p className={s.kicker} lang="ja">
            むすび
          </p>
          <h2 className={s.h}>Logic</h2>
          <p className={s.lede}>
            Send people different ways depending on their answers. Rules are checked from the top, and the first one
            that matches wins. They only go forward, so nobody gets stuck going round in circles.
          </p>
        </div>
        {withLogic ? (
          <StatusChip status="ok">
            Logic set on {withLogic} {withLogic === 1 ? "question" : "questions"}
          </StatusChip>
        ) : (
          <StatusChip status="neutral">No rules yet, everyone goes in order</StatusChip>
        )}
      </header>

      {problemsBox}

      <div className={s.cols}>
        <div className={s.list}>
          {questions.map((q) => (
            <QuestionLogic
              key={q.id}
              def={def}
              steps={steps}
              q={q}
              change={change}
              problems={problems.filter((p) => p.after === q.id)}
              flash={flash === q.id}
            />
          ))}
          {hiddenCount ? (
            <p className={s.note}>
              <Icon name="eye" size={16} />
              {hiddenCount === 1 ? "1 hidden question is" : `${hiddenCount} hidden questions are`} skipped by
              respondents, so {hiddenCount === 1 ? "it has" : "they have"} no rules here.
            </p>
          ) : null}
        </div>

        <aside className={s.side} aria-label="Flow map and try it">
          <section className={s.sideCard}>
            <header className={s.sideHead}>
              <h3>Flow map</h3>
              <span>Pick a question to see its rules</span>
            </header>
            <FlowMap def={def} steps={steps} onPick={showRules} active={active} />
          </section>

          {tryQ && tried ? (
            <TryIt
              def={def}
              steps={steps}
              questions={questions}
              q={tryQ}
              sample={sample}
              onQuestion={setTryId}
              onAnswer={(id, v) => setSample((a) => ({ ...a, [id]: v }))}
              result={tried}
            />
          ) : null}
        </aside>
      </div>
    </div>
  );
}

// ---- one question's rules ----------------------------------------------------------------

function QuestionLogic({
  def,
  steps,
  q,
  change,
  problems,
  flash,
}: {
  def: FormDef;
  steps: FlowStep[];
  q: Question;
  change: Change;
  problems: LogicProblem[];
  flash: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const logic = def.logic.find((l) => l.after === q.id);
  const rules = logic?.rules ?? [];
  const n = questionNumber(def, q.id);
  const kind = kindOf(q);
  const at = stepIndexOf(steps, q.id);
  const stepIds = steps[at]?.ids ?? [];
  const partner = stepIds.find((id) => id !== q.id);
  const partnerFirst = partner !== undefined && stepIds[0] === partner;
  const nextLabel =
    at + 1 < steps.length ? targetShort(def, steps[at + 1]?.ids[0] ?? "") : targetShort(def, def.endings[0]?.id ?? "");
  const sources = conditionSources(def, q.id);
  const canAdd = rules.length < MAX_RULES && freshRule(def, steps, q) !== null;
  const has = logic !== undefined;
  const healthy = has && problems.length === 0;

  const addRule = () =>
    change(q.id, (l) => {
      const r = freshRule(def, steps, q);
      return r ? { ...l, rules: [...l.rules, r] } : l;
    });

  return (
    <article
      id={`logic-${q.id}`}
      tabIndex={-1}
      className={[s.card, has ? s.cardOn : "", flash ? s.flash : ""].join(" ")}
      aria-labelledby={`logic-${q.id}-h`}
    >
      <header className={s.cardHead}>
        <span className={s.badge} aria-hidden="true">
          {kind ? <Icon name={kind.icon} size={16} /> : null}Q{n}
        </span>
        <div className={s.cardTitle}>
          <h3 id={`logic-${q.id}-h`}>
            After Q{n} · {toDisplay(q.title, def.blocks).trim() || "Untitled question"}
          </h3>
          <small>{kind?.label ?? q.kind}</small>
        </div>
        {healthy ? (
          <span className={s.setChip} key="set">
            <StatusChip status="ok">Logic set</StatusChip>
          </span>
        ) : null}
      </header>

      {partner !== undefined ? (
        <p className={s.hint}>
          <Icon name="info" size={16} />
          Shares a screen with {targetShort(def, partner)}.{" "}
          {partnerFirst
            ? `Its rules are checked first, then these.`
            : `These rules are checked first, then ${targetShort(def, partner)}'s.`}
        </p>
      ) : null}

      {!has ? <p className={s.empty}>Everyone goes on to the next question ({nextLabel}).</p> : null}

      {rules.length ? (
        <ol className={s.rules}>
          {rules.map((r, ri) => (
            <RuleEditor
              key={`${q.id}-${String(ri)}`}
              def={def}
              steps={steps}
              q={q}
              rule={r}
              index={ri}
              count={rules.length}
              sources={sources}
              change={change}
              problems={problems.filter((p) => "rule" in p && p.rule === ri)}
            />
          ))}
        </ol>
      ) : null}

      <div className={s.cardActions}>
        <Button size="sm" variant="line" icon="plus" disabled={!canAdd} onClick={addRule}>
          Add branching rule
        </Button>
        {!sources.length ? (
          <span className={s.muted}>File and signature answers stay sealed as files, so rules cannot check them.</span>
        ) : rules.length >= MAX_RULES ? (
          <span className={s.muted}>That is the most rules one question can have ({MAX_RULES}).</span>
        ) : null}
      </div>

      {has ? <Otherwise def={def} steps={steps} q={q} logic={logic} nextLabel={nextLabel} change={change} /> : null}

      {has ? (
        <div className={s.deleteAll}>
          {confirming ? (
            <div className={s.confirm} role="group" aria-label={`Delete all rules after Q${n}`}>
              <span>Delete every rule after Q{n}? People will go on in order again.</span>
              <Button
                size="sm"
                variant="danger"
                icon="trash"
                onClick={() => {
                  setConfirming(false);
                  change(q.id, () => null);
                }}
              >
                Delete all rules
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirming(false)} autoFocus>
                Keep them
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setConfirming(true)}>
              Delete all rules
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
}

function Otherwise({
  def,
  steps,
  q,
  logic,
  nextLabel,
  change,
}: {
  def: FormDef;
  steps: FlowStep[];
  q: Question;
  logic: Logic;
  nextLabel: string;
  change: Change;
}) {
  const t = targetsAfter(def, steps, q.id);
  const offered = new Set([...t.blocks.map((b) => b.id), ...t.endings.map((e) => e.id)]);
  const stray = logic.otherwise !== "" && !offered.has(logic.otherwise);
  return (
    <div className={s.otherwise}>
      <span className={s.word}>{logic.rules.length ? "All other cases go to" : "Everyone goes to"}</span>
      <TargetSelect
        label="All other cases go to"
        value={logic.otherwise}
        stray={stray ? strayLabel(def, logic.otherwise) : null}
        blocks={t.blocks}
        def={def}
        next={`The next question (${nextLabel})`}
        onChange={(v) => change(q.id, (l) => ({ ...l, otherwise: v }))}
      />
    </div>
  );
}

const strayLabel = (def: FormDef, id: string): string => {
  const exists = def.blocks.some((b) => b.id === id) || def.endings.some((e) => e.id === id);
  return exists ? `Back to ${targetLabel(def, id, 30)} (not allowed)` : "A step that was deleted";
};

function TargetSelect({
  label,
  value,
  stray,
  blocks,
  def,
  next,
  onChange,
}: {
  label: string;
  value: string;
  stray: string | null;
  blocks: FormDef["blocks"];
  def: FormDef;
  next?: string | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <select
      className={[s.select, s.selectWide, stray ? s.selectBad : ""].join(" ")}
      aria-label={label}
      aria-invalid={stray ? true : undefined}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {stray ? (
        <option value={value} disabled>
          {stray}
        </option>
      ) : null}
      {next !== undefined ? <option value="">{next}</option> : null}
      {blocks.length ? (
        <optgroup label="Questions">
          {blocks.map((b) => (
            <option key={b.id} value={b.id}>
              {blockLabel(def, b, 40)}
            </option>
          ))}
        </optgroup>
      ) : null}
      <optgroup label="Endings">
        {def.endings.map((e) => (
          <option key={e.id} value={e.id}>
            {endingLabel(def, e.id, 40)}
          </option>
        ))}
      </optgroup>
    </select>
  );
}

// ---- one rule --------------------------------------------------------------------------------

function RuleEditor({
  def,
  steps,
  q,
  rule,
  index,
  count,
  sources,
  change,
  problems,
}: {
  def: FormDef;
  steps: FlowStep[];
  q: Question;
  rule: Rule;
  index: number;
  count: number;
  sources: Question[];
  change: Change;
  problems: LogicProblem[];
}) {
  const t = targetsAfter(def, steps, q.id);
  const offered = new Set([...t.blocks.map((b) => b.id), ...t.endings.map((e) => e.id)]);
  const stray = !offered.has(rule.to);
  const editRule = (fn: (r: Rule) => Rule | null, coalesce?: string) =>
    change(
      q.id,
      (l) => ({
        ...l,
        rules: l.rules.flatMap((r, i) => {
          if (i !== index) return [r];
          const next = fn(r);
          return next ? [next] : [];
        }),
      }),
      coalesce,
    );
  const move = (by: -1 | 1) =>
    change(q.id, (l) => {
      const rules = [...l.rules];
      const j = index + by;
      const a = rules[index];
      const b = rules[j];
      if (!a || !b) return l;
      rules[index] = b;
      rules[j] = a;
      return { ...l, rules };
    });

  return (
    <li className={[s.rule, problems.length ? s.ruleBad : ""].join(" ")}>
      <div className={s.ruleHead}>
        <span className={s.ruleNo}>Rule {index + 1}</span>
        <span className={s.ruleTools}>
          <IconButton
            icon="chev"
            label={`Move rule ${String(index + 1)} up`}
            size="sm"
            className={s.up}
            disabled={index === 0}
            onClick={() => move(-1)}
          />
          <IconButton
            icon="chev"
            label={`Move rule ${String(index + 1)} down`}
            size="sm"
            className={s.down}
            disabled={index === count - 1}
            onClick={() => move(1)}
          />
        </span>
      </div>

      {rule.when.map((c, ci) => (
        <ConditionRow
          key={`${String(index)}-${String(ci)}`}
          def={def}
          c={c}
          first={ci === 0}
          sources={sources}
          coalesce={`logic:${q.id}:${String(index)}:${String(ci)}`}
          onChange={(next, coalesce) =>
            editRule((r) => ({ ...r, when: r.when.map((x, i) => (i === ci ? next : x)) }), coalesce)
          }
          onRemove={
            rule.when.length > 1 ? () => editRule((r) => ({ ...r, when: r.when.filter((_, i) => i !== ci) })) : null
          }
        />
      ))}

      <div className={s.ruleRow}>
        <Button
          size="sm"
          variant="quiet"
          icon="plus"
          disabled={rule.when.length >= MAX_CONDITIONS || !sources.length}
          onClick={() =>
            editRule((r) => {
              const on = sources.find((x) => x.id === q.id) ?? sources[sources.length - 1];
              return on ? { ...r, when: [...r.when, freshCondition(on)] } : r;
            })
          }
        >
          Add condition
        </Button>
      </div>

      <div className={s.goRow}>
        <span className={s.word}>go to</span>
        <TargetSelect
          label={`Rule ${String(index + 1)} goes to`}
          value={rule.to}
          stray={stray ? strayLabel(def, rule.to) : null}
          blocks={t.blocks}
          def={def}
          onChange={(v) => editRule((r) => ({ ...r, to: v }))}
        />
      </div>

      {problems.length ? (
        <ul className={s.ruleProblems}>
          {problems.map((p) => (
            <li key={problemKey(p)}>
              <Icon name="alert" size={16} />
              {p.text}
            </li>
          ))}
        </ul>
      ) : null}

      <div className={s.ruleFoot}>
        <Button size="sm" variant="ghost" icon="trash" onClick={() => editRule(() => null)}>
          Delete rule
        </Button>
      </div>
    </li>
  );
}

function ConditionRow({
  def,
  c,
  first,
  sources,
  coalesce,
  onChange,
  onRemove,
}: {
  def: FormDef;
  c: Condition;
  first: boolean;
  sources: Question[];
  coalesce: string;
  onChange: (c: Condition, coalesce?: string) => void;
  onRemove: (() => void) | null;
}) {
  const q = def.blocks.find((b): b is Question => b.id === c.q && isQuestion(b));
  const known = q !== undefined && sources.some((x) => x.id === q.id);
  const ops: Op[] = q ? opsFor(q) : [];
  const opStray = !ops.includes(c.op);
  const needs = opNeedsValue(c.op);
  const vk = q ? valueKindOf(q) : "text";
  const opts = q ? valueOptions(q) : [];
  const valueStray = needs && opts.length > 0 && !opts.some((o) => o.value === c.value);
  const emptyValue = needs && !opts.length && c.value.trim() === "";

  return (
    <div className={s.cond}>
      <span className={s.word}>{first ? "When" : "and"}</span>
      <select
        className={[s.select, s.selectQ, known ? "" : s.selectBad].join(" ")}
        aria-label="Question"
        value={c.q}
        onChange={(e) => {
          const nq = sources.find((x) => x.id === e.target.value);
          if (nq) onChange(fitCondition(nq, { ...c, q: nq.id }));
        }}
      >
        {!known ? (
          <option value={c.q} disabled>
            {q ? `${blockLabel(def, q, 30)} (cannot be checked)` : "A deleted question"}
          </option>
        ) : null}
        {sources.map((x) => (
          <option key={x.id} value={x.id}>
            {blockLabel(def, x, 34)}
          </option>
        ))}
      </select>
      <select
        className={[s.select, opStray ? s.selectBad : ""].join(" ")}
        aria-label="Condition"
        value={c.op}
        onChange={(e) => {
          const op = ops.find((o) => o === e.target.value);
          if (op && q) onChange(fitCondition(q, { ...c, op }));
        }}
      >
        {opStray ? (
          <option value={c.op} disabled>
            {opLabel(c.op, q)} (does not fit)
          </option>
        ) : null}
        {ops.map((o) => (
          <option key={o} value={o}>
            {opLabel(o, q)}
          </option>
        ))}
      </select>
      {needs && q ? (
        opts.length ? (
          <select
            className={[s.select, s.selectV, valueStray ? s.selectBad : ""].join(" ")}
            aria-label="Answer"
            value={c.value}
            onChange={(e) => onChange({ ...c, value: e.target.value })}
          >
            {valueStray ? (
              <option value={c.value} disabled>
                An answer that was removed
              </option>
            ) : null}
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <input
            className={[s.input, emptyValue ? s.selectBad : ""].join(" ")}
            aria-label="Answer"
            type={vk === "number" ? "number" : vk === "date" ? "date" : "text"}
            inputMode={vk === "number" ? "decimal" : undefined}
            maxLength={200}
            placeholder={vk === "number" ? "A number" : "Type an answer"}
            value={c.value}
            onChange={(e) => onChange({ ...c, value: e.target.value.slice(0, 200) }, coalesce)}
          />
        )
      ) : null}
      {onRemove ? (
        <IconButton icon="x" label="Remove this condition" size="sm" className={s.condX} onClick={onRemove} />
      ) : null}
      {emptyValue ? (
        <p className={s.condHint}>
          {vk === "number" ? "Type a number to compare with." : "Type the answer to compare with."}
        </p>
      ) : null}
    </div>
  );
}

// ---- try it ---------------------------------------------------------------------------------

function TryIt({
  def,
  steps,
  questions,
  q,
  sample,
  onQuestion,
  onAnswer,
  result,
}: {
  def: FormDef;
  steps: FlowStep[];
  questions: Question[];
  q: Question;
  sample: Record<string, AnswerValue>;
  onQuestion: (id: string) => void;
  onAnswer: (id: string, v: AnswerValue) => void;
  result: ReturnType<typeof explainNext>;
}) {
  const at = stepIndexOf(steps, q.id);
  const ids = steps[at]?.ids ?? [q.id];
  const checked = [
    ...new Set(
      def.logic.filter((l) => ids.includes(l.after)).flatMap((l) => l.rules.flatMap((r) => r.when.map((c) => c.q))),
    ),
  ]
    .map((id) => def.blocks.find((b): b is Question => b.id === id && isQuestion(b)))
    .filter((x): x is Question => x !== undefined && !x.hidden && valueKindOf(x) !== "none");
  const dest = result.to.kind === "step" ? targetLabel(def, result.to.id, 40) : endingLabel(def, result.to.id, 40);
  const decider = result.decidedBy ? targetShort(def, result.decidedBy) : "";
  const why =
    result.why === "rule"
      ? `Rule ${String(result.rule + 1)} after ${decider} matched.`
      : result.why === "otherwise"
        ? "No rule matched, so “all other cases” applies."
        : checked.length
          ? "No rule matched, so they go on in order."
          : "This question has no rules, so everyone goes on in order.";

  return (
    <section className={s.sideCard} aria-labelledby="logic-try-h">
      <header className={s.sideHead}>
        <h3 id="logic-try-h">Try it</h3>
        <span>Pick answers and see where someone goes next</span>
      </header>
      <div className={s.try}>
        <label className={s.tryField}>
          <span>After</span>
          <select
            className={[s.select, s.selectWide].join(" ")}
            value={q.id}
            onChange={(e) => onQuestion(e.target.value)}
          >
            {questions.map((x) => (
              <option key={x.id} value={x.id}>
                {blockLabel(def, x, 40)}
                {def.logic.some((l) => l.after === x.id) ? " · has rules" : ""}
              </option>
            ))}
          </select>
        </label>
        {checked.map((x) => (
          <SampleAnswer key={x.id} def={def} q={x} value={sample[x.id]} onChange={(v) => onAnswer(x.id, v)} />
        ))}
        <div className={s.tryResult} role="status" aria-live="polite">
          <Icon name="arrow" size={20} />
          <div>
            <b>They go to {dest}</b>
            <small>{why}</small>
          </div>
        </div>
      </div>
    </section>
  );
}

function SampleAnswer({
  def,
  q,
  value,
  onChange,
}: {
  def: FormDef;
  q: Question;
  value: AnswerValue | undefined;
  onChange: (v: AnswerValue) => void;
}) {
  const name = blockLabel(def, q, 40);
  const vk = valueKindOf(q);
  const opts = valueOptions(q);
  if (q.kind === "yesno") {
    const cur = value === true ? "yes" : value === false ? "no" : "none";
    return (
      <div className={s.tryField}>
        <span>{name}</span>
        <Segmented
          label={name}
          value={cur}
          onChange={(v) => onChange(v === "yes" ? true : v === "no" ? false : null)}
          options={[
            { value: "none", label: "No answer" },
            { value: "yes", label: "Yes" },
            { value: "no", label: "No" },
          ]}
        />
      </div>
    );
  }
  if (q.kind === "checkboxes") {
    const picked = Array.isArray(value) ? value : [];
    return (
      <div className={s.tryField} role="group" aria-label={name}>
        <span>{name}</span>
        <div className={s.picks}>
          {opts.map((o) => {
            const on = picked.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                className={[s.pick, on ? s.pickOn : ""].join(" ")}
                onClick={() => onChange(on ? picked.filter((x) => x !== o.value) : [...picked, o.value])}
              >
                {on ? <Icon name="check" size={14} /> : null}
                {o.label}
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  if (opts.length)
    return (
      <label className={s.tryField}>
        <span>{name}</span>
        <select
          className={[s.select, s.selectWide].join(" ")}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">No answer</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label className={s.tryField}>
      <span>{name}</span>
      <input
        className={s.input}
        type={vk === "number" ? "number" : vk === "date" ? "date" : "text"}
        inputMode={vk === "number" ? "decimal" : undefined}
        placeholder="No answer"
        value={typeof value === "number" || typeof value === "string" ? String(value) : ""}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "") onChange(null);
          else if (vk === "number" && q.kind !== "number") onChange(Number(v));
          else onChange(v);
        }}
      />
    </label>
  );
}
