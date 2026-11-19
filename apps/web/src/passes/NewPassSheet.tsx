"use client";
/**
 * "New pass" (spec 5.12 step 1-2): who, what, how long. The boundary is shown
 * in plain words while it is being chosen, and the same words go into the
 * signed invite (QuickBooks' accountant invite, with the lock-date idea made
 * a read boundary; Google's per-person "choose what to share").
 */
import { useEffect, useMemo, useState } from "react";
import { Avatar, Button, ChoiceCard, Icon, Segmented, Sheet, Skeleton, TextArea, TextField } from "@mizuhiki/ui";
import { PERIOD_KINDS, boundaryText, passKeyIndex, quarterPeriod, type PeriodKind } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { api, ApiFailure } from "@/lib/api";
import { cardOf } from "@/lib/send";
import { listRooms, lookupPerson, readSummaries, withToken } from "@/rooms/engine";
import { listMyProducts } from "@/shop/engine";
import type { FormRow } from "@/forms/model";
import { createPass, scopeOf, type NewPass, type PassView } from "./engine";
import { LASTS, expiryOf, personProblem, recentQuarters, type Lasts } from "./model";
import s from "./passes.module.css";

type What = "period" | "room" | "form" | "product";
const KIND_WORDS: Record<PeriodKind, string> = {
  invoices: "Invoices",
  payments: "Payment notes",
  messages: "Messages and files",
  forms: "Form answers",
};
interface Option {
  id: string;
  label: string;
  detail: string;
}

