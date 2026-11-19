"use client";
/**
 * A shared results snapshot at /r/<hash>#k=<key>&f=<form>. The key is in the
 * fragment, which browsers never send to a server. Before anything is opened,
 * this page reads who shared it (GET /snapshots/:hash, metadata only), reads
 * that account's ML-DSA key from QoreChain and checks the owner's signature
 * over {formId, envelope}. Only then does it fetch the sealed copy, check it
 * against its address, open it here and show it read-only.
 */
import { useEffect, useState } from "react";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import { Icon, Musubi, Skeleton, Wordmark } from "@mizuhiki/ui";
import { api, ApiFailure } from "@/lib/api";
import { localStamp } from "./aggregate";
import { SnapshotFailure, openSnapshot, parseSnapshotFragment } from "./snapshot";
import type { Snapshot } from "./schema";
import { SnapshotMetaSchema, snapshotSignedBy, type SnapshotMeta } from "./snapshotSig";
import { CounterTiles, SummaryList } from "./Summary";
import s from "../results.module.css";

type Load =
  { s: "loading" } | { s: "error"; title: string; detail: string } | { s: "ok"; snap: Snapshot; meta: SnapshotMeta };

const UNVERIFIED = {
  title: "This snapshot could not be verified",
  detail:
    "Its signature does not match its owner's post-quantum key on QoreChain, so it was not opened. Do not trust a copy of it.",
};

export function SnapshotView({ hash }: { hash: string }) {
  const [load, setLoad] = useState<Load>({ s: "loading" });

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      const frag = parseSnapshotFragment(window.location.hash);
      if (!/^[0-9a-f]{64}$/.test(hash)) {
        setLoad({
          s: "error",
          title: "There is no snapshot at this link",
          detail: "The link is not complete. Ask the person who shared it for the full link. Nothing was opened.",
        });
        return;
      }
      if (!frag) {
        setLoad({
          s: "error",
          title: "This link is missing its key",
          detail:
            "Snapshot links carry their key after the # sign. Ask the person who shared it for the full link. Nothing was opened.",
        });
        return;
      }
      let meta: SnapshotMeta;
      try {
        const raw = await api.get<unknown>(`/snapshots/${hash}`, { signal: ctrl.signal });
        const parsed = SnapshotMetaSchema.safeParse(raw);
        if (!parsed.success) throw new SnapshotFailure("unverified", UNVERIFIED.detail);
        meta = parsed.data;
        const key = await pqKeyViaEvm(meta.owner);
        if (!snapshotSignedBy({ meta, hash, formId: frag.formId, key }))
          throw new SnapshotFailure("unverified", UNVERIFIED.detail);
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiFailure && e.status === 404)
          setLoad({
            s: "error",
            title: "This snapshot was deleted by its owner",
            detail: "Its owner deleted it, so the link no longer opens anything. Ask them to share a new one.",
          });
        else if (e instanceof SnapshotFailure) setLoad({ s: "error", ...UNVERIFIED });
        else
          setLoad({
            s: "error",
            title: "This snapshot could not be checked",
            detail:
              "Mizuhiki or QoreChain could not be reached to check who shared it, so nothing was opened. Reload the page to try again.",
          });
        return;
      }
      try {
        const env = await api.bytes(`/blobs/${hash}`, { signal: ctrl.signal });
        setLoad({ s: "ok", snap: openSnapshot(hash, env, frag.seed, frag.formId), meta });
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof ApiFailure && e.status === 404)
          setLoad({
            s: "error",
            title: "This snapshot is no longer stored",
            detail: "Its sealed copy is gone. Ask its owner to share a new one.",
          });
        else if (e instanceof SnapshotFailure && e.reason === "wrong-key")
          setLoad({
            s: "error",
            title: "This key does not open the snapshot",
            detail: "The link may have been cut or changed. Ask the person who shared it for the full link.",
          });
        else if (e instanceof SnapshotFailure)
          setLoad({ s: "error", title: "This snapshot could not be read", detail: e.message });
        else
          setLoad({
            s: "error",
            title: "This snapshot could not be opened",
            detail: "Mizuhiki could not be reached. Check your connection and reload the page.",
          });
      }
    })();
    return () => ctrl.abort();
  }, [hash]);

  return (
    <div className={s.publicStage}>
      <header className={s.publicBar}>
        <Wordmark size={22} href="/" />
      </header>
      <main className={s.publicMain}>
        {load.s === "loading" ? (
          <div className={s.paper}>
            <p className={s.kicker}>Opening the snapshot on this device…</p>
            <Skeleton lines={6} />
          </div>
        ) : load.s === "error" ? (
          <div className={[s.paper, s.center].join(" ")} role="alert">
            <Musubi face="worried" size={110} />
            <h1 className={s.errTitle}>{load.title}</h1>
            <p className={s.note}>{load.detail}</p>
          </div>
        ) : (
          <>
            <p className={s.warn}>
              <Icon name="link" size={16} />
              <span>
                This snapshot was shared by its owner. Anyone with this link can read it. It was opened on this device;
                Mizuhiki cannot read it.
              </span>
            </p>
            <p className={s.verified}>
              <Icon name="shield" size={14} /> Shared by{" "}
              {load.meta.ownerName ? `@${load.meta.ownerName}` : `${load.meta.owner.slice(0, 12)}…`}, signed with their
              post-quantum key, checked on QoreChain
            </p>
            <section className={s.paper}>
              <p className={s.kicker}>Form results · snapshot</p>
              <h1 className={s.snapTitle}>{load.snap.title || "Untitled form"}</h1>
              {load.snap.description ? <p className={s.note}>{load.snap.description}</p> : null}
              <p className={s.note}>
                Made {localStamp(load.snap.createdAt)} from {load.snap.responses} answer
                {load.snap.responses === 1 ? "" : "s"}. It does not update.
              </p>
              <CounterTiles counters={load.snap.counters} />
            </section>
            <h2 className={s.h2}>Summary</h2>
            <SummaryList summary={load.snap.summary} />
            {load.snap.table ? (
              <>
                <h2 className={s.h2}>Responses</h2>
                <div className={s.tableWrap} tabIndex={0} role="region" aria-label="Responses">
                  <table className={s.table}>
                    <thead>
                      <tr>
                        {load.snap.table.columns.map((c, i) => (
                          <th key={i} scope="col">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {load.snap.table.rows.map((r, ri) => (
                        <tr key={ri}>
                          {load.snap.table?.columns.map((_, ci) => (
                            <td key={ci} title={r[ci] ?? ""}>
                              {r[ci] || <span className={s.dash}>–</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}
            <p className={s.lockNote}>
              <Icon name="lock" size={13} /> Made with Mizuhiki: answers are sealed on each respondent&apos;s device,
              and only the form&apos;s readers can open them.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
