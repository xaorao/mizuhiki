"use client";
/**
 * "Try it" (spec 5.1 section 7): the real QoreSeal library seals the text in
 * this browser, exactly as a visitor's message is sealed (ML-KEM-1024 key
 * wrap, AES-256-GCM content, no recipient hints). A key made here stands in
 * for the page owner's key, so the visitor can also open it, and see a
 * different key fail. Nothing is sent anywhere.
 */
import { useRef, useState } from "react";
import { Musubi, useMusubi, burstFrom, Icon } from "@mizuhiki/ui";
import s from "./landing.module.css";

type Sealed = { envelope: Uint8Array; hash: string; b64: string; ms: number };
type Opened = { ok: true; text: string } | { ok: false };

const SAMPLE = "My passport number is on page 2. Please don't share it.";

export function TrySeal() {
  const [text, setText] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [sealed, setSealed] = useState<Sealed | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const keys = useRef<unknown>(null);
  const musubi = useMusubi("normal");
  const btn = useRef<HTMLButtonElement>(null);

  const seal = async () => {
    setErr(null);
    setOpened(null);
    if (!text.trim()) {
      setSealed(null);
      musubi.react("worried", 1600);
      setErr("Write something first. Nothing has left your browser.");
      return;
    }
    setBusy(true);
    musubi.set("cover");
    try {
      const core = await import("@mizuhiki/core");
      const k = core.linkKeys(core.newLinkSeed());
      keys.current = k;
      const t0 = performance.now();
      const out = core.sealItem({
        purpose: core.Purpose.message,
        readers: [core.publicRecipient(k)],
        plaintext: core.utf8(text),
      });
      setSealed({
        envelope: out.envelope,
        hash: out.hash,
        b64: core.toBase64Url(out.envelope),
        ms: performance.now() - t0,
      });
      musubi.react("happy", 1600);
      burstFrom(btn.current);
    } catch {
      musubi.react("worried", 1600);
      setErr("This browser could not seal it. Nothing left your browser.");
    } finally {
      setBusy(false);
    }
  };

  const open = async (right: boolean) => {
    if (!sealed) return;
    const core = await import("@mizuhiki/core");
    const k = right ? (keys.current as ReturnType<typeof core.linkKeys>) : core.linkKeys(core.newLinkSeed());
    try {
      const plain = core.openItem({ purpose: core.Purpose.message, envelope: sealed.envelope, keys: k });
      setOpened({ ok: true, text: new TextDecoder().decode(plain) });
      musubi.react("wink", 1200);
    } catch {
      setOpened({ ok: false });
      musubi.react("worried", 1400);
    }
  };

  return (
    <div className={s.trybox}>
      <div className={s.tb}>
        <h3>
          <Icon name="pen" size={20} />
          Try it: write something private
        </h3>
        <label htmlFor="try-text" className="sr-only">
          Your message
        </label>
        <textarea id="try-text" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} />
        <div className={s.tbRow}>
          <button ref={btn} className={s.btnCord} type="button" onClick={() => void seal()} disabled={busy}>
            <Icon name="lock" size={18} />
            {busy ? "Sealing…" : "Seal it in this browser"}
          </button>
          <Musubi face={musubi.face} hopKey={musubi.hopKey} size={64} className={s.tryMusubi} />
        </div>
        {err ? (
          <p className={s.tbErr} role="alert">
            あれ？ {err}
          </p>
        ) : null}
        <small>
          Sealed with QoreSeal, the same library that seals every message on Mizuhiki: ML-KEM-1024 wraps the key,
          AES-256-GCM locks the words. A key made just now in this browser stands in for the page owner&rsquo;s.
        </small>
      </div>
      <div className={s.tb}>
        <h3>
          <Icon name="eye" size={20} />
          What our server would store
        </h3>
        <div className={[s.cipher, sealed ? "" : s.cipherEmpty].join(" ")} aria-live="polite">
          {sealed
            ? sealed.b64.slice(0, 900) + (sealed.b64.length > 900 ? "…" : "")
            : "Nothing yet. Seal your note and the sealed copy appears here."}
        </div>
        {sealed ? (
          <>
            <dl className={s.facts}>
              <div>
                <dt>Size</dt>
                <dd>{sealed.envelope.length.toLocaleString("en-US")} bytes</dd>
              </div>
              <div>
                <dt>Sealed in</dt>
                <dd>{sealed.ms < 1 ? "under 1" : Math.round(sealed.ms)} ms</dd>
              </div>
              <div>
                <dt>Fingerprint</dt>
                <dd className={s.mono}>{sealed.hash.slice(0, 16)}…</dd>
              </div>
            </dl>
            <div className={s.tbRow}>
              <button className={s.btnLine} type="button" onClick={() => void open(true)}>
                <Icon name="key" size={18} />
                Open with the owner&rsquo;s key
              </button>
              <button className={s.btnQuiet} type="button" onClick={() => void open(false)}>
                Try a different key
              </button>
            </div>
            {opened ? (
              opened.ok ? (
                <p className={s.tbOk} role="status">
                  <Icon name="check" size={16} /> Opened: &ldquo;{opened.text}&rdquo; できた！
                </p>
              ) : (
                <p className={s.tbErr} role="status">
                  That key cannot open it. Without the owner&rsquo;s key, this is all anyone gets.
                </p>
              )
            ) : null}
          </>
        ) : (
          <small>This is all anyone without the key gets: the size and the time, never the words.</small>
        )}
      </div>
    </div>
  );
}
