"use client";
/**
 * Who a purchase is sealed to (spec 5.11 checkout, decision 2): the buyer's
 * Mizuhiki account (unlocked in place), a buyer key made here from 12 words
 * (shown once, retyped, saved as a PDF, kept on this device) or restored from
 * its words, or another wallet as a gift. The address or key fingerprint is
 * always shown with the plain promise that only it can open the purchase.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, ButtonLink, ChoiceCard, CopyValue, Icon, LockLine, Oops, TextField, useToast } from "@mizuhiki/ui";
import {
  cardHash,
  isPhraseWord,
  isValidPhrase,
  normalizePhrase,
  type OrderRequest,
  type RecipientCard,
} from "@mizuhiki/core";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { useAccount } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { SITE_HOST } from "@/lib/site";
import { downloadBytes } from "@/lib/download";
import {
  buyerKeyFrom,
  buyerKeys,
  cardOf,
  forgetBuyerKey,
  newBuyerKey,
  rememberBuyerKey,
  type BuyerKey,
} from "../engine";
import { buildBuyerKeySheet } from "@/lib/pdfs";
import { fingerprint } from "./model";
import s from "./buyer.module.css";
import { ownerOfName } from "@mizuhiki/chain";
import { failureText } from "@/lib/failure";

export interface SealChoice {
  recipient: OrderRequest["recipient"];
  gift: boolean;
  reviewKeys: SealKeyPair | null;
  /** What the buyer reads: "your account qor1…", "buyer key 1a2b …", "@mila (gift)". */
  summary: string;
}

type Mode = "account" | "key" | "gift";

export function SealTo({
  shop,
  next,
  onChange,
}: {
  shop: string;
  next: string;
  onChange: (c: SealChoice | null) => void;
}) {
  const acct = useAccount();
  const [mode, setMode] = useState<Mode | null>(null);
  const [keys, setKeys] = useState<BuyerKey[] | null>(null);
  const [keyPick, setKeyPick] = useState<string | null>(null);
  const [gift, setGift] = useState<{ address: string; name: string | null; card: RecipientCard } | null>(null);

  useEffect(() => {
    void buyerKeys().then(setKeys, () => setKeys([]));
  }, []);
  // Default: the account when this device has one, otherwise a buyer key.
  useEffect(() => {
    if (mode || acct.status === "loading" || keys === null) return;
    setMode(acct.status === "none" ? "key" : "account");
    if (keys[0]) setKeyPick(keys[0].hash);
  }, [mode, acct.status, keys]);

  const picked = keys?.find((k) => k.hash === keyPick) ?? null;
  const choice = useMemo<SealChoice | null>(() => {
    if (mode === "account" && acct.status === "unlocked" && acct.account)
      return {
        recipient: { kind: "account", address: acct.account.owner.address },
        gift: false,
        reviewKeys: acct.account.keys.seal,
        summary: `your account ${acct.account.owner.address}`,
      };
    if (mode === "key" && picked)
      return {
        recipient: picked.recipient,
        gift: false,
        reviewKeys: picked.keys,
        summary: `buyer key ${fingerprint(picked.hash, 16)}`,
      };
    if (mode === "gift" && gift)
      return {
        recipient: { kind: "account", address: gift.address },
        gift: true,
        reviewKeys: null,
        summary: `${gift.name ? `@${gift.name}` : gift.address} (a gift)`,
      };
    return null;
  }, [mode, acct.status, acct.account, picked, gift]);
  useEffect(() => onChange(choice), [choice, onChange]);

  return (
    <div className={s.sealTo}>
      <div role="radiogroup" aria-label="Seal it to" className={s.stack}>
        <ChoiceCard
          selected={mode === "account"}
          onSelect={() => setMode("account")}
          title="My Mizuhiki account"
          detail={
            acct.status === "unlocked"
              ? "Opens wherever you use Mizuhiki."
              : acct.status === "locked"
                ? "Unlock it here; your key stays on this device."
                : "Log in or make one; you come back here."
          }
          icon={<Icon name="key" />}
          tone="sakura"
        />
        <ChoiceCard
          selected={mode === "key"}
          onSelect={() => setMode("key")}
          title="I don't have Mizuhiki"
          detail="Make a buyer key here: 12 words that open what you buy. Free, nothing to sign up for."
          icon={<Icon name="lock" />}
          tone="matcha"
        />
        <ChoiceCard
          selected={mode === "gift"}
          onSelect={() => setMode("gift")}
          title="Send as a gift"
          detail="A gift: you pay, and it is sealed to their Mizuhiki account."
          icon={<Icon name="heart" />}
          tone="fuji"
        />
      </div>

      {mode === "account" ? <AccountChoice next={next} /> : null}
      {mode === "key" ? (
        <KeyChoice
          shop={shop}
          keys={keys ?? []}
          picked={keyPick}
          onPick={setKeyPick}
          onAdded={(k) => {
            setKeys((all) => [...(all ?? []).filter((x) => x.hash !== k.hash), k]);
            setKeyPick(k.hash);
          }}
          onForget={(h) => {
            void forgetBuyerKey(h).then(() => {
              setKeys((all) => (all ?? []).filter((x) => x.hash !== h));
              if (keyPick === h) setKeyPick(null);
            });
          }}
        />
      ) : null}
      {mode === "gift" ? <GiftChoice value={gift} onChange={setGift} /> : null}

      {choice ? (
        <div className={s.sealedTo} aria-live="polite">
          <span className={s.sealedHead}>
            <Icon name="lock" size={16} /> Sealed to
          </span>
          {choice.recipient.kind === "account" ? (
            <CopyValue value={choice.recipient.address} label="the address it is sealed to" short />
          ) : (
            <code className={s.fp}>{fingerprint(picked?.hash ?? "", 32)}</code>
          )}
          <b>
            {choice.recipient.kind === "account"
              ? "This is the only account that can open it."
              : "This is the only key that can open it."}
          </b>
          {choice.gift ? <small>You pay; they open it. You will not be able to open it yourself.</small> : null}
        </div>
      ) : null}
    </div>
  );
}

