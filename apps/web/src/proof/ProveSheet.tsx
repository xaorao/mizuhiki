"use client";
/** "Prove it existed": anchor a hash with the owner's key, with real steps and a certificate at the end. */
import { useState } from "react";
import { Button, ButtonLink, Hanko, Oops, Segmented, SealMoment, Sheet, TextField, type SealStep } from "@mizuhiki/ui";
import { ChainError, type AnchorKind, type AnchorRecord } from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { PROVE_STEP_LABEL, certificatePath, prove, type ProveStep } from "./proof";
import type { Hashed } from "./HashDrop";
import s from "./proof.module.css";
import { failureText } from "@/lib/failure";

export function ProveSheet({
  account,
  target,
  defaultKind = "document",
  onClose,
  onDone,
}: {
  account: Account;
  target: Hashed;
  defaultKind?: AnchorKind;
  onClose: () => void;
  /** Called with what was just written (read back from QoreChain), so lists can show it before any indexer. */
  onDone?: (r: { record: AnchorRecord; txHash: string | null; note: string }) => void;
}) {
  const [kind, setKind] = useState<AnchorKind>(defaultKind);
  const [note, setNote] = useState("");
  const [phase, setPhase] = useState<"ready" | "working" | "done" | "failed">("ready");
  const [steps, setSteps] = useState<SealStep[]>([]);
  const [result, setResult] = useState<{ fresh: boolean; othersEarlier: number; tx: string | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const order: ProveStep[] = ["window", "sign", "send", "label"];

  const go = async () => {
    setPhase("working");
    setSteps(order.map((k) => ({ label: PROVE_STEP_LABEL[k], state: "waiting" })));
    try {
      const r = await prove({
        account,
        hash: target.hash,
        kind,
        file: target.file,
        note,
        onStep: (k) => {
          const idx = order.indexOf(k);
          setSteps(
            order.map((x, i) => ({
              label: PROVE_STEP_LABEL[x],
              state: i < idx ? "done" : i === idx ? "running" : "waiting",
            })),
          );
        },
      });
      setSteps(order.map((x) => ({ label: PROVE_STEP_LABEL[x], state: "done" })));
      setResult({ fresh: r.fresh, othersEarlier: r.othersEarlier, tx: r.txHash });
      setPhase("done");
      onDone?.({ record: r.record, txHash: r.txHash, note });
    } catch (e) {
      const moved = e instanceof ChainError ? e.moved : "unknown";
      const base = failureText(e, "The anchor could not be written.");
      // Chain messages already say what moved; add it only when the text does not.
      const said = /Nothing (was )?(changed|sent|moved|written)|fee was spent/i.test(base);
      setFailure(
        moved === "no" && !said
          ? `${base} Nothing was written to QoreChain.`
          : moved === "yes" && !said
            ? `${base} A fee was spent; check the certificate before trying again.`
            : base,
      );
      setPhase("failed");
    }
  };

  const progress = steps.filter((x) => x.state === "done").length / Math.max(1, steps.length);
  return (
    <Sheet
      open
      onClose={() => phase !== "working" && onClose()}
      title="Prove it existed"
      dismissable={phase !== "working"}
    >
      {phase === "ready" ? (
        <div className={s.prove}>
          <p className={s.muted}>
            The fingerprint of <b>{target.file.name}</b> goes on QoreChain with your post-quantum key. The file itself
            never leaves this device; anyone you give it to can check it against the certificate.
          </p>
          <p className={s.mono}>{target.hash}</p>
          <Segmented<AnchorKind>
            label="What is it"
            value={kind}
            onChange={setKind}
            options={[
              { value: "document", label: "Document" },
              { value: "file", label: "File" },
              { value: "invoice", label: "Invoice" },
            ]}
          />
          <TextField
            label="Private note (optional)"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            hint="Sealed to you only, with the file name, so your list makes sense later. Not on chain."
          />
          <p className={s.cost}>
            Costs a small test-QOR fee from your account. The fingerprint is public; the file and your note are not.
          </p>
          <Button variant="cord" size="lg" full icon="check" onClick={() => void go()}>
            Anchor on QoreChain
          </Button>
        </div>
      ) : null}
      {phase === "working" ? <SealMoment steps={steps} progress={Math.max(0.05, progress)} /> : null}
      {phase === "done" && result ? (
        <div className={s.proveDone}>
          <Hanko size={84}>証</Hanko>
          <h3>{result.fresh ? "Anchored. It is on QoreChain now." : "You anchored this already."}</h3>
          <p className={s.muted}>
            The certificate shows the time, your account and the transaction. Share it with anyone who should be able to
            check.
          </p>
          {result.othersEarlier > 0 ? (
            <p className={s.muted} role="note">
              {result.othersEarlier === 1 ? "Another account" : `${result.othersEarlier} other accounts`} anchored this
              fingerprint earlier. Every account keeps its own record, so the certificate lists each one with its time.
            </p>
          ) : null}
          <ButtonLink href={certificatePath(target.hash)} variant="cord" icon="arrow" target="_blank">
            Open the certificate
          </ButtonLink>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : null}
      {phase === "failed" && failure ? (
        <Oops
          title="Not anchored"
          action={
            <Button variant="line" size="sm" onClick={() => setPhase("ready")}>
              Back
            </Button>
          }
        >
          {failure}
        </Oops>
      ) : null}
    </Sheet>
  );
}
