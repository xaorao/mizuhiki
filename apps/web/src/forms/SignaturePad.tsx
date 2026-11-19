"use client";
/** Draw a signature with a finger, pen or mouse; it becomes a PNG that is sealed like any file. */
import { useEffect, useRef, useState } from "react";
import { Button, Icon } from "@mizuhiki/ui";
import s from "./runner.module.css";

export function SignaturePad({ onChange, has }: { onChange: (png: File | null) => void; has: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [inked, setInked] = useState(has);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ratio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.6;
    ctx.strokeStyle = "#2b2340";
  }, []);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const finish = () => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    canvas.current?.toBlob((b) => {
      if (b) onChange(new File([b], "signature.png", { type: "image/png" }));
    }, "image/png");
  };

  return (
    <div className={s.sig}>
      <canvas
        ref={canvas}
        className={s.sigCanvas}
        aria-label="Signature area. Draw your signature here."
        role="img"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drawing.current = true;
          last.current = point(e);
          setInked(true);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const ctx = e.currentTarget.getContext("2d");
          const p = point(e);
          if (ctx && last.current) {
            ctx.beginPath();
            ctx.moveTo(last.current.x, last.current.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
          }
          last.current = p;
        }}
        onPointerUp={finish}
        onPointerLeave={finish}
      />
      <div className={s.sigRow}>
        <span className={s.hint}>
          <Icon name="pen" size={13} />{" "}
          {inked ? "Signed. It is encrypted with your answers." : "Sign above with your finger or mouse."}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const c = canvas.current;
            c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
            setInked(false);
            onChange(null);
          }}
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
