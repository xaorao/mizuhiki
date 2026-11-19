"use client";
/**
 * Log in (spec 5.2 "Returning"): there is no email login. On a device that holds
 * the key: unlock with the passphrase or a passkey. On a new device: type the 24
 * words, set a passphrase for this device. A second tab shows "Open elsewhere".
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Icon, Kicker, LockLine, Musubi, Oops, TextField, Wordmark } from "@mizuhiki/ui";
import { isPhraseWord, isValidPhrase, normalizePhrase, passphraseProblem } from "@mizuhiki/core";
import { useAccount } from "./AccountProvider";
import s from "./login.module.css";

export function Login({ next }: { next: string }) {
  const acct = useAccount();
  const router = useRouter();
  const [mode, setMode] = useState<"unlock" | "restore">("unlock");
  useEffect(() => {
    if (acct.status === "unlocked") router.replace(next);
  }, [acct.status, next, router]);
  useEffect(() => {
    if (acct.status === "none") setMode("restore");
  }, [acct.status]);

  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <Wordmark size={20} href="/" />
        <a className={s.link} href={next === "/app" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`}>
          Sign up free
        </a>
      </header>
      <main className={s.card}>
        {acct.status === "loading" ? (
          <p className={s.sub}>Opening…</p>
        ) : acct.status === "elsewhere" ? (
          <Elsewhere onTakeOver={acct.takeOver} />
        ) : mode === "unlock" && acct.vault ? (
          <Unlock onRestore={() => setMode("restore")} />
        ) : (
          <Restore canGoBack={!!acct.vault} onBack={() => setMode("unlock")} />
        )}
      </main>
    </div>
  );
}

function Elsewhere({ onTakeOver }: { onTakeOver: () => void }) {
  return (
    <div className={s.stack}>
      <Musubi face="sleepy" size={110} />
      <Kicker>べつのタブ</Kicker>
      <h1 className={s.title}>Open elsewhere</h1>
      <p className={s.sub}>
        Mizuhiki is open in another tab of this browser. Your key is only unlocked in one tab at a time.
      </p>
      <Button variant="cord" size="lg" full onClick={onTakeOver}>
        Use it here instead
      </Button>
      <p className={s.fine}>The other tab locks itself. Nothing is lost.</p>
    </div>
  );
}

function Unlock({ onRestore }: { onRestore: () => void }) {
  const acct = useAccount();
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState<"pass" | "key" | null>(null);
  const hasPasskey = acct.vault?.wraps.some((w) => w.kind === "passkey") ?? false;
  return (
    <form
      className={s.stack}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy("pass");
        setErr(undefined);
        acct
          .unlock(pass)
          .catch((x: unknown) => setErr((x as Error).message))
          .finally(() => setBusy(null));
      }}
    >
      <Musubi face={err ? "worried" : "normal"} size={110} />
      <Kicker>おかえり</Kicker>
      <h1 className={s.title}>Welcome back</h1>
      <p className={s.sub}>Unlock Mizuhiki on this device. Your key stays here.</p>
      <TextField
        label="Device passphrase"
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        error={err}
        autoFocus
        autoComplete="current-password"
      />
      <Button type="submit" variant="cord" size="lg" full busy={busy === "pass"} disabled={!pass}>
        Unlock
      </Button>
      {hasPasskey ? (
        <Button
          variant="line"
          size="lg"
          full
          icon="key"
          busy={busy === "key"}
          onClick={() => {
            setBusy("key");
            setErr(undefined);
            acct
              .unlockWithPasskey()
              .catch((x: unknown) => setErr((x as Error).message))
              .finally(() => setBusy(null));
          }}
        >
          Unlock with passkey
        </Button>
      ) : null}
      <button type="button" className={s.textBtn} onClick={onRestore}>
        Forgot your passphrase? Use your 24 words
      </button>
    </form>
  );
}

function Restore({ canGoBack, onBack }: { canGoBack: boolean; onBack: () => void }) {
  const acct = useAccount();
  const [text, setText] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const words = normalizePhrase(text) ? normalizePhrase(text).split(" ") : [];
  const unknown = words.filter((w) => !isPhraseWord(w));
  const valid = isValidPhrase(text);
  const problem = pass ? passphraseProblem(pass) : undefined;
  const phraseError =
    unknown.length > 0
      ? `Not a recovery word: ${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? "…" : ""}`
      : words.length > 0 && words.length !== 24 && words.length !== 12
        ? `${words.length} words so far. Your phrase has 24.`
        : words.length >= 12 && !valid
          ? "These words are all real, but not in a valid order. Check each one against your sheet."
          : undefined;
  return (
    <form
      className={s.stack}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || problem || !pass) return;
        setBusy(true);
        setErr(undefined);
        acct
          .importPhrase(text, pass)
          .catch((x: unknown) => setErr((x as Error).message))
          .finally(() => setBusy(false));
      }}
    >
      <Musubi face={err ? "worried" : "wink"} size={100} />
      <Kicker>ふっかつ</Kicker>
      <h1 className={s.title}>Use your recovery phrase</h1>
      <p className={s.sub}>Type your 24 words in order. They are checked on this device and never sent anywhere.</p>
      <label className={s.label} htmlFor="phrase">
        Recovery phrase
      </label>
      <textarea
        id="phrase"
        className={s.phrase}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        rows={4}
        aria-invalid={phraseError ? true : undefined}
        aria-describedby="phrase-msg"
        placeholder="word word word …"
      />
      <p id="phrase-msg" className={phraseError ? s.bad : valid ? s.good : s.fine} aria-live="polite">
        {phraseError ??
          (valid ? (
            <>
              <Icon name="check" size={14} /> Valid phrase
            </>
          ) : (
            "Separate words with spaces."
          ))}
      </p>
      <TextField
        label="New passphrase for this device"
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        error={problem}
        autoComplete="new-password"
        hint="At least 10 characters."
      />
      <LockLine>If you lost your phrase and have no spare key, your sealed items cannot be recovered.</LockLine>
      {err ? <Oops title="Not restored">{err} Nothing left your device.</Oops> : null}
      <Button type="submit" variant="cord" size="lg" full busy={busy} disabled={!valid || !pass || !!problem}>
        Restore on this device
      </Button>
      {canGoBack ? (
        <button type="button" className={s.textBtn} onClick={onBack}>
          Back to unlock
        </button>
      ) : null}
    </form>
  );
}
