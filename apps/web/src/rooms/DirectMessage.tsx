"use client";
/**
 * "Message" on a room member: a private sealed message to that person's
 * inbox, signed with your keys so they see who it is from. It travels the
 * same way as any Mizuhiki message (sealed here, dropped content-blind).
 */
import { useState } from "react";
import { Button, LockLine, Sheet, TextArea, useToast } from "@mizuhiki/ui";
import { useAccount } from "@/account/AccountProvider";
import { SEND_STEP_LABEL, sendSealed, type SendStep } from "@/lib/send";
import s from "./rooms.module.css";
import { failureText } from "@/lib/failure";

export function DirectMessage({ to, toLabel, onClose }: { to: string | null; toLabel: string; onClose: () => void }) {
  const { account } = useAccount();
  const toast = useToast();
  const [text, setText] = useState("");
  const [step, setStep] = useState<SendStep | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!account || !to || !text.trim()) return;
    setError(null);
    try {
      await sendSealed({
        to: { address: to, card: null },
        kind: "message",
        text: text.trim(),
        contact: "",
        files: [],
        maxFileBytes: 0,
        signer: account,
        onStep: (st) => setStep(st),
      });
      toast.show(`Sealed and sent to ${toLabel}'s inbox.`);
      setText("");
      onClose();
    } catch (e) {
      setError(failureText(e, "The conversation could not be opened. Try again."));
    } finally {
      setStep(null);
    }
  };

  return (
    <Sheet open={to !== null} onClose={onClose} title={`Message ${toLabel}`}>
      <TextArea
        label="Private message"
        placeholder="Only they can read this"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        maxLength={8000}
        error={error ?? undefined}
      />
      <LockLine>
        Sealed on this device to {toLabel} and you, signed with your key. It arrives in their inbox, not in the room.
      </LockLine>
      <div className={s.sheetActions}>
        <Button variant="line" onClick={onClose} disabled={step !== null}>
          Cancel
        </Button>
        <Button variant="cord" icon="send" busy={step !== null} disabled={!text.trim()} onClick={() => void send()}>
          {step ? SEND_STEP_LABEL[step] : "Send sealed"}
        </Button>
      </div>
    </Sheet>
  );
}
