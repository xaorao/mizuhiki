"use client";
/**
 * Proof on QoreChain (spec section 0, "real receipts, real hashes, real testnet transactions in the proof page").
 * Everything here is read from the QoreChain test network by the visitor's own browser when the page opens:
 * our contracts' code and deploy receipts, the demo account's keys, post-quantum signatures checked here over
 * the exact committed bytes, and the latest activity on our contracts. No number on this page comes from our
 * database, and nothing is written down in advance except which transactions to look at.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  checkTx,
  contractFacts,
  explorerAddress,
  explorerTx,
  isUnreachable,
  nameKeys,
  recentActivity,
  evmOutcome,
  type AccountKeysOnChain,
  type Activity,
  type ContractFacts,
  type TxCheck,
} from "@mizuhiki/chain";
import { Button, Icon, Kicker, LockLine, Musubi, Skeleton, StatusChip, Wordmark } from "@mizuhiki/ui";
import { SiteFooter } from "@/site/SiteFooter";
import { API_URL } from "@/lib/api";
import { PROOFS } from "@/landing/ProofCards";
import s from "./onchain.module.css";

const DEMO = "aria";
const RPC = `${API_URL}/chain/rpc`;
const n = (v: bigint | number) => Number(v).toLocaleString("en-US");
const short = (h: string, a = 10, b = 6) => (h.length > a + b + 1 ? `${h.slice(0, a)}…${b > 0 ? h.slice(-b) : ""}` : h);
/** The chain names the sealing algorithm "mlkem1024"; people read it as ML-KEM-1024. */
const algorithmName = (raw: string | null) =>
  !raw ? "ML-KEM-1024" : /^ml-?kem-?(\d+)$/i.test(raw) ? `ML-KEM-${/(\d+)$/.exec(raw)?.[1] ?? ""}` : raw;

type Load<T> = { s: "loading" } | { s: "ok"; v: T } | { s: "offline" } | { s: "failed"; why: string };

/** Run `read` once per attempt; network trouble and real failures are told apart. */
function useRead<T>(read: () => Promise<T>, attempt: number): Load<T> {
  const [st, setSt] = useState<Load<T>>({ s: "loading" });
  useEffect(() => {
    let live = true;
    setSt({ s: "loading" });
    read().then(
      (v) => live && setSt({ s: "ok", v }),
      (e: unknown) =>
        live && setSt(isUnreachable(e) ? { s: "offline" } : { s: "failed", why: (e as Error).message || "It failed." }),
    );
    return () => {
      live = false;
    };
  }, [read, attempt]);
  return st;
}

const CONTRACT_TEXT: Record<ContractFacts["key"], { name: string; does: string }> = {
  registry: {
    name: "MizuhikiRegistry",
    does: "Page names, the key card each name points to, room key changes, and form and product publication records.",
  },
  vault: {
    name: "CapsuleVault",
    does: "Capsules that open on a date, after a wait, or when the owner stops checking in, with guardians.",
  },
  anchorBook: {
    name: "AnchorBook",
    does: "Document fingerprints: one record per account per fingerprint, so anyone can check when a file existed.",
  },
};

const EVENT_TEXT: Record<string, string> = {
  NameClaimed: "Page name claimed",
  NameReleased: "Page name released",
  Anchored: "Document fingerprint anchored",
  RoomCreated: "Room created",
  RoomEpoch: "Room key changed",
  RoomClosed: "Room closed",
  Published: "Form or product published",
  CapsuleCreated: "Capsule armed",
  GuardiansSet: "Capsule guardians set",
  ReleaseRequested: "A guardian asked to open a capsule",
  Released: "Capsule opened",
  Cancelled: "Capsule cancelled",
  CheckedIn: "Owner checked in",
};

