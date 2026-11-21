"use client";
/** Public "Check a document": hash a file here, or paste a fingerprint, then open its certificate. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Musubi, TextField, Wordmark, Kicker } from "@mizuhiki/ui";
import { HashDrop } from "./HashDrop";
import { certificatePath } from "./proof";
import s from "./proof.module.css";

export function CheckDocument() {
  const router = useRouter();
  const [paste, setPaste] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className={s.stage}>
      <header className={s.bar0}>
        <Wordmark size={22} href="/" />
      </header>
      <main className={s.cert}>
        <div className={s.card}>
          <Musubi face="normal" size={100} />
          <Kicker>しらべる</Kicker>
          <h1>Was this document anchored on QoreChain?</h1>
          <p className={s.muted}>
            Drop the file and this page works out its fingerprint here, then reads the anchor straight from QoreChain.
          </p>
          <HashDrop label="Drop a file to check" onHashed={(h) => router.push(certificatePath(h.hash))} />
          <form
            className={s.pasteRow}
            onSubmit={(e) => {
              e.preventDefault();
              const h = paste.trim().toLowerCase().replace(/^0x/, "");
              if (!/^[0-9a-f]{64}$/.test(h)) {
                setErr("A fingerprint is 64 letters and numbers (0-9, a-f).");
                return;
              }
              router.push(certificatePath(h));
            }}
          >
            <TextField
              label="Or paste a fingerprint (SHA-256)"
              value={paste}
              onChange={(e) => {
                setPaste(e.target.value);
                setErr(null);
              }}
              error={err ?? undefined}
              spellCheck={false}
              autoComplete="off"
            />
            <Button type="submit" variant="line">
              Look it up
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
