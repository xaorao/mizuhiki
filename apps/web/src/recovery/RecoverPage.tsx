"use client";
/**
 * Recover with contacts, on a new device (spec 5.13; QoreX's 48-hour wait,
 * 1Password's two-sided recovery). The one-time key stays in this browser;
 * contacts compare its words with the owner by voice before answering; after
 * the wait the pieces are released here, rebuilt into the phrase, checked
 * against the account, and stored under a new device passphrase.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon, Kicker, LockLine, Musubi, Oops, Skeleton, StatusChip, TextField, Wordmark } from "@mizuhiki/ui";
import { passphraseProblem } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { ApiFailure } from "@/lib/api";
import { personProblem } from "@/passes/model";
import {
  finishRecovery,
  forgetRecovery,
  markDone,
  pendingRecovery,
  pendingWords,
  pollRecovery,
  startRecovery,
  type Pending,
  type PublicRequest,
} from "./engine";
import p from "@/passes/passes.module.css";
import s from "./recovery.module.css";
import { failureText } from "@/lib/failure";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
function left(iso: string, now: number): string {
  const ms = Math.max(0, Date.parse(iso) - now);
  const h = Math.floor(ms / 3600_000);
  const m = Math.floor((ms % 3600_000) / 60_000);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

export function RecoverPage() {
  const [pending, setPending] = useState<Pending | null | undefined>(undefined);
  useEffect(() => {
    void pendingRecovery().then(setPending);
  }, []);
  return (
    <div className={s.shell}>
      <main className={s.card}>
        <Wordmark size={20} href="/" />
        {pending === undefined ? (
          <Skeleton lines={4} />
        ) : pending ? (
          <Waiting p={pending} onReset={() => setPending(null)} />
        ) : (
          <Start onStarted={setPending} />
        )}
      </main>
    </div>
  );
}

function Start({ onStarted }: { onStarted: (p: Pending) => void }) {
  const [who, setWho] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={p.form}
      onSubmit={(e) => {
        e.preventDefault();
        const problem = personProblem(who);
        if (problem) return setErr(problem);
        setBusy(true);
        setErr(null);
        startRecovery(who)
          .then(onStarted)
          .catch((x: unknown) =>
            setErr(x instanceof ApiFailure || x instanceof Error ? x.message : "The recovery did not start."),
          )
          .finally(() => setBusy(false));
      }}
    >
      <Musubi face="worried" size={96} />
      <Kicker>ふっかつ</Kicker>
      <h1>Recover with your contacts</h1>
      <p>
        Lost your 24 words? If you chose recovery contacts, enough of them can bring your account back to this device.
        It takes 48 hours after they answer, so a stranger cannot do it quietly.
      </p>
      <TextField
        label="Your @name or address"
        placeholder="@yourname"
        value={who}
        autoComplete="username"
        spellCheck={false}
        onChange={(e) => setWho(e.target.value)}
        error={err ?? undefined}
      />
      <Button type="submit" variant="cord" size="lg" full busy={busy}>
        Start recovery
      </Button>
      <LockLine>
        A one-time key is made in this browser. Your contacts&rsquo; pieces are sealed to it; no one else can open them.
      </LockLine>
      <p className={p.hint}>
        Have your sheet? <a href="/login">Use your recovery phrase</a> instead. It works right away.
      </p>
    </form>
  );
}

function Waiting({ p: pend, onReset }: { p: Pending; onReset: () => void }) {
  const acct = useAccount();
  const router = useRouter();
  const [r, setR] = useState<PublicRequest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const words = pendingWords(pend);

  const poll = useCallback(async () => {
    try {
      setR(await pollRecovery(pend));
      setErr(null);
    } catch (e) {
      setErr(failureText(e, "The request could not be checked. Trying again."));
    }
  }, [pend]);
  useEffect(() => {
    void poll();
    const h = setInterval(() => {
      setNow(Date.now());
      void poll();
    }, 10_000);
    return () => clearInterval(h);
  }, [poll]);

  const problem = pass ? passphraseProblem(pass) : undefined;
  const finish = async () => {
    if (!r) return;
    setBusy(true);
    setErr(null);
    try {
      const phrase = await finishRecovery(pend, r);
      await acct.importPhrase(phrase, pass);
      await markDone(pend);
      router.push("/app/spare-key");
    } catch (e) {
      setErr(failureText(e, "Your account was not restored. Nothing changed."));
    } finally {
      setBusy(false);
    }
  };
  const restart = async () => {
    await forgetRecovery();
    onReset();
  };

  const name = r?.name ? `@${r.name}` : `@${pend.who}`;
  if (!r) return err ? <Oops title="Not checked">{err}</Oops> : <Skeleton lines={4} />;
  return (
    <div className={p.form} aria-live="polite">
      <Kicker>ふっかつ</Kicker>
      <h1>Recovering {name}</h1>
      {r.status === "open" ? (
        <>
          <p>
            Call your recovery contacts on numbers you know. Ask them to open Mizuhiki › Spare key › People you help,
            choose <b>Help {name}</b>, and check these words with you:
          </p>
          <ul className={p.words} aria-label="Words for your contacts">
            {words.split(" ").map((w, i) => (
              <li key={`${w}${i}`}>{w}</li>
            ))}
          </ul>
          <p className={s.count}>
            {r.answered.length} of {r.threshold} contacts answered
          </p>
          <StatusChip status="wait">Waiting for contacts</StatusChip>
        </>
      ) : r.status === "waiting" && r.releaseAt ? (
        <>
          <p className={s.count}>
            <Icon name="clock" size={20} /> {left(r.releaseAt, now)} to go
          </p>
          <p>
            Enough contacts answered. Your pieces are released to this browser on {when(r.releaseAt)}. If this was not
            you, the account owner can cancel it from any signed-in device until then.
          </p>
          <StatusChip status="wait">Waiting 48 hours</StatusChip>
          <p className={p.hint}>
            Keep this browser. The one-time key lives only here; closing the tab is fine, clearing site data is not.
          </p>
        </>
      ) : r.status === "ready" ? (
        <form
          className={p.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (!problem && pass) void finish();
          }}
        >
          <StatusChip status="ok">Ready</StatusChip>
          <p>
            Your contacts&rsquo; pieces are here. Set a passphrase for this device; your phrase is rebuilt and checked
            against {name} on this device.
          </p>
          <TextField
            label="New passphrase for this device"
            type="password"
            autoComplete="new-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={problem}
            hint="At least 10 characters."
          />
          {acct.vault && acct.vault.address !== pend.owner ? (
            <p className={p.hint}>
              This browser holds another account&rsquo;s key. Restoring replaces it here; that account still opens
              anywhere with its own 24 words.
            </p>
          ) : null}
          {err ? <Oops title="Not restored">{err}</Oops> : null}
          <Button type="submit" variant="cord" size="lg" full busy={busy} disabled={!pass || !!problem}>
            Restore my account here
          </Button>
          <LockLine>Rebuilt in this browser. Then save a new spare-key sheet.</LockLine>
        </form>
      ) : (
        <>
          <Oops
            title={
              r.status === "cancelled"
                ? "This recovery was cancelled"
                : r.status === "done"
                  ? "Already finished"
                  : "This recovery expired"
            }
          >
            {r.status === "cancelled"
              ? "The account owner cancelled it from a signed-in device, or changed their recovery contacts. Nothing was released."
              : r.status === "done"
                ? "This account was already restored with this request."
                : "Requests close after 7 days. Start a new one."}
          </Oops>
          <Button variant="line" icon="undo" onClick={() => void restart()}>
            Start again
          </Button>
        </>
      )}
      {r.status === "open" || r.status === "waiting" ? (
        <button type="button" className={s.backLink} onClick={() => void restart()}>
          <Icon name="x" size={14} /> Forget this request on this browser
        </button>
      ) : null}
    </div>
  );
}