function AccountChoice({ next }: { next: string }) {
  const acct = useAccount();
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState<"pass" | "key" | null>(null);
  const hasPasskey = acct.vault?.wraps.some((w) => w.kind === "passkey") ?? false;
  if (acct.status === "unlocked") return null;
  if (acct.status === "elsewhere")
    return (
      <div className={s.subPanel}>
        <p className={s.fine}>Mizuhiki is open in another tab. Your key is unlocked in one tab at a time.</p>
        <Button variant="line" onClick={acct.takeOver}>
          Use it here instead
        </Button>
      </div>
    );
  if (acct.status === "none" || acct.status === "loading")
    return (
      <div className={s.subPanel}>
        <p className={s.fine}>Your cart stays here while you log in or make an account.</p>
        <div className={s.rowWrap}>
          <ButtonLink variant="line" icon="key" href={`/login?next=${encodeURIComponent(next)}`}>
            Log in
          </ButtonLink>
          <ButtonLink variant="ghost" href={`/signup?next=${encodeURIComponent(next)}`}>
            Make an account
          </ButtonLink>
        </div>
      </div>
    );
  return (
    <form
      className={s.subPanel}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy("pass");
        setErr(undefined);
        acct
          .unlock(pass)
          .then(() => setPass(""))
          .catch((x: unknown) => setErr((x as Error).message))
          .finally(() => setBusy(null));
      }}
    >
      <TextField
        label="Device passphrase"
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        error={err}
        autoComplete="current-password"
      />
      <div className={s.rowWrap}>
        <Button type="submit" variant="line" icon="key" busy={busy === "pass"} disabled={!pass}>
          Unlock
        </Button>
        {hasPasskey ? (
          <Button
            variant="ghost"
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
            Use my passkey
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function KeyChoice({
  shop,
  keys,
  picked,
  onPick,
  onAdded,
  onForget,
}: {
  shop: string;
  keys: BuyerKey[];
  picked: string | null;
  onPick: (h: string) => void;
  onAdded: (k: BuyerKey) => void;
  onForget: (h: string) => void;
}) {
  const [flow, setFlow] = useState<"list" | "new" | "restore">(keys.length ? "list" : "new");
  useEffect(() => {
    if (flow === "list" && keys.length === 0) setFlow("new");
  }, [flow, keys.length]);
  return (
    <div className={s.subPanel}>
      {flow === "list" ? (
        <>
          <p className={s.subHead}>Buyer keys on this device</p>
          <div role="radiogroup" aria-label="Buyer key" className={s.keyList}>
            {keys.map((k) => (
              <div key={k.hash} className={[s.keyRow, picked === k.hash ? s.keyRowOn : ""].join(" ")}>
                <button type="button" role="radio" aria-checked={picked === k.hash} onClick={() => onPick(k.hash)}>
                  <Icon name={picked === k.hash ? "check" : "key"} size={16} />
                  <code>{fingerprint(k.hash, 16)}</code>
                </button>
                <button type="button" className={s.linkBtn} onClick={() => onForget(k.hash)}>
                  Forget here
                </button>
              </div>
            ))}
          </div>
          <div className={s.rowWrap}>
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setFlow("new")}>
              Make another
            </Button>
            <Button size="sm" variant="ghost" icon="key" onClick={() => setFlow("restore")}>
              Use my 12 words
            </Button>
          </div>
        </>
      ) : flow === "new" ? (
        <NewKey shop={shop} onDone={(k) => (onAdded(k), setFlow("list"))} onRestore={() => setFlow("restore")} />
      ) : (
        <RestoreKey
          onDone={(k) => (onAdded(k), setFlow("list"))}
          onBack={() => setFlow(keys.length ? "list" : "new")}
        />
      )}
    </div>
  );
}

/** Three positions to retype, different each time. */
function pickPositions(): number[] {
  const out = new Set<number>();
  const r = crypto.getRandomValues(new Uint32Array(12));
  for (const x of r) {
    out.add(x % 12);
    if (out.size === 3) break;
  }
  for (let i = 0; out.size < 3; i++) out.add(i);
  return [...out].sort((a, b) => a - b);
}

function NewKey({ shop, onDone, onRestore }: { shop: string; onDone: (k: BuyerKey) => void; onRestore: () => void }) {
  const toast = useToast();
  const [key] = useState(() => newBuyerKey());
  const [stage, setStage] = useState<"show" | "check">("show");
  const [positions] = useState(pickPositions);
  const [typed, setTyped] = useState<string[]>(["", "", ""]);
  const [busy, setBusy] = useState<"pdf" | "keep" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const words = key.phrase.split(" ");
  const allRight = positions.every((p, i) => normalizePhrase(typed[i] ?? "") === words[p]);
  if (stage === "show")
    return (
      <>
        <p className={s.subHead}>Your buyer key</p>
        <p className={s.fine}>
          These 12 words open what you buy. Write them down or save the PDF. They are shown once and never sent
          anywhere.
        </p>
        <ol className={s.words} aria-label="Your 12 words">
          {words.map((w, i) => (
            <li key={i}>
              <span>{i + 1}</span>
              <b>{w}</b>
            </li>
          ))}
        </ol>
        <div className={s.rowWrap}>
          <Button
            variant="line"
            icon="download"
            busy={busy === "pdf"}
            onClick={() => {
              setBusy("pdf");
              void buildBuyerKeySheet({
                phrase: key.phrase,
                fingerprint: fingerprint(key.hash, 32),
                shop,
                site: SITE_HOST,
                createdAt: new Date(),
              })
                .then((b) => downloadBytes(b, "mizuhiki-buyer-key.pdf"))
                .catch(() =>
                  toast.show("The PDF could not be made here. Write the words down instead.", { tone: "error" }),
                )
                .finally(() => setBusy(null));
            }}
          >
            Save as PDF
          </Button>
          <Button variant="cord" iconRight="arrow" onClick={() => setStage("check")}>
            I saved them
          </Button>
        </div>
        <button type="button" className={s.linkBtn} onClick={onRestore}>
          I already have a buyer key
        </button>
      </>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!allRight) return;
        setBusy("keep");
        setErr(null);
        rememberBuyerKey(key)
          .then(() => onDone(key))
          .catch(() =>
            setErr("This browser would not keep the key. Your words still work; use them to open your purchase."),
          )
          .finally(() => setBusy(null));
      }}
      className={s.checkWords}
    >
      <p className={s.subHead}>Check your words</p>
      <p className={s.fine}>Type these words from your list, so we know you can open your purchase later.</p>
      <div className={s.checkGrid}>
        {positions.map((p, i) => {
          const v = typed[i] ?? "";
          const bad = v.trim() !== "" && normalizePhrase(v) !== words[p];
          return (
            <TextField
              key={p}
              label={`Word ${p + 1}`}
              value={v}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setTyped((t) => t.map((x, j) => (j === i ? e.target.value : x)))}
              error={bad ? (isPhraseWord(v) ? "Not the word in that place." : "Not one of the 12 words.") : undefined}
              ok={!bad && v.trim() !== "" ? "Right" : undefined}
            />
          );
        })}
      </div>
      {err ? <Oops title="Not kept on this device">{err}</Oops> : null}
      <div className={s.rowWrap}>
        <Button variant="ghost" icon="back" onClick={() => setStage("show")}>
          Show the words again
        </Button>
        <Button type="submit" variant="cord" icon="check" busy={busy === "keep"} disabled={!allRight}>
          Use this key
        </Button>
      </div>
      <LockLine>Kept on this device, locked by this browser. On another device, type the 12 words.</LockLine>
    </form>
  );
}

