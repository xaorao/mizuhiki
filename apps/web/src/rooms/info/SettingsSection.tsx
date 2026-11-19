"use client";
/**
 * Room settings: approval, what invited people see, auto-delete and the
 * "ask members not to save" request. Admins edit; everyone else reads a summary.
 */
import { useState } from "react";
import { Button, ToggleRow, useToast } from "@mizuhiki/ui";
import { Pills } from "./Pills";
import { saveSettings } from "../engine";
import type { RoomState } from "../useRoom";
import { AUTO_PRESETS, autoDeleteChoice, autoDeleteText, customSeconds, isAdminRole, splitCustom, type AutoChoice, type CustomUnit } from "./model";
import { InlineError } from "./Progress";
import s from "./info.module.css";

interface Draft {
  approval: boolean;
  historyDefault: "share" | "hide";
  auto: AutoChoice;
  amount: string;
  unit: CustomUnit;
  restrictSaving: boolean;
}

export function SettingsSection({ room }: { room: RoomState }) {
  const toast = useToast();
  const info = room.derived?.info;
  const admin = isAdminRole(room.detail?.me);
  const [edit, setEdit] = useState<{ base: string; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // An edit made against older settings (another admin changed them meanwhile) is dropped.
  const key = info ? `${info.approval}:${info.historyDefault}:${info.autoDeleteSeconds}:${info.restrictSaving}` : "";
  const draft = edit && edit.base === key ? edit.draft : null;
  const setDraft = (next: Draft | null) => setEdit(next ? { base: key, draft: next } : null);

  if (!info) return null;
  const d: Draft = draft ?? {
    approval: info.approval,
    historyDefault: info.historyDefault,
    auto: autoDeleteChoice(info.autoDeleteSeconds),
    ...splitCustom(info.autoDeleteSeconds),
    restrictSaving: info.restrictSaving,
  };
  const set = (p: Partial<Draft>) => {
    setErr(null);
    setDraft({ ...d, ...p });
  };

  const custom = d.auto === "custom" ? customSeconds(d.amount, d.unit) : null;
  const seconds = d.auto === "custom" ? (custom && "seconds" in custom ? custom.seconds : null) : (AUTO_PRESETS.find((p) => p.value === d.auto)?.seconds ?? 0);
  const dirty =
    !!draft && (d.approval !== info.approval || d.historyDefault !== info.historyDefault || d.restrictSaving !== info.restrictSaving || seconds !== info.autoDeleteSeconds);

  const save = async () => {
    if (!room.detail || seconds === null) return;
    setBusy(true);
    setErr(null);
    try {
      await saveSettings(await room.acct(), room.detail.id, { approval: d.approval, autoDeleteSeconds: seconds, restrictSaving: d.restrictSaving, historyDefault: d.historyDefault });
      toast.show("Settings saved. The room was told.");
      setDraft(null);
      void room.reload();
    } catch (e) {
      setErr(`Not saved. The room keeps its old settings. ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!admin)
    return (
      <section className={s.card} aria-label="Room settings">
        <div className={s.cardHead}>
          <h3>Room settings</h3>
          <small>Set by admins</small>
        </div>
        <dl className={s.summary}>
          <div>
            <dt>Approve new members</dt>
            <dd>{info.approval ? "On" : "Off"}</dd>
          </div>
          <div>
            <dt>New members see</dt>
            <dd>{info.historyDefault === "share" ? "Past messages" : "Only new messages"}</dd>
          </div>
          <div>
            <dt>Auto-delete new messages</dt>
            <dd>{autoDeleteText(info.autoDeleteSeconds)}</dd>
          </div>
          <div>
            <dt>Ask members not to save</dt>
            <dd>{info.restrictSaving ? "On" : "Off"}</dd>
          </div>
        </dl>
        {info.restrictSaving ? <p className={s.help}>The admins ask you not to save or forward what is said here.</p> : null}
      </section>
    );

  return (
    <section className={s.card} aria-label="Room settings">
      <div className={s.cardHead}>
        <h3>Room settings</h3>
        <small>Admins</small>
      </div>
      <div className={s.settingList}>
        <div className={s.settingBlock}>
          <ToggleRow
            title="Approve new members"
            detail="The room key is sealed to someone only after an admin approves them."
            checked={d.approval}
            onChange={(v) => set({ approval: v })}
            disabled={busy}
          />
          {!d.approval ? <p className={s.help}>People with an invite link join without waiting; the next admin device that opens the room seals the key to them.</p> : null}
        </div>
        <div className={s.settingBlock}>
          <b>New members see</b>
          <Pills
            label="New members see"
            value={d.historyDefault}
            onChange={(v) => set({ historyDefault: v })}
            options={[
              { value: "share", label: "Past messages" },
              { value: "hide", label: "Only new messages" },
            ]}
          />
          <p className={s.help}>Used when invites join automatically. When you approve someone, you choose for that person.</p>
        </div>
        <div className={s.settingBlock}>
          <b>Auto-delete</b>
          <p className={s.help}>Automatically delete new messages after…</p>
          <Pills
            label="Auto-delete new messages after"
            value={d.auto}
            onChange={(v) => set({ auto: v })}
            options={[...AUTO_PRESETS.map((p) => ({ value: p.value, label: p.label })), { value: "custom" as const, label: "Custom" }]}
          />
          {d.auto === "custom" ? (
            <div className={s.customRow}>
              <label>
                <span className="sr-only">Amount</span>
                <input
                  inputMode="numeric"
                  value={d.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                  aria-invalid={custom && "error" in custom ? true : undefined}
                  className={s.numInput}
                />
              </label>
              <Pills
                label="Unit"
                value={d.unit}
                onChange={(v) => set({ unit: v })}
                options={[
                  { value: "hours", label: "Hours" },
                  { value: "days", label: "Days" },
                  { value: "weeks", label: "Weeks" },
                ]}
              />
            </div>
          ) : null}
          {custom && "error" in custom ? <InlineError>{custom.error}</InlineError> : null}
          <p className={s.help}>
            Applies to new messages only. It deletes the sealed copy from storage, not copies members already opened on their devices.
          </p>
        </div>
        <div className={s.settingBlock}>
          <ToggleRow
            title="Ask members not to save"
            detail="A request, not a lock: anyone who can read a message can still screenshot it."
            checked={d.restrictSaving}
            onChange={(v) => set({ restrictSaving: v })}
            disabled={busy}
          />
        </div>
      </div>
      <InlineError>{err}</InlineError>
      {dirty ? (
        <div className={s.saveBar}>
          <Button variant="quiet" onClick={() => setDraft(null)} disabled={busy}>
            Undo changes
          </Button>
          <Button variant="cord" icon="check" busy={busy} disabled={seconds === null} onClick={() => void save()}>
            {busy ? "Saving…" : "Save settings"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