function Section({
  id,
  jp,
  title,
  lead,
  children,
}: {
  id: string;
  jp: string;
  title: string;
  lead: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={s.section} aria-labelledby={`${id}-h`}>
      <Kicker>{jp}</Kicker>
      <h2 id={`${id}-h`}>{title}</h2>
      <p className={s.lead}>{lead}</p>
      {children}
    </section>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className={s.offline} role="status">
      <span>QoreChain could not be reached just now, so this part is not shown. Nothing on this page is made up.</span>
      <Button size="sm" variant="line" icon="refresh" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

function Contracts({ attempt, retry }: { attempt: number; retry: () => void }) {
  const st = useRead(contractFacts, attempt);
  if (st.s === "loading") return <Skeleton lines={4} height={180} />;
  if (st.s === "offline") return <Unreachable onRetry={retry} />;
  if (st.s === "failed") return <p className={s.bad}>{st.why}</p>;
  return (
    <div className={s.cards}>
      {st.v.map((c) => (
        <article key={c.key} className={s.card}>
          <small>{CONTRACT_TEXT[c.key].name}</small>
          <p>{CONTRACT_TEXT[c.key].does}</p>
          <dl className={s.facts}>
            <div>
              <dt>Code on chain</dt>
              <dd>{c.codeBytes > 0 ? `${n(c.codeBytes)} bytes` : "None"}</dd>
            </div>
            <div>
              <dt>Created in</dt>
              <dd>block {n(c.deployBlock)}</dd>
            </div>
          </dl>
          {c.deployOk && c.codeBytes > 0 ? (
            <StatusChip status="ok">Deployed, receipt confirms</StatusChip>
          ) : (
            <StatusChip status="danger">The chain does not confirm this deploy</StatusChip>
          )}
          <a className={s.link} href={explorerAddress(c.address)} target="_blank" rel="noreferrer">
            <code>{short(c.address, 12, 8)}</code> <Icon name="share" size={12} />
          </a>
        </article>
      ))}
    </div>
  );
}

function Keys({ attempt, retry }: { attempt: number; retry: () => void }) {
  const read = useCallback(() => nameKeys(DEMO), []);
  const st = useRead<AccountKeysOnChain>(read, attempt);
  if (st.s === "loading") return <Skeleton lines={4} height={160} />;
  if (st.s === "offline") return <Unreachable onRetry={retry} />;
  if (st.s === "failed") return <p className={s.bad}>{st.why}</p>;
  const k = st.v;
  if (!k.owner) return <p className={s.bad}>QoreChain says nobody holds @{DEMO} right now.</p>;
  return (
    <div className={s.cards2}>
      <article className={s.card}>
        <small>Signing key</small>
        <b>ML-DSA-87</b>
        <p>Signs every page, name and contract action of @{DEMO}. Registered with a proof that the owner holds it.</p>
        <dl className={s.facts}>
          <div>
            <dt>Size</dt>
            <dd>{n(k.signing.bytes)} bytes</dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd>
              <code>{k.signing.fingerprint ?? "none"}</code>
            </dd>
          </div>
        </dl>
        {k.signing.registered && k.signing.possessionProven ? (
          <StatusChip status="ok">Registered, possession proven</StatusChip>
        ) : (
          <StatusChip status="danger">Not registered</StatusChip>
        )}
      </article>
      <article className={s.card}>
        <small>Sealing key</small>
        <b>{algorithmName(k.sealing.algorithm)}</b>
        <p>
          The key visitors seal to in their own browser. Only the owner&apos;s devices can open what is sealed to it.
        </p>
        <dl className={s.facts}>
          <div>
            <dt>Size</dt>
            <dd>{n(k.sealing.bytes)} bytes</dd>
          </div>
          <div>
            <dt>Fingerprint</dt>
            <dd>
              <code>{k.sealing.fingerprint ?? "none"}</code>
            </dd>
          </div>
          {k.sealing.height ? (
            <div>
              <dt>Published in</dt>
              <dd>block {n(k.sealing.height)}</dd>
            </div>
          ) : null}
        </dl>
        {k.sealing.registered ? (
          <StatusChip status="ok">Published on QoreChain</StatusChip>
        ) : (
          <StatusChip status="danger">Not published</StatusChip>
        )}
      </article>
      <p className={s.note}>
        @{DEMO} belongs to <code>{short(k.owner, 12, 8)}</code>, according to MizuhikiRegistry.{" "}
        <Link href={`/@${DEMO}`}>Open @{DEMO}&apos;s page</Link>, which your browser checks against these same keys.
      </p>
    </div>
  );
}

function Signature({ p, attempt }: { p: (typeof PROOFS)[number]; attempt: number }) {
  const read = useCallback(() => checkTx(p.hash, { rpcBase: RPC }), [p.hash]);
  const st = useRead<TxCheck | undefined>(read, attempt);
  return (
    <article className={s.card}>
      <small>{p.label}</small>
      <b>{p.title}</b>
      <p>{p.detail}</p>
      <div className={s.verdict} aria-live="polite">
        {st.s === "loading" ? (
          <span className={s.wait}>Checking the signature in your browser…</span>
        ) : st.s === "offline" ? (
          <span className={s.wait}>QoreChain could not be reached. Open it on the explorer.</span>
        ) : st.s === "failed" ? (
          <StatusChip status="danger">{st.why}</StatusChip>
        ) : !st.v ? (
          <StatusChip status="danger">QoreChain does not know this transaction</StatusChip>
        ) : !st.v.ok ? (
          <StatusChip status="danger">QoreChain reports this transaction failed</StatusChip>
        ) : st.v.tier === "classical" ? (
          <StatusChip status="info">Accepted by the contract</StatusChip>
        ) : st.v.tier === "enrollment" ? (
          <StatusChip status="info">Registers the key itself</StatusChip>
        ) : st.v.layer.verified ? (
          <StatusChip status="ok">Verified in your browser</StatusChip>
        ) : (
          <StatusChip status="danger">Signature did not verify</StatusChip>
        )}
        {st.s === "ok" && st.v ? <span className={s.block}>block {n(st.v.height)}</span> : null}
      </div>
      <a className={s.link} href={explorerTx(p.hash)} target="_blank" rel="noreferrer">
        <code>tx {short(p.hash, 16, 0)}</code> <Icon name="share" size={12} />
      </a>
    </article>
  );
}

function ActivityList({ attempt, retry }: { attempt: number; retry: () => void }) {
  const read = useCallback(() => recentActivity({ perKind: 3, maxChunks: 12 }), []);
  const st = useRead(read, attempt);
  if (st.s === "loading") return <Skeleton lines={6} height={240} />;
  if (st.s === "offline") return <Unreachable onRetry={retry} />;
  if (st.s === "failed") return <p className={s.bad}>{st.why}</p>;
  const { items, head, scannedFrom } = st.v;
  if (items.length === 0)
    return (
      <p className={s.note}>
        Nothing happened on our contracts between blocks {n(scannedFrom)} and {n(head)}.
      </p>
    );
  return (
    <>
      <ol className={s.activity}>
        {items.map((a: Activity) => (
          <li key={`${a.txHash}-${a.event}-${a.ref ?? ""}`}>
            <span className={s.what}>
              <b>{EVENT_TEXT[a.event] ?? a.event}</b>
              {a.name ? <span> @{a.name}</span> : a.ref ? <code> {short(a.ref, 10, 4)}</code> : null}
            </span>
            <span className={s.when}>
              block {n(a.block)} · {n(head - a.block)} blocks ago
            </span>
            <a href={explorerTx(a.txHash)} target="_blank" rel="noreferrer" aria-label={`Transaction ${a.txHash}`}>
              <code>{short(a.txHash, 10, 0)}</code> <Icon name="share" size={12} />
            </a>
          </li>
        ))}
      </ol>
      <p className={s.note}>
        Read from blocks {n(scannedFrom)} to {n(head)}: the latest three of each kind. Only public fields are shown;
        what people seal never reaches the chain.
      </p>
    </>
  );
}

/** The Q-Day Drill rehearsal (`pnpm --filter @mizuhiki/testnet drill`, 2026-11-21): the two calls that reached a contract. */
const DRILL_CALLS: { hash: `0x${string}`; what: string }[] = [
  {
    hash: "0x4cc25cdfe5961dd8d81aab415262cb9b7933932548f1fd7045ee4dde82669611",
    what: "Release the owner's page name, signed with a key that is not the owner's",
  },
  {
    hash: "0x73b2ce344a6c4aaa545b97e851ad3c2bc7d8ca96284a688287df6e10543c7054",
    what: "Record a fingerprint in the owner's name, with the same forged signature",
  },
];

const DRILL_REFUSED = [
  "A transfer signed with the classical key alone: refused, the account must add its ML-DSA-87 signature.",
  "A transfer with a forged ML-DSA-87 signature: refused, the post-quantum signature did not verify.",
  "Opening an EVM window with the classical key: refused, only the post-quantum key can open one.",
  "With no window open, every EVM transfer, token approval and contract call: refused by the chain before it ran.",
  "During a live window the owner had opened for our contracts: a transfer and a token approval to anyone else were refused, the window does not list them.",
];

function DrillCall({ c, attempt }: { c: (typeof DRILL_CALLS)[number]; attempt: number }) {
  const read = useCallback(() => evmOutcome(c.hash), [c.hash]);
  const st = useRead(read, attempt);
  return (
    <li>
      <span className={s.what}>
        <b>{c.what}</b>
      </span>
      <span className={s.when}>
        {st.s === "loading" ? (
          "reading…"
        ) : st.s === "ok" ? (
          <StatusChip status={st.v.status === "reverted" ? "ok" : "danger"}>
            {st.v.status === "reverted" ? `Refused by the contract · block ${n(st.v.block)}` : "Went through"}
          </StatusChip>
        ) : (
          "could not read it now"
        )}
      </span>
      <a href={explorerTx(c.hash)} target="_blank" rel="noreferrer" aria-label={`Transaction ${c.hash}`}>
        <code>{short(c.hash, 10, 0)}</code> <Icon name="share" size={12} />
      </a>
    </li>
  );
}

function Drill({ attempt }: { attempt: number }) {
  return (
    <>
      <ul className={s.never}>
        {DRILL_REFUSED.map((x) => (
          <li key={x}>
            <Icon name="lock" size={16} /> {x}
          </li>
        ))}
      </ul>
      <ol className={s.activity}>
        {DRILL_CALLS.map((c) => (
          <DrillCall key={c.hash} c={c} attempt={attempt} />
        ))}
      </ol>
      <p className={s.note}>
        16 attempts in all, none got through, and the attacker&apos;s address ended with nothing. The owner&apos;s own
        transaction afterwards went through as normal. Run it yourself:{" "}
        <code>pnpm --filter @mizuhiki/testnet drill</code>.
      </p>
    </>
  );
}

export function OnChain() {
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((x) => x + 1), []);
  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <Wordmark size={20} href="/" />
        <nav aria-label="Proof">
          <Link href="/proof">Check a document</Link>
          <Link href="/legal/privacy">Privacy</Link>
        </nav>
      </header>
      <main className={s.main}>
        <div className={s.hero}>
          <span className={s.heroMm}>
            <Musubi face="normal" size={96} bob />
          </span>
          <Kicker>あかし</Kicker>
          <h1>Proof on QoreChain</h1>
          <p className={s.lead}>
            Everything below is read from the QoreChain test network by your browser, now. Nothing here is a screenshot,
            and no number comes from our own servers.
          </p>
          <LockLine>Testnet: no real money is involved.</LockLine>
        </div>

        <Section
          id="contracts"
          jp="けいやく"
          title="Our contracts"
          lead="Three contracts on QoreChain's EVM lane. Every change made for an account, such as a name, a fingerprint, a room or a capsule, must carry that account's ML-DSA-87 signature, which the contract checks."
        >
          <Contracts attempt={attempt} retry={retry} />
        </Section>

        <Section
          id="keys"
          jp="かぎ"
          title={`Post-quantum keys of @${DEMO}`}
          lead={`A demo account. Who holds the name and which keys it has are read from the chain, not from us.`}
        >
          <Keys attempt={attempt} retry={retry} />
        </Section>

        <Section
          id="signatures"
          jp="しょめい"
          title="Signatures you can check yourself"
          lead="Your browser fetches each transaction's exact committed bytes, checks they are the transaction asked for, and verifies the post-quantum signature against the key registered on chain."
        >
          <div className={s.cards2}>
            {PROOFS.map((p) => (
              <Signature key={p.hash} p={p} attempt={attempt} />
            ))}
          </div>
        </Section>

        <Section
          id="qday"
          jp="まもり"
          title="A stolen classical key cannot act"
          lead="We gave an attacker the classical secp256k1 key of a fresh account with its ML-DSA-87 key registered, as the QoreChain Q-Day Drill does, and tried everything that key alone can do."
        >
          <Drill attempt={attempt} />
        </Section>

        <Section
          id="activity"
          jp="いま"
          title="Latest activity on our contracts"
          lead="Names, fingerprints, room key changes and capsules, as the chain recorded them. Most of it comes from our automated test runs, which make real testnet transactions."
        >
          <ActivityList attempt={attempt} retry={retry} />
        </Section>

        <Section
          id="never"
          jp="みえない"
          title="What the chain never sees"
          lead="Names, keys, fingerprints and payments are public on chain, as on any blockchain. What people seal is not."
        >
          <ul className={s.never}>
            <li>
              <Icon name="lock" size={16} /> Messages, files, payment notes, form answers, invoices and room messages.
              They are sealed in the sender&apos;s browser and stored, sealed, by Mizuhiki.
            </li>
            <li>
              <Icon name="lock" size={16} /> Who sent an anonymous message. It carries no account at all.
            </li>
            <li>
              <Icon name="lock" size={16} /> A payment&apos;s note. The amount, the sender and the recipient of a
              payment are public, as with any transfer; the note is sealed to the people it names.
            </li>
            <li>
              <Icon name="lock" size={16} /> Your recovery phrase and keys. They exist only on your devices.
            </li>
          </ul>
        </Section>
      </main>
      <SiteFooter />
    </div>
  );
}
