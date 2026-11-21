"use client";
/**
 * "Send <name> something private" (spec 5.7). Linktree's messaging order: the
 * owner's greeting as a first chat bubble, the visitor writes, and only then
 * chooses how to appear: anonymous (default) or signed with their own Mizuhiki
 * keys. No email, no account. Files are sealed in pieces on this device.
 *
 * The same sheet uploads to a file request (Dropbox's file requests): the
 * request's title replaces the greeting, at least one file is needed, the
 * request's naming rule renames files on this device before sealing, and the
 * drop is filed under the request.
 */
import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  Button,
  ChoiceCard,
  Icon,
  LockLine,
  Oops,
  Readers,
  Receipt,
  SealDone,
  SealFailed,
  SealMoment,
  Sheet,
  TextArea,
  TextField,
  useToast,
  type SealStep,
} from "@mizuhiki/ui";
import {
  fileRequestRef,
  namedFile,
  type Block,
  type NamingRule,
  type RecipientCard,
  type RequestState,
} from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { api, mediaUrl } from "@/lib/api";
import { SEND_STEP_LABEL, SendFailure, sendSealed, type SendResult, type SendStep } from "@/lib/send";
import s from "./public.module.css";
import { failureText } from "@/lib/failure";

export interface OwnerRef {
  name: string;
  displayName: string;
  address: string;
  card: RecipientCard | null;
  avatar?: { hash: string; type: string } | undefined;
}

/** A file request this sheet uploads to (the request page has verified its signature). */
export interface UploadRequest {
  id: string;
  title: string;
  description: string;
  naming: NamingRule;
  state: RequestState;
  /** "Due 20 November, 17:00 in Tokyo (your time 09:00)", or null without a deadline. */
  deadlineText: string | null;
}

type Phase = "compose" | "who" | "sealing" | "done" | "failed";
const MB = 1024 * 1024;

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * MB) return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
  return `${(n / (1024 * MB)).toFixed(2)} GB`;
}

