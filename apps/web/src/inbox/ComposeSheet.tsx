"use client";
/**
 * Reply sealed, or forward to another Mizuhiki account (spec 5.8). Both are
 * signed with the owner's keys and sealed to the recipient and to the owner,
 * so the sent copy opens on any of the owner's devices. A forward re-seals the
 * file keys; the sealed pieces are reused, not uploaded again.
 */
import { useState } from "react";
import {
  Button,
  Oops,
  Readers,
  Receipt,
  SealDone,
  SealFailed,
  SealMoment,
  Sheet,
  TextArea,
  TextField,
  type SealStep,
} from "@mizuhiki/ui";
import { normalizeNameInput } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { SEND_STEP_LABEL, sendSealed, type SendResult, type SendStep } from "@/lib/send";
import type { InboxRow, OpenedMessage } from "./model";
import type { SenderCheck } from "./useInbox";
import s from "./inbox.module.css";
import { ownerOfName } from "@mizuhiki/chain";
import { failureText } from "@/lib/failure";

export type ComposeMode = { kind: "reply"; to: string; toLabel: string } | { kind: "forward" };

export function ComposeSheet({
  mode,
  account,
  original,
  onClose,
  onSent,
}: {
  mode: ComposeMode;
  account: Account;
  token: () => Promise<string>;
  original: { row: InboxRow; opened: OpenedMessage | undefined; check: SenderCheck };
  onClose: () => void;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [toName, setToName] = useState("");
  const [toErr, setToErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<"compose" | "sealing" | "done" | "failed">("compose");
  const [steps, setSteps] = useState<SealStep[]>([]);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<{ r: SendResult; label: string } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolveTarget = async (): Promise<{ address: string; label: string } | null> => {
    if (mode.kind === "reply") return { address: mode.to, label: mode.toLabel };
    const name = normalizeNameInput(toName);
    if (!name) {
      setToErr("Type the @name of a Mizuhiki account.");
      return null;
    }
    try {
      // The owner of a name is read from QoreChain, not taken from our server.
      const owner = await ownerOfName(name);
      if (!owner) {
        setToErr(`Nobody has @${name}. Check the spelling.`);
        return null;
      }
      if (owner === account.owner.address) {
        setToErr("That is you. Pick someone else.");
        return null;
      }
      return { address: owner, label: `@${name}` };
    } catch (e) {
      setToErr(failureText(e, "That name could not be checked. Nothing was sent."));
      return null;
    }
  };

  const send = async () => {
    setToErr(null);
    setError(null);
    if (mode.kind === "reply" && !text.trim()) {
      setError("Write your reply first. Nothing has left your device.");
      return;
    }
    const target = await resolveTarget();
    if (!target) return;
    const order: SendStep[] = ["keys", "seal", "sign", "stamp", "send"];
    setSteps(order.map((k) => ({ label: SEND_STEP_LABEL[k], state: "waiting" })));
    setProgress(0.02);
    setPhase("sealing");
    const { row, opened, check } = original;
    try {
      const r = await sendSealed({
        to: { address: target.address, card: null },
        kind: mode.kind === "reply" ? "reply" : "message",
        ref: mode.kind === "reply" && row.envelope ? `re:${row.envelope}` : undefined,
        text: mode.kind === "reply" ? text : (opened?.text ?? ""),
        contact: mode.kind === "reply" ? "" : (opened?.contact ?? ""),
        files: [],
        sealedFiles: mode.kind === "forward" ? opened?.files : undefined,
        extra:
          mode.kind === "reply"
            ? {
                ...(row.envelope ? { inReplyTo: row.envelope } : {}),
                ...(opened?.text ? { quote: opened.text.slice(0, 280) } : {}),
              }
            : {
                forwardedBy: account.owner.address,
                originalFrom: row.sender && check === "verified" ? row.sender.address : "anonymous",
                ...(text.trim() ? { forwardNote: text.trim() } : {}),
              },
        maxFileBytes: 2 * 1024 * 1024 * 1024,
        signer: account,
        onStep: (k, p) => {
          const idx = order.indexOf(k);
          setSteps(
            order.map((x, i) => ({
              label: SEND_STEP_LABEL[x],
              state: i < idx ? "done" : i === idx ? "running" : "waiting",
            })),
          );
          setProgress(p);
        },
      });
      setSteps(order.map((x) => ({ label: SEND_STEP_LABEL[x], state: "done" })));
      setProgress(1);
      setResult({ r, label: target.label });
      setPhase("done");
      onSent();
    } catch (e) {
      setFailure(failureText(e, "Nothing left your device."));
      setPhase("failed");
    }
  };

  const title = mode.kind === "reply" ? `Reply to ${mode.toLabel}` : "Forward sealed";
  return (
    <Sheet
      open
      onClose={() => phase !== "sealing" && onClose()}
      title={phase === "done" ? "Sealed and sent" : title}
      dismissable={phase !== "sealing"}
    >
      {phase === "compose" ? (
        <form
          className={s.compose}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {mode.kind === "forward" ? (
            <TextField
              label="Forward to"
              prefix="@"
              value={toName}
              onChange={(e) => {
                setToName(e.target.value);
                setToErr(null);
              }}
              error={toErr ?? undefined}
              hint="Their Mizuhiki name. It is re-sealed to their key; files come along."
              autoFocus
            />
          ) : (
            <Readers readers={[{ label: mode.toLabel }, { label: "you" }]} />
          )}
          {original.opened?.text && mode.kind === "reply" ? (
            <blockquote className={s.quote}>{original.opened.text.slice(0, 280)}</blockquote>
          ) : null}
          <TextArea
            label={mode.kind === "reply" ? "Your reply" : "Add a note (optional)"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={20000}
            autoFocus={mode.kind === "reply"}
          />
          {error ? <Oops title="Nothing to seal yet">{error}</Oops> : null}
          <p className={s.signedNote}>Signed with your post-quantum key, so they can check it came from you.</p>
          <Button type="submit" variant="cord" size="lg" full icon="lock">
            {mode.kind === "reply" ? "Seal and reply" : "Seal and forward"}
          </Button>
        </form>
      ) : null}
      {phase === "sealing" ? <SealMoment steps={steps} progress={progress} /> : null}
      {phase === "done" && result ? (
        <SealDone
          headline={`Sealed for ${result.label} and you.`}
          onDone={onClose}
          receipt={
            <Receipt
              title={mode.kind === "reply" ? "Reply sealed" : "Forward sealed"}
              when={new Date().toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              lines={[
                { term: "To", value: result.label },
                { term: "Readers", value: `${result.label} and you` },
                { term: "Sender", value: "Signed with your key" },
                { term: "On chain", value: "Nothing" },
              ]}
              hash={result.r.hash}
            />
          }
        />
      ) : null}
      {phase === "failed" && failure ? (
        <SealFailed
          title="Not sent."
          detail={failure}
          onClose={onClose}
          onRetry={() => setPhase("compose")}
          retryLabel="Back to editing"
        />
      ) : null}
    </Sheet>
  );
}
