"use client";
/** Choose a photo, drag to place it, zoom, and get a 512 px square WebP. Done in the browser. */
import { useEffect, useRef, useState } from "react";
import { Button } from "@mizuhiki/ui";
import s from "./onboarding.module.css";

export function AvatarCrop({
  file,
  onDone,
  onCancel,
}: {
  file: File;
  onDone: (blob: Blob) => void;
  onCancel: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => setImg(i);
    i.onerror = () => setError("This file is not an image we can read. Try a PNG, JPEG or WebP.");
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !img) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const S = c.width;
    const base = Math.max(S / img.width, S / img.height) * zoom;
    const w = img.width * base;
    const h = img.height * base;
    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(img, (S - w) / 2 + off.x, (S - h) / 2 + off.y, w, h);
  }, [img, zoom, off]);

  const save = () => {
    canvas.current?.toBlob(
      (b) => (b ? onDone(b) : setError("Could not make the image. Try another photo.")),
      "image/webp",
      0.9,
    );
  };

  return (
    <div className={s.crop}>
      {error ? <p className={s.err}>{error}</p> : null}
      <div className={s.cropStage}>
        <canvas
          ref={canvas}
          width={512}
          height={512}
          className={s.cropCanvas}
          aria-label="Drag to place your photo"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            const k = 512 / (e.currentTarget.getBoundingClientRect().width || 512);
            setOff({ x: d.ox + (e.clientX - d.x) * k, y: d.oy + (e.clientY - d.y) * k });
          }}
          onPointerUp={() => (drag.current = null)}
        />
      </div>
      <label className={s.zoom}>
        Zoom
        <input
          type="range"
          min={1}
          max={3}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
        />
      </label>
      <div className={s.actions}>
        <Button
          variant="ghost"
          onClick={() => {
            setZoom(1);
            setOff({ x: 0, y: 0 });
          }}
        >
          Reset
        </Button>
        <Button variant="line" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="cord" onClick={save} disabled={!img}>
          Use this photo
        </Button>
      </div>
    </div>
  );
}