export function MessageSheet({
  open,
  onClose,
  block,
  owner,
  request,
  initialFiles,
  onSent,
}: {
  open: boolean;
  onClose: () => void;
  block?: Extract<Block, { type: "message" }> | undefined;
  owner: OwnerRef;
  request?: UploadRequest | undefined;
  /** Files dropped on the request page before the sheet opened. */
  initialFiles?: File[] | undefined;
  /** Told after each successful send (the request page counts uploads). */
  onSent?: (() => void) | undefined;
}) {
  const acct = useAccount();
  const toast = useToast();
  const first = (owner.displayName || owner.name).split(" ")[0] ?? owner.name;
  const [phase, setPhase] = useState<Phase>("compose");
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [signed, setSigned] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [steps, setSteps] = useState<SealStep[]>([]);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<SendResult | null>(null);
  const [failure, setFailure] = useState<SendFailure | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ctl = useRef<AbortController | null>(null);
  const allowFiles = request ? true : (block?.allowFiles ?? true);
  // Requests take files up to 2 GB each (Dropbox's limit on its free plans); messages follow the block.
  const maxMB = request ? 2048 : (block?.maxFileMB ?? 500);
  const maxBytes = maxMB * MB;
  const isSelf = acct.account?.owner.address === owner.address;
  const canSign = acct.status === "unlocked" && !!acct.account && !isSelf;
  // A visitor with Mizuhiki on this device but locked (any page load locks it) can unlock right here.
  const canUnlock = acct.status === "locked";
  const [pass, setPass] = useState("");
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const signDetail = canSign
    ? `${first} sees it came from your account, checked against your key on QoreChain.`
    : isSelf
      ? "This is your own page. Messages to yourself are always yours."
      : canUnlock
        ? "Unlock Mizuhiki on this device to sign. Your message stays right here."
        : acct.status === "elsewhere"
          ? "Mizuhiki is open in another tab. Sign there, or send anonymously."
          : "Signing needs your own Mizuhiki keys on this device. QoreX cannot sign messages yet.";
  const unlockHere = async () => {
    setUnlocking(true);
    setUnlockErr(null);
    try {
      await acct.unlock(pass);
      setPass("");
      setSigned(true);
    } catch (e) {
      setUnlockErr(failureText(e, "That passphrase did not unlock this device."));
    } finally {
      setUnlocking(false);
    }
  };

  useEffect(() => {
    if (open && initialFiles?.length) setFiles(initialFiles);
  }, [open, initialFiles]);

  useEffect(() => {
    if (!open) return;
    void api
      .get<{ retentionDays: number }>("/drop/config")
      .then((c) => setRetention(c.retentionDays))
      .catch(() => undefined);
  }, [open]);

  const addFiles = (list: FileList | File[]) => {
    const next = [...files];
    const problems: string[] = [];
    for (const f of Array.from(list)) {
      if (f.size > maxBytes) problems.push(`“${f.name}” is larger than ${fmtBytes(maxBytes)}.`);
      else if (next.some((x) => x.name === f.name && x.size === f.size)) problems.push(`“${f.name}” is already added.`);
      else next.push(f);
    }
    setFiles(next);
    setError(problems.length ? `${problems.join(" ")} Nothing has left your device.` : null);
  };

  const reset = () => {
    setPhase("compose");
    setText("");
    setContact("");
    setFiles([]);
    setSigned(false);
    setError(null);
    setResult(null);
    setFailure(null);
  };

  const send = async () => {
    const order: SendStep[] = [
      "keys",
      ...(files.length ? (["files"] as const) : []),
      "seal",
      ...(signed ? (["sign"] as const) : []),
      "stamp",
      "send",
    ];
    setSteps(order.map((k) => ({ label: SEND_STEP_LABEL[k], state: "waiting" })));
    setProgress(0.02);
    setPhase("sealing");
    ctl.current = new AbortController();
    // The request's naming rule, applied here so the server never sees a name.
    const at = new Date();
    const outgoing = request
      ? files.map((f) => new File([f], namedFile(request.naming, f.name, { uploader: contact, at }), { type: f.type }))
      : files;
    try {
      const r = await sendSealed({
        to: { address: owner.address, card: owner.card },
        text,
        contact,
        files: outgoing,
        ...(request
          ? {
              kind: "filedrop" as const,
              ref: fileRequestRef(request.id),
              extra: { request: { id: request.id, title: request.title } },
            }
          : {}),
        maxFileBytes: maxBytes,
        signer: signed && canSign ? acct.account : undefined,
        signal: ctl.current.signal,
        onStep: (k, p) => {
          const idx = order.indexOf(k);
          setSteps(
            order.map((x, i) => ({
              label: SEND_STEP_LABEL[x],
              state: i < idx ? "done" : i === idx ? "running" : "waiting",
            })),
          );
          setProgress(p);
        },
      });
      setSteps(order.map((x) => ({ label: SEND_STEP_LABEL[x], state: "done" })));
      setProgress(1);
      setResult(r);
      setPhase("done");
      onSent?.();
    } catch (e) {
      setFailure(
        e instanceof SendFailure
          ? e
          : new SendFailure(
              "This browser could not seal it. Nothing left your device. Reload and try again.",
              "nothing",
            ),
      );
      setPhase("failed");
    }
  };

  const what = request
    ? `${files.length} ${files.length === 1 ? "file" : "files"} for “${request.title}”`
    : files.length
      ? text.trim()
        ? `Private message, ${files.length} ${files.length === 1 ? "file" : "files"}`
        : `${files.length} ${files.length === 1 ? "file" : "files"}`
      : "Private message";
  const sending = phase === "sealing";
  return (
    <Sheet
      open={open}
      onClose={() => {
        if (sending) return;
        if (phase === "done" || phase === "failed") reset();
        onClose();
      }}
      title={
        phase === "done"
          ? `Sealed for ${first}`
          : request
            ? `Upload files for ${first}`
            : `Send ${first} something private`
      }
      dismissable={!sending}
    >
      {phase === "compose" ? (
        <form
          className={s.msg}
          onSubmit={(e) => {
            e.preventDefault();
            if (request && files.length === 0) {
              setError("Add at least one file. Nothing has left your device.");
              return;
            }
            if (!text.trim() && files.length === 0) {
              setError("Write a note or add a file. Nothing has left your device.");
              return;
            }
            setPhase("who");
          }}
          onDragOver={(e) => {
            if (!allowFiles) return;
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            if (!allowFiles) return;
            e.preventDefault();
            setDrag(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          <Readers readers={[{ label: `${owner.displayName} @${owner.name}` }]} />
          <div className={s.chat}>
            <Avatar
              name={owner.displayName}
              {...(owner.avatar ? { src: mediaUrl(owner.avatar.hash) } : {})}
              size={36}
            />
            {request ? (
              <div className={s.bubble}>
                <b>{request.title}</b>
                {request.description ? <span className={s.bubbleDetail}>{request.description}</span> : null}
              </div>
            ) : (
              <p className={s.bubble}>
                {block?.greeting || `Hi, I'm ${first}. Anything you send here is sealed to me.`}
              </p>
            )}
          </div>
          {request ? null : (
            <TextArea
              label="Message"
              hideLabel
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={20000}
              placeholder={`Write something only ${first} can read`}
              autoFocus
            />
          )}
          {allowFiles ? (
            <>
              {files.length ? (
                <ul className={s.files}>
                  {files.map((f, i) => (
                    <li key={`${f.name}-${f.size}-${i}`}>
                      <Icon name="file" size={16} />
                      <span>
                        {f.name} · {fmtBytes(f.size)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => setFiles(files.filter((_, j) => j !== i))}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <button
                type="button"
                className={[s.drop, drag ? s.dropOn : ""].join(" ")}
                onClick={() => input.current?.click()}
              >
                <Icon name="upload" size={18} />
                <span>Drop or tap to add files · up to {fmtBytes(maxBytes)} each</span>
              </button>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          ) : null}
          {request ? (
            <TextArea
              label={`A note for ${first} (optional)`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={4000}
              rows={2}
            />
          ) : null}
          {request?.deadlineText ? (
            <p className={s.expiry}>
              <Icon name="calendar" size={14} /> {request.deadlineText}
              {request.state === "late" ? " · the deadline has passed; uploads are still taken and marked late" : ""}
            </p>
          ) : null}
          {error ? <Oops title="Nothing to seal yet">{error}</Oops> : null}
          <LockLine>Encrypted on this device. Only {first} can open it.</LockLine>
          {retention ? (
            <p className={s.expiry}>
              <Icon name="clock" size={14} /> We delete the sealed copy after {retention} days. Anything on chain stays.
            </p>
          ) : null}
          <Button type="submit" variant="cord" size="lg" full iconRight="arrow">
            Next
          </Button>
        </form>
      ) : null}

      {phase === "who" ? (
        <div className={s.msg}>
          <p className={s.lead}>How should {first} see you?</p>
          <div role="radiogroup" aria-label="Sender" className={s.stack}>
            <ChoiceCard
              selected={!signed}
              onSelect={() => setSigned(false)}
              title="Anonymous"
              detail={`${first} sees “anonymous”. Nothing about you is attached.`}
              icon={<Icon name="eye" />}
              tone="sakura"
            />
            <ChoiceCard
              selected={signed}
              onSelect={() => (canSign || canUnlock) && setSigned(true)}
              title={
                canSign
                  ? "Show it's from me"
                  : canUnlock
                    ? "Show it's from me (unlock first)"
                    : "Show it's from me (needs Mizuhiki)"
              }
              detail={signDetail}
              icon={<Icon name="pen" />}
              tone="sora"
            />
          </div>
          {signed && canUnlock ? (
            <form
              className={s.unlock}
              onSubmit={(e) => {
                e.preventDefault();
                void unlockHere();
              }}
            >
              <TextField
                label="Device passphrase"
                type="password"
                autoComplete="current-password"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                error={unlockErr ?? undefined}
                autoFocus
              />
              <Button type="submit" variant="line" icon="key" busy={unlocking} disabled={!pass}>
                Unlock to sign
              </Button>
            </form>
          ) : null}
          <TextField
            label={
              request?.naming === "uploader"
                ? "Your name"
                : request
                  ? "Your name (optional)"
                  : "Your name or how to reach you (optional)"
            }
            value={contact}
            maxLength={200}
            onChange={(e) => setContact(e.target.value)}
            hint={
              request?.naming === "uploader"
                ? `${first} names the files after you. Sealed with your files; only ${first} sees it.`
                : `Sealed with your ${request ? "files" : "message"}. Only ${first} sees it.`
            }
          />
          <div className={s.row}>
            <Button variant="line" icon="back" onClick={() => setPhase("compose")}>
              Back
            </Button>
            <Button
              variant="cord"
              size="lg"
              icon="lock"
              onClick={() => void send()}
              className={s.grow}
              disabled={(signed && !canSign) || (request?.naming === "uploader" && !contact.trim())}
            >
              Seal and send
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "sealing" ? (
        <div className={s.msg}>
          <SealMoment steps={steps} progress={progress} />
          <Button variant="ghost" full onClick={() => ctl.current?.abort()}>
            Cancel
          </Button>
        </div>
      ) : null}

      {phase === "done" && result ? (
        <SealDone
          headline={`Stored for ${first}, sealed.`}
          onDone={() => {
            reset();
            onClose();
          }}
          onCopy={() => {
            const t = `Mizuhiki seal receipt\nTo: @${owner.name}\nWhat: ${what}\nSender: ${result.signedBy ? `signed by ${result.signedBy}` : "anonymous"}\nEnvelope: ${result.hash}\nStored until: ${result.expiresAt}`;
            void navigator.clipboard.writeText(t).then(
              () => toast.show("Receipt copied"),
              () => toast.show("Copy is not allowed here", { tone: "error" }),
            );
          }}
          receipt={
            <Receipt
              title={`Sealed for ${first}`}
              when={new Date().toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              lines={[
                { term: "What", value: what },
                { term: "Readers", value: `${owner.displayName} @${owner.name}` },
                { term: "Sender", value: result.signedBy ? "Signed with your key" : "Anonymous" },
                ...(result.late ? [{ term: "Arrived", value: "After the deadline, marked late" }] : []),
                { term: "On chain", value: "Nothing" },
                {
                  term: "Kept until",
                  value: new Date(result.expiresAt).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  }),
                },
              ]}
              hash={result.hash}
            />
          }
          extra={
            <Button variant="ghost" full icon={request ? "upload" : "send"} onClick={reset}>
              {request ? "Upload more files" : "Send another"}
            </Button>
          }
        />
      ) : null}

      {phase === "failed" && failure ? (
        <SealFailed
          title="Not sent."
          detail={failure.message}
          onClose={() => {
            reset();
            onClose();
          }}
          onRetry={() => void send()}
        />
      ) : null}
    </Sheet>
  );
}
