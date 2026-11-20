"use client";
/**
 * Files tab (Telegram Shared Media, WhatsApp "Media, links, and docs"): every
 * file shared in the room, with filters. Photos are unsealed on this device for
 * their thumbnails; anything opens or saves after unsealing here.
 */
import { useState, type CSSProperties } from "react";
import { Button, EmptyState, Icon, Sheet, type IconName } from "@mizuhiki/ui";
import { decryptFile } from "@mizuhiki/core";
import { api } from "@/lib/api";
import type { SharedFile } from "../derive";
import { fmtBytes, label, useSealedPhoto } from "../people";
import { FILE_FILTERS, filterFiles, whenLabel, type FileFilter } from "./model";
import { InlineError } from "./Progress";
import s from "./info.module.css";
import { failureText } from "@/lib/failure";

const KIND_ICON: Record<SharedFile["kind"], IconName> = { photo: "image", video: "file", audio: "file", doc: "file" };
const KIND_WORD: Record<SharedFile["kind"], string> = { photo: "Photo", video: "Video", audio: "Audio", doc: "File" };
const EMPTY: Record<FileFilter, string> = {
  all: "No files yet",
  photo: "No photos yet",
  video: "No videos yet",
  doc: "No documents yet",
  audio: "No audio yet",
};

function PhotoTile({ f, onOpen, i }: { f: SharedFile; onOpen: () => void; i: number }) {
  const src = useSealedPhoto(f.facts);
  return (
    <li style={{ "--i": Math.min(i, 18) } as CSSProperties}>
      <button type="button" className={s.fileTile} onClick={onOpen} aria-label={`Open photo ${f.facts.name}`}>
        {src ? <img src={src} alt="" loading="lazy" /> : <span className={s.tileSkel} aria-hidden="true" />}
      </button>
    </li>
  );
}

/** Unseal a shared file on this device and either show it or save it. */
function Viewer({
  f,
  names,
  me,
  onClose,
}: {
  f: SharedFile | null;
  names: Record<string, string | null>;
  me: string;
  onClose: () => void;
}) {
  const photo = useSealedPhoto(f?.kind === "photo" ? f.facts : null);
  const [progress, setProgress] = useState<number | null>(null);
  const [media, setMedia] = useState<{ id: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const unseal = async (): Promise<string | null> => {
    if (!f) return null;
    setErr(null);
    setProgress(0);
    try {
      const parts = await decryptFile({
        facts: f.facts,
        fetchChunk: (h) => api.bytes(`/blobs/${h}`),
        onProgress: (d, t) => setProgress(d / Math.max(1, t)),
      });
      return URL.createObjectURL(new Blob(parts as BlobPart[], { type: f.facts.type || "application/octet-stream" }));
    } catch (e) {
      const gone = /404|not found|expired/i.test((e as Error).message);
      setErr(
        gone
          ? "This file is no longer in storage (it may have been auto-deleted). Nothing was opened."
          : `This file could not be unsealed on this device. Nothing was saved. ${failureText(e, "Try again.")}`,
      );
      return null;
    } finally {
      setProgress(null);
    }
  };

  const save = async () => {
    if (!f) return;
    const url = photo ?? (media?.id === f.key ? media.url : await unseal());
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = f.facts.name;
    a.click();
  };
  const play = async () => {
    if (!f) return;
    const url = await unseal();
    if (url) setMedia({ id: f.key, url });
  };
  const close = () => {
    if (media) URL.revokeObjectURL(media.url);
    setMedia(null);
    setErr(null);
    onClose();
  };

  const busy = progress !== null;
  return (
    <Sheet
      open={!!f}
      onClose={close}
      title={f ? f.facts.name : "File"}
      wide={f?.kind === "photo" || f?.kind === "video"}
    >
      {f ? (
        <div className={s.viewer}>
          {f.kind === "photo" ? (
            photo ? (
              <img src={photo} alt={f.caption || f.facts.name} />
            ) : (
              <span className={s.tileSkel} style={{ height: 240, borderRadius: 18 }} aria-hidden="true" />
            )
          ) : null}
          {f.kind === "video" && media?.id === f.key ? <video src={media.url} controls playsInline /> : null}
          {f.kind === "audio" && media?.id === f.key ? <audio src={media.url} controls /> : null}
          {f.caption ? <p>{f.caption}</p> : null}
          <p className={s.help}>
            {KIND_WORD[f.kind]} · {fmtBytes(f.facts.size)} · shared by {label(f.author, names, me)} ·{" "}
            {whenLabel(f.line.msg?.sentAt ?? f.line.at)}
          </p>
          <p className={s.help}>Unsealed on this device only. Saving puts a readable copy on this device.</p>
          <InlineError>{err}</InlineError>
          <div className={s.btnRow}>
            {(f.kind === "video" || f.kind === "audio") && media?.id !== f.key ? (
              <Button variant="line" icon="eye" busy={busy} onClick={() => void play()}>
                {busy ? `Unsealing ${Math.round(progress * 100)}%` : f.kind === "video" ? "Play" : "Listen"}
              </Button>
            ) : null}
            <Button variant="cord" icon="download" busy={busy} onClick={() => void save()}>
              {busy ? `Unsealing ${Math.round(progress * 100)}%` : "Save to this device"}
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}

export function FilesTab({
  files,
  names,
  me,
}: {
  files: SharedFile[];
  names: Record<string, string | null>;
  me: string;
}) {
  const [filter, setFilter] = useState<FileFilter>("all");
  const [open, setOpen] = useState<SharedFile | null>(null);
  const list = filterFiles(files, filter);
  const photos = list.filter((f) => f.kind === "photo");
  const others = list.filter((f) => f.kind !== "photo");

  return (
    <>
      <div className={s.filters} role="group" aria-label="Show">
        {FILE_FILTERS.map((o) => {
          const n = filterFiles(files, o.value).length;
          return (
            <button key={o.value} type="button" aria-pressed={filter === o.value} onClick={() => setFilter(o.value)}>
              {o.label}
              {n > 0 ? ` ${n}` : ""}
            </button>
          );
        })}
      </div>
      {list.length === 0 ? (
        <EmptyState title={EMPTY[filter]} face="sleepy">
          Files sent in the chat show up here, sealed to the people in this room.
        </EmptyState>
      ) : (
        <>
          {photos.length > 0 ? (
            <ul className={s.grid} aria-label="Photos">
              {photos.map((f, i) => (
                <PhotoTile key={f.key} f={f} i={i} onOpen={() => setOpen(f)} />
              ))}
            </ul>
          ) : null}
          {others.length > 0 ? (
            <ul className={s.list} aria-label="Files">
              {others.map((f, i) => (
                <li key={f.key} style={{ "--i": Math.min(i, 12) } as CSSProperties}>
                  <button type="button" className={s.fileRow} onClick={() => setOpen(f)}>
                    <span className={[s.fileIcon, s[`fi_${f.kind}`]].join(" ")} aria-hidden="true">
                      <Icon name={KIND_ICON[f.kind]} size={18} />
                    </span>
                    <span className={s.fileText}>
                      <b>{f.facts.name}</b>
                      <small>
                        {fmtBytes(f.facts.size)} · {label(f.author, names, me)} ·{" "}
                        {whenLabel(f.line.msg?.sentAt ?? f.line.at)}
                      </small>
                    </span>
                    <Icon name="download" size={18} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <Viewer f={open} names={names} me={me} onClose={() => setOpen(null)} />
    </>
  );
}