function RestoreKey({ onDone, onBack }: { onDone: (k: BuyerKey) => void; onBack: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const words = normalizePhrase(text) ? normalizePhrase(text).split(" ") : [];
  const unknown = words.filter((w) => !isPhraseWord(w));
  const valid = words.length === 12 && isValidPhrase(text);
  const hint =
    unknown.length > 0
      ? `Not a key word: ${unknown.slice(0, 3).join(", ")}`
      : words.length > 0 && words.length !== 12
        ? `${words.length} words so far. A buyer key has 12.`
        : words.length === 12 && !valid
          ? "These are real words, but not in a valid order."
          : null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        setErr(null);
        const k = buyerKeyFrom(text);
        rememberBuyerKey(k)
          .then(() => onDone(k))
          .catch(() => setErr("This browser would not keep the key."))
          .finally(() => setBusy(false));
      }}
      className={s.checkWords}
    >
      <p className={s.subHead}>Use my buyer key</p>
      <label className={s.wordsLabel} htmlFor="buyer-words">
        Your 12 words, in order
      </label>
      <textarea
        id="buyer-words"
        className={s.wordsInput}
        rows={3}
        value={text}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        aria-invalid={hint ? true : undefined}
        aria-describedby="buyer-words-msg"
        placeholder="word word word …"
      />
      <p id="buyer-words-msg" className={hint ? s.bad : valid ? s.good : s.fine} aria-live="polite">
        {hint ?? (valid ? "Valid buyer key" : "Checked on this device; never sent anywhere.")}
      </p>
      {err ? <Oops title="Not kept on this device">{err}</Oops> : null}
      <div className={s.rowWrap}>
        <Button variant="ghost" icon="back" onClick={onBack}>
          Back
        </Button>
        <Button type="submit" variant="cord" icon="key" busy={busy} disabled={!valid}>
          Use this key
        </Button>
      </div>
    </form>
  );
}

