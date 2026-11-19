"use client";
/**
 * Leave room, Transfer ownership (Telegram's security gate, adapted) and
 * Delete room ("Delete the room for all members" checkbox, then a 5-second
 * Undo before anything is sent).
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ChoiceCard, Sheet, TextField, useToast } from "@mizuhiki/ui";
import { deleteRoom, leaveRoom, transferOwnership } from "../engine";
import { PersonAvatar, label } from "../people";
import type { RoomState } from "../useRoom";
import { transferGate } from "./model";
import { InlineError } from "./Progress";
import s from "./info.module.css";

const UNDO_MS = 5000;

export function BottomActions({ room, names }: { room: RoomState; names: Record<string, string | null> }) {
  const router = useRouter();
  const toast = useToast();
  const detail = room.detail;
  const me = detail?.me;
  const roomName = room.derived?.info.name ?? "";
  const [sheet, setSheet] = useState<"leave" | "transfer" | "delete" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [forAll, setForAll] = useState(false);
  const [pending, setPending] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelled = useRef(false);

  if (!detail || !me || me.status !== "active") return null;
  const owner = me.role === "owner";
  const admins = detail.members.filter((m) => m.status === "active" && m.role === "admin");
  const gate = transferGate({ typed, roomName, target: admins.find((a) => a.address === target) });

  const open = (k: "leave" | "transfer" | "delete") => {
    setErr(null);
    setTyped("");
    setTarget(null);
    setForAll(false);
    setSheet(k);
  };
  const close = () => {
    if (!busy) setSheet(null);
  };

  const leave = async () => {
    setBusy("Leaving…");
    setErr(null);
    try {
      await leaveRoom(await room.acct(), detail.id);
      toast.show("You left the room. New messages are no longer shared with you.");
      setSheet(null);
      router.push("/app/rooms");
    } catch (e) {
      setErr(`You are still in the room. ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const transfer = async () => {
    if (!gate.allowed || !target) return;
    setBusy("Recording the new owner on QoreChain…");
    setErr(null);
    try {
      await transferOwnership(await room.acct(), detail.id, target);
      toast.show(`${label(target, names)} owns the room now. You are an admin.`);
      setSheet(null);
      void room.reload();
    } catch (e) {
      setErr(`You still own the room. ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const runDelete = async () => {
    setBusy("Recording the close on QoreChain…");
    try {
      await deleteRoom(await room.acct(), detail.id);
      toast.show("Room deleted. Its sealed messages were removed from storage.");
      router.push("/app/rooms");
    } catch (e) {
      setPending(false);
      toast.show(`The room was not deleted. ${(e as Error).message}`, { tone: "error", ms: 8000 });
    } finally {
      setBusy(null);
    }
  };

  /** Swap the delete sheet for the transfer sheet once the first one has given back its history entry. */
  const switchToTransfer = () => {
    setSheet(null);
    let done = false;
    const next = () => {
      if (done) return;
      done = true;
      removeEventListener("popstate", next);
      open("transfer");
    };
    addEventListener("popstate", next);
    setTimeout(next, 600);
  };

  // Leaving the panel during the 5 seconds still deletes: the person confirmed it.
  const confirmDelete = () => {
    setSheet(null);
    setPending(true);
    cancelled.current = false;
    toast.show("Room deleted", {
      ms: UNDO_MS,
      action: {
        label: "Undo",
        onClick: () => {
          cancelled.current = true;
          clearTimeout(timer.current);
          setPending(false);
          toast.show("Not deleted. Nothing was sent.", { tone: "info" });
        },
      },
    });
    timer.current = setTimeout(() => {
      if (!cancelled.current) void runDelete();
    }, UNDO_MS);
  };

  return (
    <section className={s.bottom} aria-label="Leave or delete">
      {pending ? (
        <div className={s.pending} role="status">
          <b>{busy ?? "Deleting in 5 seconds"}</b>
          <span>
            {busy
              ? "Removing the sealed messages from storage for everyone."
              : "Nothing has been sent yet. Tap Undo on the notice to keep the room."}
          </span>
          {busy ? null : (
            <div className={s.countdown} aria-hidden="true">
              <span />
            </div>
          )}
          {busy ? null : (
            <Button
              variant="line"
              size="sm"
              icon="undo"
              onClick={() => {
                cancelled.current = true;
                clearTimeout(timer.current);
                setPending(false);
                toast.show("Not deleted. Nothing was sent.", { tone: "info" });
              }}
            >
              Undo
            </Button>
          )}
        </div>
      ) : null}
      {!owner ? (
        <Button variant="danger" icon="logout" full onClick={() => open("leave")} disabled={pending}>
          Leave room
        </Button>
      ) : (
        <>
          <Button variant="line" icon="key" full onClick={() => open("transfer")} disabled={pending}>
            Transfer ownership
          </Button>
          <Button variant="danger" icon="trash" full onClick={() => open("delete")} disabled={pending}>
            Delete room
          </Button>
        </>
      )}

      <Sheet open={sheet === "leave"} onClose={close} title="Leave room" dismissable={!busy}>
        <div className={s.sheetBody}>
          <p>
            You stop getting new messages now. The room key changes the next time an admin opens the room. You keep what
            you already saw on this device.
          </p>
          <p className={s.help}>To come back, you need a new invite or an admin to add you.</p>
          <InlineError>{err}</InlineError>
          <div className={s.btnRow}>
            <Button variant="quiet" onClick={close} disabled={!!busy}>
              Cancel
            </Button>
            <Button variant="danger" icon="logout" busy={!!busy} onClick={() => void leave()}>
              {busy ?? "Leave room"}
            </Button>
          </div>
        </div>
      </Sheet>

      <Sheet open={sheet === "transfer"} onClose={close} title="Transfer ownership" dismissable={!busy}>
        <div className={s.sheetBody}>
          <p className={s.consequence}>The new owner can delete the room and choose admins. You become an admin.</p>
          {admins.length === 0 ? (
            <p className={s.help}>
              Ownership goes only to an admin. Make someone an admin first from their row in Members, then come back
              here.
            </p>
          ) : (
            <>
              <div className={s.choiceList} role="radiogroup" aria-label="New owner">
                {admins.map((a) => (
                  <ChoiceCard
                    key={a.address}
                    selected={target === a.address}
                    onSelect={() => setTarget(a.address)}
                    title={label(a.address, names)}
                    detail="Admin"
                    icon={<PersonAvatar address={a.address} names={names} size={34} />}
                    tone="kinari"
                  />
                ))}
              </div>
              <TextField
                label="Type the room name to confirm"
                hint={roomName ? `Type: ${roomName}` : undefined}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={!!busy}
              />
              {!gate.allowed && typed.trim() && target ? <InlineError>{gate.reason}</InlineError> : null}
              <p className={s.help}>QoreChain records the new owner. This needs one transaction from your account.</p>
            </>
          )}
          <InlineError>{err}</InlineError>
          <div className={s.btnRow}>
            <Button variant="quiet" onClick={close} disabled={!!busy}>
              Cancel
            </Button>
            {admins.length > 0 ? (
              <Button variant="cord" icon="key" busy={!!busy} disabled={!gate.allowed} onClick={() => void transfer()}>
                {busy ?? "Transfer ownership"}
              </Button>
            ) : null}
          </div>
        </div>
      </Sheet>

      <Sheet open={sheet === "delete"} onClose={close} title="Delete room">
        <div className={s.sheetBody}>
          <p>Are you sure you want to delete this room?</p>
          <p className={s.help}>
            Deleting removes the sealed messages and files from storage for everyone and records the close on QoreChain.
            Copies members already opened stay on their devices.
          </p>
          <label className={s.checkRow}>
            <input type="checkbox" checked={forAll} onChange={(e) => setForAll(e.target.checked)} />
            <span>Delete the room for all members</span>
          </label>
          {!forAll ? (
            <p className={s.consequence}>
              As the owner you cannot just leave. Transfer the room to an admin first and then leave, or tick the box to
              delete it for everyone.
            </p>
          ) : null}
          <div className={s.btnRow}>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
            {!forAll ? (
              <Button variant="line" icon="key" onClick={switchToTransfer}>
                Transfer instead
              </Button>
            ) : (
              <Button variant="danger" icon="trash" onClick={confirmDelete}>
                Delete room
              </Button>
            )}
          </div>
        </div>
      </Sheet>
    </section>
  );
}
