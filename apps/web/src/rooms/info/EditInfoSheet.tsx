"use client";
/**
 * Edit room info: name, description, photo and type. The new info travels as a
 * signed message inside the room; the photo is sealed on this device first and
 * its key travels only inside the room.
 */
import { useEffect, useRef, useState } from "react";
import { Avatar, Button, ChoiceCard, Sheet, TextArea, TextField, useToast } from "@mizuhiki/ui";
import { ROOM_TEMPLATES, ROOM_TYPES, type RoomType } from "@mizuhiki/core";
import { saveInfo, sealRoomFile } from "../engine";
import { RoomAvatar, toneOf } from "../people";
import type { RoomState } from "../useRoom";
import { InlineError } from "./Progress";
import s from "./info.module.css";

const MAX_PHOTO = 8 * 1024 * 1024;

export function EditInfoSheet({ room, open, onClose }: { room: RoomState; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const info = room.derived?.info;
  const roomId = room.detail?.id ?? "";
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<RoomType>("team");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [nameErr, setNameErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !info) return;
    setName(info.name);
    setDescription(info.description);
    setType(info.type);
    setPhoto(null);
    setErr(null);
    setNameErr(null);
    // Prefill only when the sheet opens, not on every live update while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!photo) {
      setPreview(null);
      return;
    }
    const u = URL.createObjectURL(photo);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [photo]);

  if (!info) return null;

  const dirty = name.trim() !== info.name || description.trim() !== info.description || type !== info.type || !!photo;

  const pick = (f: File | undefined) => {
    setErr(null);
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setErr("Pick an image file (JPG, PNG, WebP or GIF).");
      return;
    }
    if (f.size > MAX_PHOTO) {
      setErr("That photo is bigger than 8 MB. Pick a smaller one.");
      return;
    }
    setPhoto(f);
  };

  const save = async () => {
    if (!name.trim()) {
      setNameErr("Give the room a name.");
      return;
    }
    setErr(null);
    try {
      const a = await room.acct();
      let facts = info.photo ?? undefined;
      if (photo) {
        setBusy("Sealing the photo on this device…");
        facts = await sealRoomFile(a, photo, (p) => setBusy(`Sealing the photo on this device… ${Math.round(p * 100)}%`));
      }
      setBusy("Sending the new info to the room…");
      await saveInfo(a, roomId, { name, description, type, photo: facts });
      toast.show("Room info saved.");
      setBusy(null);
      onClose();
      void room.reload();
    } catch (e) {
      setErr(`Not saved. The room still shows its old info. ${(e as Error).message}`);
      setBusy(null);
    }
  };

  return (
    <Sheet open={open} onClose={() => (busy ? undefined : onClose())} title="Edit room info" dismissable={!busy}>
      <div className={s.sheetBody}>
        <div className={s.photoPick}>
          {preview ? <Avatar name={name || "Room"} src={preview} size={72} tone={toneOf(roomId)} /> : <RoomAvatar name={name} photo={info.photo} roomId={roomId} size={72} />}
          <div style={{ display: "grid", gap: 6, justifyItems: "start" }}>
            <input ref={fileRef} type="file" accept="image/*" aria-label="Room photo" onChange={(e) => pick(e.target.files?.[0])} />
            <Button variant="line" size="sm" icon="image" onClick={() => fileRef.current?.click()} disabled={!!busy}>
              {info.photo || photo ? "Change photo" : "Add a photo"}
            </Button>
            <small className={s.help}>Sealed before upload. Only room members can see it.</small>
          </div>
        </div>
        <TextField
          label="Room name"
          value={name}
          maxLength={80}
          counter
          error={nameErr}
          onChange={(e) => {
            setName(e.target.value);
            setNameErr(null);
          }}
          disabled={!!busy}
        />
        <TextArea
          label="Description"
          value={description}
          maxLength={500}
          counter
          rows={3}
          hint="Members and people with an invite link can read it."
          onChange={(e) => setDescription(e.target.value)}
          disabled={!!busy}
        />
        <div className={s.choiceList}>
          <span className={s.fieldLabel} id="room-type-label">
            Type
          </span>
          <div className={s.typeGrid} role="radiogroup" aria-labelledby="room-type-label">
            {ROOM_TYPES.map((t) => (
              <ChoiceCard key={t} selected={type === t} onSelect={() => setType(t)} title={ROOM_TEMPLATES[t].label} tone={t === "deal" ? "sora" : t === "payroll" ? "butter" : t === "team" ? "matcha" : "sakura"} />
            ))}
          </div>
          <small className={s.help}>The type is a label. It does not change who can read or the settings below.</small>
        </div>
        {busy ? (
          <p className={s.help} aria-live="polite">
            {busy}
          </p>
        ) : null}
        <InlineError>{err}</InlineError>
        <div className={s.btnRow}>
          <Button variant="quiet" onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button variant="cord" icon="check" busy={!!busy} disabled={!dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
