"use client";
/**
 * The public certificate for one hash (spec 5.15, DocuSign's certificate idea).
 * Every fact is read from QoreChain in this browser: each anchor record, its
 * transaction, and the anchoring account's name (confirmed with `resolve`).
 * Every account keeps its own record of a fingerprint, so all are listed, earliest
 * first. No content is shown. A verifier box hashes a file here and says Match or No match.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ButtonLink,
  CopyValue,
  Hanko,
  Icon,
  Musubi,
  Oops,
  Skeleton,
  StatusChip,
  Wordmark,
  useToast,
} from "@mizuhiki/ui";
import { explorerTx, resolveOnChain, type AnchorRecord } from "@mizuhiki/chain";
import { api } from "@/lib/api";
import { anchorTx, readAnchors } from "./proof";
import { HashDrop, type Hashed } from "./HashDrop";
import s from "./proof.module.css";

type Load =
  | { state: "loading" }
  | { state: "bad" }
  | { state: "none" }
  | { state: "error"; reason: string }
  | { state: "ok"; first: Row; rows: Row[] };

interface Row {
  a: AnchorRecord;
  tx: string | null;
  name: string | null;
}

const CONTRACT_LABEL: Record<AnchorRecord["contract"], string> = {
  book: "the Mizuhiki AnchorBook contract",
  registry: "the Mizuhiki registry contract",
};

const when = (d: Date) =>
  d.toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** The transaction and the on-chain-confirmed name for one anchor. */
async function detail(a: AnchorRecord): Promise<Row> {
  const [tx, named] = await Promise.all([
    anchorTx(a),
    api.get<{ name: string | null }>(`/names/of/${a.byAddress}`).catch(() => ({ name: null })),
  ]);
  // Show a name only if the chain agrees it belongs to the anchoring account.
  let name: string | null = null;
  if (named.name) {
    const r = await resolveOnChain(named.name).catch(() => null);
    if (r?.owner?.toLowerCase() === a.by.toLowerCase()) name = named.name;
  }
  return { a, tx, name };
}

const KIND_LABEL: Record<string, string> = { file: "A file", invoice: "An invoice", document: "A document" };

