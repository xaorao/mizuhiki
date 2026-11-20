"use client";
/**
 * The claim box (spec 5.1 sections 2 and 3, Linktree's homepage claim): the
 * name is checked as it is typed, locally first (the registry's own rule),
 * then against QoreChain through the API. Taken names come with three
 * suggestions; the typed name pre-fills sign-up.
 */
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { nameProblem, normalizeNameInput } from "@mizuhiki/core";
import { Icon } from "@mizuhiki/ui";
import { api, ApiFailure } from "@/lib/api";
import { SITE_HOST } from "@/lib/site";
import s from "./landing.module.css";

interface Availability {
  name: string;
  available: boolean;
  message: string;
  suggestions?: string[];
}

type Check =
  { kind: "idle" } | { kind: "checking" } | { kind: "result"; r: Availability } | { kind: "error"; message: string };

export function ClaimBox({ initial = "", tone = "hero" }: { initial?: string; tone?: "hero" | "cta" }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState(initial);
  const [touched, setTouched] = useState(false);
  const [check, setCheck] = useState<Check>({ kind: "idle" });
  const local = value ? nameProblem(value) : undefined;
  // A string, so the check below runs when the name changes, not on every render.
  const localProblem = local?.problem;

  useEffect(() => {
    if (!value || localProblem) {
      setCheck({ kind: "idle" });
      return;
    }
    const ctl = new AbortController();
    setCheck({ kind: "checking" });
    const t = setTimeout(() => {
      api
        .get<Availability>(`/names/${encodeURIComponent(value)}`, { signal: ctl.signal })
        .then((r) => setCheck({ kind: "result", r }))
        .catch((e: unknown) => {
          if (ctl.signal.aborted) return;
          setCheck({
            kind: "error",
            message:
              e instanceof ApiFailure ? e.message : "Could not check that name right now. You can still continue.",
          });
        });
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [value, localProblem]);

  const free = !local && check.kind === "result" && check.r.available && check.r.name === value;
  const taken = !local && check.kind === "result" && !check.r.available ? check.r : null;
  const showLocal = local && (touched || value.length >= 3);

  const go = (name: string) => router.push(`/signup?name=${encodeURIComponent(name)}`);

  let status: { tone: "ok" | "bad" | "info"; text: string } | null = null;
  if (showLocal) status = { tone: "bad", text: local.message };
  else if (check.kind === "checking") status = { tone: "info", text: "Checking QoreChain…" };
  else if (free) status = { tone: "ok", text: "It's available!" };
  else if (taken) status = { tone: "bad", text: taken.message || "That's taken." };
  else if (check.kind === "error") status = { tone: "info", text: check.message };

  return (
    <div className={[s.claimWrap, tone === "cta" ? s.claimCta : ""].join(" ")}>
      <form
        className={s.claim}
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (!value) return go("");
          if (local || taken) return;
          go(value);
        }}
        noValidate
      >
        <label className={s.claimField} htmlFor={`${id}-name`}>
          <span className={s.claimHost}>{SITE_HOST}/@</span>
          <input
            id={`${id}-name`}
            value={value}
            onChange={(e) => setValue(normalizeNameInput(e.target.value))}
            onBlur={() => setTouched(true)}
            placeholder="yourname"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={30}
            aria-label="Your page name"
            aria-invalid={status?.tone === "bad" ? true : undefined}
            aria-describedby={`${id}-status`}
          />
          {free ? <Icon name="check" size={20} className={s.claimTick} /> : null}
        </label>
        <button className={s.claimBtn} type="submit">
          Claim your page
        </button>
      </form>
      <div id={`${id}-status`} className={s.claimStatus} role="status" aria-live="polite">
        {status ? <span className={s[`st_${status.tone}`]}>{status.text}</span> : null}
        {taken?.suggestions?.length ? (
          <span className={s.claimSuggest}>
            Try{" "}
            {taken.suggestions.slice(0, 3).map((n) => (
              <button key={n} type="button" onClick={() => setValue(n)}>
                @{n}
              </button>
            ))}
          </span>
        ) : null}
      </div>
    </div>
  );
}
