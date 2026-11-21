"use client";
/** Drop or pick a file; it is hashed on this device (never uploaded). */
import { useRef, useState } from "react";
import { Icon } from "@mizuhiki/ui";
import { sha256File } from "@mizuhiki/core";
import s from "./proof.module.css";

export interface Hashed {
  hash: string;
  file: { name: string; size: number; type: string };
}

export function HashDrop({
  onHashed,
  label,
  compact = false,
}: {
  onHashed: (h: Hashed) => void;
  label: string;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const take = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    setProgress(0);
    try {
      const hash = await sha256File(f, (d, t) => setProgress(t ? d / t : 1));
      onHashed({ hash, file: { name: f.name, size: f.size, type: f.type } });
    } catch {
      setError("This file could not be read here. Nothing left your device.");
    } finally {
      setProgress(null);
    }
  };

  return (
    <div className={s.dropWrap}>
      <button
        type="button"
        className={[s.drop, compact ? s.dropCompact : "", drag ? s.dropOn : ""].join(" ")}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void take(e.dataTransfer.files[0]);
        }}
        disabled={progress !== null}
        aria-describedby="hashdrop-note"
      >
        {progress !== null ? (
          <>
            <span className={s.bar} style={{ ["--p" as string]: `${Math.round(progress * 100)}%` }} />
            Hashing on this device… {Math.round(progress * 100)}%
          </>
        ) : (
          <>
            <Icon name="upload" size={20} />
            {label}
          </>
        )}
      </button>
      <p id="hashdrop-note" className={s.dropNote}>
        <Icon name="lock" size={13} /> The file stays on this device. Only its fingerprint (SHA-256) is used.
      </p>
      {error ? <p className={s.err}>{error}</p> : null}
      <input
        ref={input}
        type="file"
        hidden
        aria-label={label}
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
