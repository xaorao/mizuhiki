"use client";
/**
 * The owner's forms (spec 5.9): Typeform's list (responses, updated) and the
 * start choices: blank, a template, or "Describe your form" (an AI draft of the
 * questions only; questions are not secret; shown only when the helper is on).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Chip, EmptyState, Icon, Oops, Sheet, Skeleton, StatusChip, TextArea, useToast } from "@mizuhiki/ui";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { api, ApiFailure } from "@/lib/api";
import { TEMPLATES, fromTemplate, newForm, saveFormDraft, type FormRow } from "./model";
import { draftFromDescription } from "./ai";
import s from "./forms.module.css";

export function FormsList() {
  const acct = useAccount();
  const owner = useOwner();
  const router = useRouter();
  const toast = useToast();
  const account = acct.account;
  if (!account) throw new Error("Forms need an unlocked account");
  const [rows, setRows] = useState<FormRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [ai, setAi] = useState<{ on: boolean; text: string; err: string | null }>({ on: false, text: "", err: null });
  const name = owner.draft?.manifest.name ?? "";

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ forms: FormRow[] }>("/owner/forms", { token: await owner.token() });
      setRows(r.forms);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your forms could not be loaded.");
    }
  }, [owner]);
  useEffect(() => {
    void load();
    void api
      .get<{ form?: boolean }>("/ai/status")
      .then((r) => setAi((a) => ({ ...a, on: r.form === true })))
      .catch(() => undefined);
  }, [load]);

  const create = async (key: string, make: () => Promise<ReturnType<typeof newForm>> | ReturnType<typeof newForm>) => {
    setBusy(key);
    try {
      const def = await make();
      await saveFormDraft(account, await owner.token(), def);
      router.push(`/app/forms/${def.id}`);
    } catch (e) {
      toast.show(e instanceof ApiFailure ? e.message : (e as Error).message || "The form could not be created.", {
        tone: "error",
      });
      setBusy(null);
    }
  };

  return (
    <div className={s.page}>
      <header className={s.top}>
        <h1>Forms</h1>
        <Chip icon="lock" tone="white">
          Answers sealed to you
        </Chip>
        <Button variant="cord" icon="plus" onClick={() => setStart(true)} className={s.newBtn}>
          New form
        </Button>
      </header>
      {error ? (
        <Oops title="Not loaded" action={<button onClick={() => void load()}>Try again</button>}>
          {error}
        </Oops>
      ) : rows === null ? (
        <Skeleton lines={4} />
      ) : rows.filter((r) => !r.archived).length === 0 ? (
        <EmptyState
          title="Create a new form to get started"
          face="sleepy"
          action={
            <Button variant="cord" icon="plus" onClick={() => setStart(true)}>
              New form
            </Button>
          }
        >
          Intake, applications, feedback. Answers are encrypted in the respondent&apos;s browser; only you can read
          them.
        </EmptyState>
      ) : (
        <ul className={s.list}>
          {rows
            .filter((r) => !r.archived)
            .map((r) => (
              <li key={r.id}>
                <Link href={`/app/forms/${r.id}`} className={s.row}>
                  <span className={s.rowIcon}>
                    <Icon name="form" size={20} />
                  </span>
                  <span className={s.rowText}>
                    <b>{r.published?.title ?? "Untitled draft"}</b>
                    <small>
                      {r.responses ? `${r.responses} answer${r.responses === 1 ? "" : "s"}` : "No answers yet"} · Edited{" "}
                      {new Date(r.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </small>
                  </span>
                  {r.published ? (
                    r.published.closed ? (
                      <StatusChip status="neutral">Closed</StatusChip>
                    ) : (
                      <StatusChip status="ok">Published</StatusChip>
                    )
                  ) : (
                    <StatusChip status="wait">Draft</StatusChip>
                  )}
                </Link>
              </li>
            ))}
        </ul>
      )}

      <Sheet open={start} onClose={() => setStart(false)} title="Create a form" wide>
        <div className={s.start}>
          <button
            type="button"
            className={s.startCard}
            disabled={busy !== null}
            onClick={() => void create("blank", () => newForm(account, name))}
          >
            <Icon name="plus" size={22} />
            <b>Start from scratch</b>
            <span>A blank form. Type / to insert questions.</span>
          </button>
          {ai.on ? (
            <div className={s.startCard}>
              <Icon name="sparkle" size={22} />
              <b>Describe your form</b>
              <span>A draft of the questions only. Questions are public; answers never reach the helper.</span>
              <TextArea
                label="What should it ask?"
                hideLabel
                value={ai.text}
                maxLength={600}
                onChange={(e) => setAi({ ...ai, text: e.target.value, err: null })}
                placeholder="An intake form for my illustration studio: name, project, budget, deadline, references"
              />
              {ai.err ? <p className={s.err}>{ai.err}</p> : null}
              <Button
                variant="line"
                icon="sparkle"
                busy={busy === "ai"}
                disabled={ai.text.trim().length < 10}
                onClick={() =>
                  void create("ai", async () => {
                    try {
                      return await draftFromDescription(account, name, ai.text, await owner.token());
                    } catch (e) {
                      setAi((a) => ({ ...a, err: (e as Error).message }));
                      throw e;
                    }
                  })
                }
              >
                Draft it
              </Button>
            </div>
          ) : null}
          <h3 className={s.tplHead}>Or use a template</h3>
          <div className={s.templates}>
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                className={s.tpl}
                disabled={busy !== null}
                onClick={() => void create(t.key, () => fromTemplate(account, name, t))}
              >
                <b>{t.title}</b>
                <span>{t.description}</span>
                <small>{t.blocks.length} questions · Use this template</small>
              </button>
            ))}
          </div>
        </div>
      </Sheet>
    </div>
  );
}
