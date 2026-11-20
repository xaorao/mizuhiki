"use client";
/**
 * New request and Edit request (Dropbox's "Request files"): title, description,
 * an optional deadline with "allow late uploads", and the naming rule. A new
 * request goes straight to the share step, as Dropbox does.
 */
import { useEffect, useState } from "react";
import { Button, ChoiceCard, Icon, Oops, Sheet, TextArea, TextField, ToggleRow } from "@mizuhiki/ui";
import { NAMING_LABEL, NAMING_RULES, type FileRequest, type NamingRule } from "@mizuhiki/core";
import type { RequestInput } from "./engine";
import s from "./requests.module.css";
import { failureText } from "@/lib/failure";

const pad = (n: number) => String(n).padStart(2, "0");
/** An instant as the value of <input type="date"> and <input type="time"> in this device's zone. */
function localParts(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: "", time: "17:00" };
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

const NAMING_DETAIL: Record<NamingRule, string> = {
  original: "Files arrive with the names they had.",
  uploader: "“Hana Mori – w2.pdf”. Uploaders are asked for their name.",
  date: "“2026-11-19 – w2.pdf”, the day it was uploaded.",
};

export function RequestSheet({
  open,
  onClose,
  editing,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  /** The request being edited, or none for a new one. */
  editing?: FileRequest | undefined;
  onSave: (input: RequestInput) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [hasDeadline, setHasDeadline] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("17:00");
  const [allowLate, setAllowLate] = useState(false);
  const [naming, setNaming] = useState<NamingRule>("original");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    const p = localParts(editing?.deadline ?? null);
    setTitle(editing?.title ?? "");
    setDescription(editing?.description ?? "");
    setHasDeadline(!!editing?.deadline);
    setDate(p.date);
    setTime(p.time);
    setAllowLate(editing?.allowLate ?? false);
    setNaming(editing?.naming ?? "original");
    setError(null);
    setTouched(false);
  }, [open, editing]);

  const deadline = hasDeadline && date ? new Date(`${date}T${time || "17:00"}`) : null;
  const titleProblem = !title.trim() ? "Give the request a title, so uploaders know what it is for." : null;
  const deadlineProblem =
    hasDeadline && !date
      ? "Pick the deadline's day, or switch the deadline off."
      : deadline && Number.isNaN(deadline.getTime())
        ? "That date is not valid."
        : deadline && !editing && deadline.getTime() < Date.now()
          ? "The deadline is in the past. Pick a later time."
          : null;

  const submit = async () => {
    setTouched(true);
    if (titleProblem || deadlineProblem) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        title,
        description,
        deadline: deadline ? deadline.toISOString() : null,
        allowLate: hasDeadline && allowLate,
        naming,
      });
    } catch (e) {
      setError(failureText(e, "The request was not saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={() => !busy && onClose()}
      title={editing ? "Edit request" : "New request"}
      dismissable={!busy}
    >
      <form
        className={s.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label="Title"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Documents for your tax return"
          error={touched && titleProblem ? titleProblem : undefined}
          autoFocus
        />
        <TextArea
          label="Description (optional)"
          value={description}
          maxLength={1000}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="What to upload, and anything they should know."
        />
        <ToggleRow
          title="Set a deadline"
          detail="Shown in your time zone, and in the uploader's own."
          checked={hasDeadline}
          onChange={setHasDeadline}
        />
        {hasDeadline ? (
          <>
            <div className={s.when}>
              <TextField label="Day" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              <TextField label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <ToggleRow
              title="Allow late uploads"
              detail="After the deadline, uploads are still taken and marked late."
              checked={allowLate}
              onChange={setAllowLate}
            />
          </>
        ) : null}
        {touched && deadlineProblem ? (
          <p className={s.help} role="alert">
            {deadlineProblem}
          </p>
        ) : null}
        <div role="radiogroup" aria-label="File names" className={s.namings}>
          <p className={s.help}>
            <b>File names</b> · applied on the uploader&rsquo;s device, so the server never sees a name.
          </p>
          {NAMING_RULES.map((n) => (
            <ChoiceCard
              key={n}
              selected={naming === n}
              onSelect={() => setNaming(n)}
              title={NAMING_LABEL[n]}
              detail={NAMING_DETAIL[n]}
              icon={<Icon name={n === "uploader" ? "users" : n === "date" ? "calendar" : "file"} />}
              tone={n === "original" ? "sakura" : n === "uploader" ? "sora" : "matcha"}
            />
          ))}
        </div>
        {error ? <Oops title="Not saved">{error} Nothing changed.</Oops> : null}
        <Button type="submit" variant="cord" size="lg" full icon={editing ? "check" : "plus"} busy={busy}>
          {editing ? "Save changes" : "Create request"}
        </Button>
      </form>
    </Sheet>
  );
}
