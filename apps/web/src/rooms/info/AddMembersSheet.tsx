"use client";
/**
 * Add members. Admins add directly (a new room key sealed to everyone, with a
 * history choice per person); members with the "Add members" right suggest
 * people, who then wait for an admin's approval.
 */
import { useState } from "react";
import { Button, IconButton, Sheet, TextField, useToast } from "@mizuhiki/ui";
import { Pills } from "./Pills";
import { changeMembers, lookupPerson, suggestMembers } from "../engine";
import { PersonAvatar, label, useNames } from "../people";
import type { RoomState } from "../useRoom";
import { isAdminRole, parsePerson } from "./model";
import { InlineError, StepList, changeFailure, useSteps } from "./Progress";
import s from "./info.module.css";

type History = "share" | "hide";

export function AddMembersSheet({ room, open, onClose }: { room: RoomState; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [input, setInput] = useState("");
  const [inputErr, setInputErr] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [people, setPeople] = useState<{ address: string; history: History }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const steps = useSteps();
  const names = useNames(people.map((p) => p.address));
  const detail = room.detail;
  const me = detail?.me;
  const admin = isAdminRole(me);
  const historyDefault = room.derived?.info.historyDefault ?? "hide";

  const clear = () => {
    setInput("");
    setInputErr(null);
    setPeople([]);
    setErr(null);
    steps.reset();
  };
  const close = () => {
    if (busy) return;
    clear();
    onClose();
  };

  const find = async () => {
    if (!detail || !me) return;
    setInputErr(null);
    const parsed = parsePerson(input);
    if (parsed.kind === "bad") {
      setInputErr(parsed.error);
      return;
    }
    setFinding(true);
    try {
      const found = await lookupPerson(parsed.kind === "address" ? parsed.address : parsed.name);
      if (!found) {
        setInputErr(parsed.kind === "name" ? `Nobody has @${parsed.name}. Check the spelling.` : "That address has no Mizuhiki account yet.");
        return;
      }
      if (found.address === me.address) {
        setInputErr("That is you. You are in the room already.");
        return;
      }
      const row = detail.members.find((m) => m.address === found.address);
      if (row?.status === "active") {
        setInputErr(`${found.name ? `@${found.name}` : "They"} are in the room already.`);
        return;
      }
      if (row?.status === "blocked") {
        setInputErr(`${found.name ? `@${found.name}` : "They"} are blocked. Unblock them under Removed people first.`);
        return;
      }
      setPeople((cur) => (cur.some((p) => p.address === found.address) ? cur : [...cur, { address: found.address, history: historyDefault }]));
      setInput("");
    } catch (e) {
      setInputErr(`That person could not be looked up. ${(e as Error).message}`);
    } finally {
      setFinding(false);
    }
  };

  const submit = async () => {
    if (!detail || people.length === 0) return;
    setBusy(true);
    setErr(null);
    steps.reset();
    try {
      const a = await room.acct();
      if (admin) {
        await changeMembers(a, detail.id, { add: people, reason: "added" }, steps.onStep);
        toast.show(people.length === 1 ? `${label(people[0]?.address ?? "", names)} is in. Room key changed.` : `${people.length} people are in. Room key changed.`);
      } else {
        await suggestMembers(a, detail.id, people.map((p) => p.address));
        toast.show(people.length === 1 ? "Suggested. An admin lets them in." : `${people.length} people suggested. An admin lets them in.`);
      }
      setBusy(false);
      clear();
      onClose();
      void room.reload();
    } catch (e) {
      setErr(admin ? changeFailure(e, steps.at) : `Nobody was suggested. ${(e as Error).message}`);
      setBusy(false);
      void room.reload();
    }
  };

  return (
    <Sheet open={open} onClose={close} title={admin ? "Add members" : "Suggest members"} dismissable={!busy}>
      <div className={s.sheetBody}>
        <p className={s.help}>
          {admin
            ? "They get the room key as soon as you add them. Choose for each person whether they can read what was said before."
            : "An admin approves each person before the room key is sealed to them."}
        </p>
        <form
          className={s.addLine}
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <TextField
            label="@name or address"
            placeholder="@ana or qor1…"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setInputErr(null);
            }}
            error={inputErr}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
          />
          <Button type="submit" variant="line" icon="plus" busy={finding} disabled={busy || !input.trim()}>
            {finding ? "Finding…" : "Add"}
          </Button>
        </form>

        {people.length > 0 ? (
          <div className={s.choiceList}>
            {people.map((p) => (
              <div key={p.address} className={s.histRow}>
                <div className={s.histHead}>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
                    <PersonAvatar address={p.address} names={names} size={30} />
                    <b>{label(p.address, names)}</b>
                  </span>
                  <IconButton icon="x" label={`Take ${label(p.address, names)} off the list`} size="sm" disabled={busy} onClick={() => setPeople((cur) => cur.filter((x) => x.address !== p.address))} />
                </div>
                {admin ? (
                  <>
                    <Pills
                      label={`What ${label(p.address, names)} can read`}
                      value={p.history}
                      onChange={(h) => setPeople((cur) => cur.map((x) => (x.address === p.address ? { ...x, history: h } : x)))}
                      options={[
                        { value: "share", label: "Share past messages" },
                        { value: "hide", label: "Only new messages" },
                      ]}
                    />
                    <small className={s.help}>
                      {p.history === "share"
                        ? "The older room keys are sealed to them, so they can read everything before today."
                        : "They cannot open anything sent before they joined."}
                    </small>
                  </>
                ) : null}
              </div>
            ))}
            {admin ? <p className={s.consequence}>It cannot be undone: past messages are sealed to them or never shared.</p> : null}
          </div>
        ) : null}

        <StepList at={busy && admin ? steps.at : null} />
        <InlineError>{err}</InlineError>
        <div className={s.btnRow}>
          <Button variant="quiet" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="cord" icon="users" busy={busy} disabled={people.length === 0} onClick={() => void submit()}>
            {busy ? (admin ? "Changing the room key…" : "Suggesting…") : admin ? (people.length > 1 ? `Add ${people.length} people` : "Add to room") : "Suggest"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