const ADDRESS = /^qor1[02-9ac-hj-np-z]{38}$/;

function GiftChoice({
  value,
  onChange,
}: {
  value: { address: string; name: string | null; card: RecipientCard } | null;
  onChange: (v: { address: string; name: string | null; card: RecipientCard } | null) => void;
}) {
  const [input, setInput] = useState(value ? (value.name ? `@${value.name}` : value.address) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>();
  const find = async () => {
    const raw = input.trim();
    setErr(undefined);
    onChange(null);
    if (!raw) return;
    setBusy(true);
    try {
      let address: string;
      let name: string | null = null;
      if (ADDRESS.test(raw)) {
        address = raw;
        name = (await api.get<{ name: string | null }>(`/names/of/${address}`).catch(() => ({ name: null }))).name;
      } else {
        const n = raw.replace(/^@/, "").toLowerCase();
        // The owner of a name is read from QoreChain, not taken from our server.
        const owner = await ownerOfName(n);
        if (!owner) throw new Error(`Nobody has @${n} yet. Check the name, or paste their qor1 address.`);
        address = owner;
        name = n;
      }
      const card = await cardOf(address);
      onChange({ address, name, card });
    } catch (e) {
      setErr(failureText(e, "That account could not be found."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className={s.subPanel}
      onSubmit={(e) => {
        e.preventDefault();
        void find();
      }}
    >
      <div className={s.giftRow}>
        <TextField
          label="Their @name or wallet address"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (value) onChange(null);
          }}
          placeholder="@mila or qor1…"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          error={err}
          hint="It is sealed to their account's key, read from QoreChain."
        />
        <Button type="submit" variant="line" busy={busy} disabled={!input.trim()}>
          Find
        </Button>
      </div>
      {value ? (
        <p className={s.found}>
          <Icon name="check" size={16} />
          <span>
            <b>{value.name ? `@${value.name}` : "Mizuhiki account"}</b> · key {fingerprint(cardHash(value.card), 16)}
          </span>
        </p>
      ) : null}
    </form>
  );
}