export function NewPassSheet({
  open,
  onClose,
  onCreated,
  preset = null,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (p: PassView) => void;
  /** Opened from a room's info ("Give an accountant a pass"): that room is already picked. */
  preset?: { what: "room"; id: string } | null;
}) {
  const owner = useOwner();
  const quarters = useMemo(() => recentQuarters(), []);
  const [who, setWho] = useState("");
  const [person, setPerson] = useState<{ address: string; name: string | null } | null>(null);
  const [whoError, setWhoError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [what, setWhat] = useState<What>("period");
  const [quarter, setQuarter] = useState<string>(quarters[1]?.label ?? quarters[0]?.label ?? "");
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [kinds, setKinds] = useState<PeriodKind[]>(["invoices", "payments"]);
  const [lasts, setLasts] = useState<Lasts>("90d");
  const [note, setNote] = useState("");
  const [options, setOptions] = useState<Record<Exclude<What, "period">, Option[] | null>>({
    room: null,
    form: null,
    product: null,
  });
  const [picked, setPicked] = useState<Option | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setWho("");
    setPerson(null);
    setWhoError(null);
    setWhat(preset?.what ?? "period");
    setPicked(null);
    setNote("");
    setError(null);
  }, [open, preset?.what]);

  // The preset room is picked once the owner's rooms have loaded.
  useEffect(() => {
    if (!open || !preset || picked) return;
    const found = options[preset.what]?.find((o) => o.id === preset.id);
    if (found) setPicked(found);
  }, [open, preset, options, picked]);

  // What the owner can share: rooms they run, published forms, published products.
  useEffect(() => {
    if (!open || what === "period" || options[what] !== null) return;
    const life = { alive: true };
    void (async () => {
      const token = await owner.token();
      let list: Option[] = [];
      try {
        if (what === "room") {
          const [{ rooms }, sums] = await Promise.all([
            listRooms(withToken(owner.account, token)),
            readSummaries(owner.account),
          ]);
          list = rooms
            .filter((r) => r.status === "active" && (r.role === "owner" || r.role === "admin"))
            .map((r) => ({
              id: r.id,
              label: sums[r.id]?.name || "Unnamed room",
              detail: `${r.members} ${r.members === 1 ? "member" : "members"}`,
            }));
        } else if (what === "form") {
          const { forms } = await api.get<{ forms: FormRow[] }>("/owner/forms", { token });
          list = forms
            .filter((f) => f.published && !f.archived)
            .map((f) => ({
              id: f.id,
              label: f.published?.title ?? f.slug,
              detail: `${f.responses} ${f.responses === 1 ? "answer" : "answers"}`,
            }));
        } else {
          const products = await listMyProducts({ ...owner.account, token });
          list = products
            .filter((p) => p.status === "published" && p.record?.body.content)
            .map((p) => ({
              id: p.id,
              label: p.record?.body.title ?? p.slug,
              detail: `${p.sales} ${p.sales === 1 ? "sale" : "sales"}`,
            }));
        }
      } catch {
        list = [];
      }
      if (life.alive) setOptions((o) => ({ ...o, [what]: list }));
    })();
    return () => {
      life.alive = false;
    };
  }, [open, what, options, owner]);

  const period = useMemo(() => {
    if (custom) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return null;
      const f = new Date(`${from}T00:00:00.000Z`);
      const u = new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000);
      return u > f ? { from: f.toISOString(), until: u.toISOString() } : null;
    }
    const q = quarters.find((x) => x.label === quarter);
    return q ? quarterPeriod(q.year, q.q) : null;
  }, [custom, from, to, quarter, quarters]);

  const scope: NewPass["scope"] | null =
    what === "period"
      ? period && kinds.length > 0
        ? { kind: "period", ...period, kinds: PERIOD_KINDS.filter((k) => kinds.includes(k)) }
        : null
      : picked
        ? what === "room"
          ? { kind: "room", roomId: picked.id, label: picked.label.slice(0, 80) }
          : what === "form"
            ? { kind: "form", formId: picked.id, label: picked.label.slice(0, 120) }
            : { kind: "product", productId: picked.id, label: picked.label.slice(0, 120) }
        : null;
  const expiresAt = scope ? expiryOf(lasts, scope) : null;
  const preview = scope ? boundaryText(scopeOf(scope, passKeyIndex(0)), expiresAt) : null;

  const checkPerson = async (): Promise<{ address: string; name: string | null } | null> => {
    const problem = personProblem(who);
    if (problem) {
      setWhoError(problem);
      return null;
    }
    setChecking(true);
    try {
      const found = await lookupPerson(who);
      if (!found) {
        setWhoError("No Mizuhiki account has that name. Check the spelling, or use their qor1… address.");
        return null;
      }
      if (found.address === owner.account.owner.address) {
        setWhoError("A pass is for someone else.");
        return null;
      }
      await cardOf(found.address);
      setPerson(found);
      setWhoError(null);
      return found;
    } catch (e) {
      setWhoError(e instanceof Error ? e.message : "That account could not be checked. Try again.");
      return null;
    } finally {
      setChecking(false);
    }
  };

  const send = async () => {
    setError(null);
    const p = person ?? (await checkPerson());
    if (!p || !scope) {
      if (!scope) setError(what === "period" ? "Pick a period and at least one kind of item." : `Pick a ${what}.`);
      return;
    }
    setBusy(true);
    try {
      onCreated(
        await createPass(
          { ...owner.account, token: await owner.token() },
          { holder: p.address, scope, expiresAt, note },
        ),
      );
    } catch (e) {
      setError(
        e instanceof ApiFailure || e instanceof Error ? e.message : "The pass was not made. Nothing was shared.",
      );
    } finally {
      setBusy(false);
    }
  };

  const list = what === "period" ? [] : options[what];
  return (
    <Sheet open={open} onClose={onClose} title="New pass" wide dismissable={!busy}>
      <div className={s.form}>
        <fieldset className={s.fieldset}>
          <legend className={s.legend}>Who</legend>
          <TextField
            label="Their @name or address"
            placeholder="@mila.cpa"
            value={who}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setWho(e.target.value);
              setPerson(null);
              setWhoError(null);
            }}
            onBlur={() => {
              if (who.trim() && !person) void checkPerson();
            }}
            error={whoError ?? undefined}
            hint="They need a Mizuhiki account, so the pass can be sealed to their key."
          />
          {checking ? <Skeleton lines={1} /> : null}
          {person ? (
            <p className={s.person}>
              <Avatar name={person.name ?? person.address.slice(4, 6)} size={32} tone="matcha" />
              <span>
                <b>{person.name ? `@${person.name}` : `${person.address.slice(0, 12)}…`}</b> has a Mizuhiki key on
                QoreChain.
              </span>
              <Icon name="check" size={16} />
            </p>
          ) : null}
        </fieldset>

        <fieldset className={s.fieldset}>
          <legend className={s.legend}>What they can read</legend>
          <Segmented
            label="What the pass covers"
            value={what}
            onChange={(v) => {
              setWhat(v);
              setPicked(null);
            }}
            options={[
              { value: "period", label: "A period" },
              { value: "room", label: "A room" },
              { value: "form", label: "A form" },
              { value: "product", label: "A product" },
            ]}
          />
          {what === "period" ? (
            <>
              <div className={s.chips} role="radiogroup" aria-label="Period">
                {quarters.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    role="radio"
                    aria-checked={!custom && quarter === q.label}
                    className={s.pick}
                    onClick={() => {
                      setCustom(false);
                      setQuarter(q.label);
                    }}
                  >
                    {q.label}
                  </button>
                ))}
                <button
                  type="button"
                  role="radio"
                  aria-checked={custom}
                  className={s.pick}
                  onClick={() => setCustom(true)}
                >
                  <Icon name="calendar" size={14} /> Custom dates
                </button>
              </div>
              {custom ? (
                <div className={s.grid2}>
                  <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                  <TextField
                    label="To (included)"
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    error={from && to && !period ? "The end must be on or after the start." : undefined}
                  />
                </div>
              ) : null}
              <div className={s.chips} role="group" aria-label="Kinds of items">
                {PERIOD_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kinds.includes(k)}
                    className={s.pick}
                    onClick={() => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))}
                  >
                    {kinds.includes(k) ? <Icon name="check" size={14} /> : null}
                    {KIND_WORDS[k]}
                  </button>
                ))}
              </div>
              <p className={s.hint}>
                Items dated in the period are covered, including ones from before today. New ones arrive sealed to the
                pass.
              </p>
            </>
          ) : list === null ? (
            <Skeleton lines={2} />
          ) : list.length === 0 ? (
            <p className={s.hint}>
              {what === "room"
                ? "You do not run any rooms yet."
                : what === "form"
                  ? "You have no published forms yet."
                  : "You have no published products with content yet."}
            </p>
          ) : (
            <div className={s.form} role="radiogroup" aria-label={`Pick a ${what}`}>
              {list.map((o) => (
                <ChoiceCard
                  key={o.id}
                  selected={picked?.id === o.id}
                  onSelect={() => setPicked(o)}
                  title={o.label}
                  detail={o.detail}
                  tone="matcha"
                />
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className={s.fieldset}>
          <legend className={s.legend}>How long</legend>
          <div className={s.chips} role="radiogroup" aria-label="How long the pass lasts">
            {LASTS.filter((l) => l.value !== "period" || what === "period").map((l) => (
              <button
                key={l.value}
                type="button"
                role="radio"
                aria-checked={lasts === l.value}
                className={s.pick}
                onClick={() => setLasts(l.value)}
              >
                {l.label}
              </button>
            ))}
          </div>
        </fieldset>

        <TextArea
          label="Note for them (optional)"
          value={note}
          maxLength={500}
          counter
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Hi Mila, here is Q3 for the VAT return."
        />

        <section className={s.boundary} aria-live="polite">
          <h3>
            <Icon name="lock" size={14} /> What the invite will say
          </h3>
          <p>{preview ?? "Choose who and what, and the boundary appears here."}</p>
        </section>

        {error ? (
          <p className={s.err} role="alert">
            {error}
          </p>
        ) : null}
        <div className={s.actions}>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="cord" icon="send" busy={busy} disabled={checking} onClick={() => void send()}>
            {busy ? "Signing the invite" : "Send invite"}
          </Button>
        </div>
        <p className={s.hint}>
          Nothing is shared yet. After they accept, you compare six safety words, and only then is anything sealed to
          them.
        </p>
      </div>
    </Sheet>
  );
}
