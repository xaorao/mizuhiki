"use client";
/**
 * Read with an offline key (spec 5.13): the 24 words from the offline reader
 * sheet open the server's challenge, which unlocks the list of the owner's
 * items; each is opened in this browser with that key. Nothing is stored here
 * and nothing can be changed.
 */
import { useState } from "react";
import { Button, EmptyState, Kicker, LockLine, Musubi, Oops, Sheet, TextField, Wordmark } from "@mizuhiki/ui";
import { Purpose, fromUtf8, openItem } from "@mizuhiki/core";
import type { InvoiceDoc } from "@/invoices/model";
import { api } from "@/lib/api";
import { openRowWith, parseOpened, purposeFor } from "@/inbox/model";
import { ItemBody, ItemRow, titleOf } from "@/passes/PassDetail";
import type { PassItem } from "@/passes/engine";
import { personProblem } from "@/passes/model";
import { offlineItems } from "./engine";
import p from "@/passes/passes.module.css";
import s from "./recovery.module.css";
import { failureText } from "@/lib/failure";

export function OfflineReader() {
  const [who, setWho] = useState("");
  const [words, setWords] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [items, setItems] = useState<PassItem[] | null>(null);
  const [open, setOpen] = useState<PassItem | null>(null);

  const read = async () => {
    const problem = personProblem(who);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    try {
      const { keys, list } = await offlineItems(who, words);
      const out: PassItem[] = [];
      const copied = new Set<string>();
      for (const c of list.copies) {
        copied.add(c.source);
        try {
          const body = JSON.parse(
            fromUtf8(
              openItem({
                purpose: Purpose.offlineCopy,
                envelope: await api.bytes(`/blobs/${c.envelope}`),
                keys,
                context: c.source,
              }),
            ),
          ) as { kind: string; ref: string | null; at: string; item: unknown };
          out.push(
            body.kind === "invoice"
              ? { source: c.source, kind: "invoice", at: body.at, doc: body.item as InvoiceDoc }
              : {
                  source: c.source,
                  kind: body.kind,
                  at: body.at,
                  opened: parseOpened(
                    { kind: body.kind, ref: body.ref, at: body.at },
                    purposeFor({ kind: body.kind, ref: body.ref }) ?? "",
                    new TextEncoder().encode(JSON.stringify(body.item)),
                  ),
                },
          );
        } catch {
          out.push({ source: c.source, kind: c.kind, at: c.at, error: "This copy does not open with these words." });
        }
      }
      for (const l of list.live) {
        if (copied.has(l.source)) continue;
        try {
          out.push({
            source: l.source,
            kind: l.kind,
            at: l.at,
            opened: await openRowWith(keys, { kind: l.kind, ref: l.ref, envelope: l.envelope, at: l.at }),
          });
        } catch {
          // Sealed before the offline reader existed and not copied to it: not readable with this key.
        }
      }
      setOwner(list.owner);
      setItems(out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
    } catch (e) {
      setErr(failureText(e, "Nothing could be opened."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={s.shell}>
      <main className={s.card}>
        <Wordmark size={20} href="/" />
        {items && owner ? (
          <>
            <Kicker>よみとり</Kicker>
            <h1>Read with your offline key</h1>
            <p>
              {items.length} {items.length === 1 ? "item opens" : "items open"} with this key. Items from before the
              offline reader was made open only if they were sealed to it later.
            </p>
            {items.length === 0 ? (
              <EmptyState title="Nothing sealed to this key yet" face="sleepy" />
            ) : (
              <ul className={p.items}>
                {items.map((it) => (
                  <li key={it.source}>
                    <ItemRow it={it} onOpen={() => setOpen(it)} />
                  </li>
                ))}
              </ul>
            )}
            <LockLine>Opened in this browser only. Close the tab and nothing stays here.</LockLine>
            <Sheet open={open !== null} onClose={() => setOpen(null)} title={open ? titleOf(open) : ""} wide>
              {open ? <ItemBody it={open} owner={owner} /> : null}
            </Sheet>
          </>
        ) : (
          <form
            className={p.form}
            onSubmit={(e) => {
              e.preventDefault();
              void read();
            }}
          >
            <Musubi face="normal" size={96} />
            <Kicker>よみとり</Kicker>
            <h1>Read with an offline key</h1>
            <p>
              Type the @name and the 24 words from an offline reader sheet. Items sealed to that key open here. It
              cannot sign in, pay or change anything.
            </p>
            <TextField
              label="Their @name or address"
              placeholder="@yourname"
              value={who}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setWho(e.target.value)}
            />
            <label className={p.legend} htmlFor="offline-words">
              Offline reader key (24 words)
            </label>
            <textarea
              id="offline-words"
              className={s.wordsBox}
              rows={4}
              value={words}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => setWords(e.target.value)}
              placeholder="word word word …"
            />
            {err ? <Oops title="Not opened">{err}</Oops> : null}
            <Button
              type="submit"
              variant="cord"
              size="lg"
              full
              busy={busy}
              disabled={!who || words.trim().split(/\s+/).length < 24}
            >
              Open what it can read
            </Button>
            <LockLine>
              The words never leave this browser. Mizuhiki checks you hold the key by sending a sealed question only it
              can open.
            </LockLine>
          </form>
        )}
      </main>
    </div>
  );
}
