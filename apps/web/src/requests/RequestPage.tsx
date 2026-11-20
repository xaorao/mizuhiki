"use client";
/**
 * A file request at /@name/r/<id> (spec 5.7, Dropbox's request page). Before
 * showing anything to upload to, this browser checks the request and the page
 * are signed by the account that owns the name, against its ML-DSA key on
 * QoreChain. One drop zone; no account; the uploader never sees anyone else's
 * files. Closed and past-deadline requests say so, and that nothing was sent.
 */
import { useEffect, useRef, useState } from "react";
import { Avatar, ButtonLink, Icon, LockLine, Musubi, Skeleton, StatusChip } from "@mizuhiki/ui";
import {
  requestState,
  verifyRecord,
  type FileRequest,
  type Manifest,
  type RecipientCard,
  type Signed,
} from "@mizuhiki/core";
import { assertOwnsName, pqKeyViaEvm } from "@mizuhiki/chain";
import { mediaUrl } from "@/lib/api";
import { themeVars } from "@/page/theme";
import { MessageSheet } from "@/public/MessageSheet";
import { deadlineText, STATE_LABEL } from "./model";
import s from "./requestPage.module.css";

export function RequestPage({
  name,
  page,
  card,
  owner,
  request,
}: {
  name: string;
  page: Signed<Manifest>;
  card: RecipientCard | null;
  owner: string;
  request: Signed<FileRequest>;
}) {
  const [check, setCheck] = useState<"checking" | "ok" | "failed">("checking");
  const [open, setOpen] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [drag, setDrag] = useState(false);
  const [sent, setSent] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const m = page.body;
  const r = request.body;
  const first = (m.displayName || name).split(" ")[0] ?? name;

  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        if (request.signer !== owner || r.owner !== owner || page.signer !== owner) throw new Error("mismatch");
        await assertOwnsName(name, owner);
        const pq = await pqKeyViaEvm(owner);
        if (!pq.registered || !pq.publicKey || !pq.possessionProven) throw new Error("no key");
        verifyRecord(request, { kind: "filerequest", signer: owner, pqPublicKey: pq.publicKey });
        if (life.alive) setCheck("ok");
      } catch {
        if (life.alive) setCheck("failed");
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [request, r.owner, owner, page.signer, name]);

  const style = themeVars(m.theme);
  const state = requestState(r);
  const due = deadlineText(r);
  const takes = state === "open" || state === "late";
  const start = (files: File[]) => {
    setDropped(files);
    setOpen(true);
  };

  const head = (
    <header className={s.head}>
      <Avatar name={m.displayName} {...(m.avatar ? { src: mediaUrl(m.avatar.hash) } : {})} size={52} lock />
      <div>
        <p className={s.asker}>
          <b>{m.displayName}</b> <span>@{name}</span> is asking for files
        </p>
        <p className={s.verified}>
          <Icon name="shield" size={14} />
          {check === "ok" ? "Signed, checked against their key on QoreChain" : "Checking their key on QoreChain…"}
        </p>
      </div>
    </header>
  );

  if (check === "checking")
    return (
      <div className={s.stage} style={style}>
        <main className={s.card}>
          {head}
          <Skeleton lines={4} />
        </main>
      </div>
    );
  if (check === "failed")
    return (
      <div className={s.stage} style={style}>
        <main className={s.card} role="alert">
          <Musubi face="worried" size={110} />
          <h1 className={s.title}>This request could not be verified</h1>
          <p className={s.desc}>
            It does not match @{name}&apos;s key on QoreChain, so nothing can be uploaded to it. Nothing was sent.
          </p>
          <ButtonLink href={`/@${name}`} variant="line">
            Go to @{name}
          </ButtonLink>
        </main>
      </div>
    );

  return (
    <div className={s.stage} style={style}>
      <main className={s.card}>
        {head}
        <div className={s.titleRow}>
          <h1 className={s.title}>{r.title}</h1>
          <StatusChip status={state === "open" ? "ok" : state === "late" ? "wait" : "neutral"}>
            {STATE_LABEL[state]}
          </StatusChip>
        </div>
        {r.description ? <p className={s.desc}>{r.description}</p> : null}
        {due ? (
          <p className={s.due}>
            <Icon name="calendar" size={16} /> {due}
          </p>
        ) : null}

        {takes ? (
          <>
            <button
              type="button"
              className={[s.drop, drag ? s.dropOn : ""].join(" ")}
              onClick={() => input.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                if (e.dataTransfer.files.length) start(Array.from(e.dataTransfer.files));
              }}
            >
              <span className={s.dropIcon}>
                <Icon name="upload" size={28} />
              </span>
              <b>{sent ? "Add more files" : "Add files"}</b>
              <span>Drop them here or tap to choose. Up to 2 GB each, sealed on your device as they upload.</span>
            </button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              aria-label="Choose files to upload"
              onChange={(e) => {
                if (e.target.files?.length) start(Array.from(e.target.files));
                e.target.value = "";
              }}
            />
            {state === "late" ? (
              <p className={s.late} role="note">
                The deadline has passed. {first} still takes uploads, marked late.
              </p>
            ) : null}
            {sent ? (
              <p className={s.sent} role="status">
                <Icon name="check" size={16} /> {sent === 1 ? "Your upload is" : `${sent} uploads are`} sealed and
                stored for {first}.
              </p>
            ) : null}
          </>
        ) : (
          <div className={s.closed} role="status">
            <Musubi face="sleepy" size={96} />
            <b>{state === "closed" ? "This request is closed." : "The deadline for this request has passed."}</b>
            <span>Nothing can be uploaded now, and nothing was sent. You can still reach {first} from their page.</span>
            <ButtonLink href={`/@${name}`} variant="line">
              Go to @{name}
            </ButtonLink>
          </div>
        )}
        <LockLine>
          Only {first} can open what you upload. You never see anyone else&apos;s files, and they never see yours.
        </LockLine>
      </main>
      <MessageSheet
        open={open}
        onClose={() => {
          setOpen(false);
          setDropped([]);
        }}
        owner={{ name, displayName: m.displayName, address: owner, card, avatar: m.avatar }}
        request={{ id: r.id, title: r.title, description: r.description, naming: r.naming, state, deadlineText: due }}
        initialFiles={dropped}
        onSent={() => setSent((n) => n + 1)}
      />
    </div>
  );
}