export function Certificate({ hash }: { hash: string }) {
  const toast = useToast();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [check, setCheck] = useState<{ result: "match" | "nomatch"; name: string } | null>(null);

  useEffect(() => {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      setLoad({ state: "bad" });
      return;
    }
    const life = { alive: true };
    void (async () => {
      try {
        const all = await readAnchors(hash);
        if (all.length === 0) {
          if (life.alive) setLoad({ state: "none" });
          return;
        }
        const [first, ...rest] = await Promise.all(all.slice(0, 50).map(detail));
        if (life.alive && first) setLoad({ state: "ok", first, rows: [first, ...rest] });
      } catch {
        if (life.alive) setLoad({ state: "error", reason: "QoreChain could not be reached. Nothing was checked yet." });
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [hash]);

  const onHashed = (h: Hashed) => setCheck({ result: h.hash === hash ? "match" : "nomatch", name: h.file.name });

  return (
    <div className={s.stage}>
      <header className={s.bar0}>
        <Wordmark size={22} href="/" />
        <Link href="/proof" className={s.checkLink}>
          Check a document
        </Link>
      </header>
      <main className={s.cert}>
        {load.state === "loading" ? (
          <div className={s.card} aria-busy="true">
            <p className={s.kicker}>Reading QoreChain…</p>
            <Skeleton lines={5} />
          </div>
        ) : load.state === "bad" ? (
          <div className={s.card}>
            <Musubi face="worried" size={110} />
            <h1>That is not a document fingerprint</h1>
            <p className={s.muted}>A certificate link ends in 64 letters and numbers (a SHA-256 hash).</p>
            <ButtonLink href="/proof" variant="line">
              Check a document instead
            </ButtonLink>
          </div>
        ) : load.state === "error" ? (
          <Oops title="Not checked yet">{load.reason}</Oops>
        ) : load.state === "none" ? (
          <div className={s.card}>
            <Musubi face="sleepy" size={110} />
            <h1>Nothing is anchored with this fingerprint</h1>
            <p className={s.muted}>
              QoreChain has no anchor for this hash, so there is no proof that this document existed.
            </p>
            <CopyValue value={hash} label="Fingerprint" short />
          </div>
        ) : (
          <div className={s.card}>
            <div className={s.certHead}>
              <div>
                <p className={s.kicker}>しょうめい · Proof of existence</p>
                <h1>{KIND_LABEL[load.first.a.kind] ?? "A document"} existed, unchanged, by this time.</h1>
              </div>
              <Hanko size={78}>証</Hanko>
            </div>
            <StatusChip status="ok">Read from QoreChain just now</StatusChip>
            <dl className={s.facts}>
              <div>
                <dt>{load.rows.length > 1 ? "First anchored" : "Anchored"}</dt>
                <dd>
                  {when(load.first.a.at)}
                  <small>
                    Your time zone ({Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ")}), as
                    recorded by QoreChain in block {load.first.a.blockNumber.toLocaleString("en-US")}
                  </small>
                </dd>
              </div>
              <div>
                <dt>Anchored by</dt>
                <dd>
                  <Who row={load.first} />
                </dd>
              </div>
              <div>
                <dt>Fingerprint (SHA-256)</dt>
                <dd>
                  <CopyValue value={hash} label="Fingerprint" />
                </dd>
              </div>
              <div>
                <dt>Transaction</dt>
                <dd>
                  <TxLink tx={load.first.tx} />
                </dd>
              </div>
              <div>
                <dt>Signed with</dt>
                <dd>
                  The account&apos;s ML-DSA-87 post-quantum key, checked by {CONTRACT_LABEL[load.first.a.contract]}
                </dd>
              </div>
            </dl>

            {load.rows.length > 1 ? (
              <section className={s.others} aria-label="Every account that anchored this fingerprint">
                <h2>Anchored by {load.rows.length} accounts</h2>
                <p className={s.muted}>
                  Each account keeps its own record of this fingerprint, signed with its own key. Earliest first.
                </p>
                <ol>
                  {load.rows.map((r, i) => (
                    <li key={`${r.a.by}-${r.a.contract}`}>
                      <span className={s.otherN}>{i + 1}</span>
                      <div>
                        <Who row={r} />
                        <small>
                          {when(r.a.at)} · block {r.a.blockNumber.toString()} · <TxLink tx={r.tx} />
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}

            <section className={s.verify} aria-label="Check a file against this certificate">
              <h2>Have the file? Check it here.</h2>
              <HashDrop label="Drop the file to compare" onHashed={onHashed} compact />
              {check ? (
                <div className={[s.result, check.result === "match" ? s.match : s.nomatch].join(" ")} role="status">
                  <Musubi face={check.result === "match" ? "happy" : "worried"} size={56} sticker={false} />
                  <div>
                    <b>{check.result === "match" ? "Match" : "No match"}</b>
                    <span>
                      {check.result === "match"
                        ? `“${check.name}” is exactly the document anchored here.`
                        : `“${check.name}” is not this document. Even a one-letter change gives a different fingerprint.`}
                    </span>
                  </div>
                </div>
              ) : null}
            </section>

            <section className={s.means}>
              <h2>What this proves</h2>
              <ul>
                <li>
                  <Icon name="check" size={15} /> This exact document existed no later than the time above, and has not
                  changed since.
                </li>
                <li>
                  <Icon name="check" size={15} /> {load.rows.length > 1 ? "Each account listed" : "The account above"}{" "}
                  had it at that time and anchored it with its own post-quantum key.
                </li>
                <li>
                  <Icon name="x" size={15} /> It does not show the document, and does not prove who wrote it.
                </li>
              </ul>
            </section>
            <button
              type="button"
              className={s.share}
              onClick={() =>
                void navigator.clipboard.writeText(location.href).then(
                  () => toast.show("Certificate link copied"),
                  () => toast.show("Copy is not allowed here", { tone: "error" }),
                )
              }
            >
              <Icon name="copy" size={15} /> Copy certificate link
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function Who({ row }: { row: Row }) {
  return (
    <>
      {row.name ? <Link href={`/@${row.name}`}>@{row.name}</Link> : "A QoreChain account"}
      <small className={s.mono}>{row.a.byAddress}</small>
    </>
  );
}

function TxLink({ tx }: { tx: string | null }) {
  return tx ? (
    <a href={explorerTx(tx)} target="_blank" rel="noreferrer" className={s.mono}>
      {tx.slice(0, 18)}… <Icon name="link" size={13} />
    </a>
  ) : (
    <>Not found in that block&apos;s logs</>
  );
}
