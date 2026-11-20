"use client";
/**
 * The share step right after a request is made, and from its page (Dropbox:
 * "Share a link instead", "Link copied"): the link, a QR code, and a button on
 * the owner's page that opens the request.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button, ButtonLink, Icon, Oops, Sheet, Skeleton, useToast } from "@mizuhiki/ui";
import { newId, type Block, type FileRequest } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { updateBlock } from "@/editor/blocks";
import { markChecklist } from "@/editor/checklist";
import { requestLink } from "./engine";
import s from "./requests.module.css";
import { failureText } from "@/lib/failure";

export function ShareRequest({
  open,
  onClose,
  request,
  name,
  fresh = false,
}: {
  open: boolean;
  onClose: () => void;
  request: FileRequest;
  name: string;
  /** Just created: the sheet says so. */
  fresh?: boolean;
}) {
  const toast = useToast();
  const link = requestLink(name, request.id);
  const [qr, setQr] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    QRCode.toDataURL(link, {
      margin: 2,
      width: 768,
      errorCorrectionLevel: "M",
      color: { dark: "#2b2340", light: "#ffffff" },
    }).then(
      (u) => alive && setQr(u),
      () => alive && setQrFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [open, link]);

  const copy = () =>
    void navigator.clipboard.writeText(link).then(
      () => toast.show("Link copied"),
      () => toast.show("Copy is not allowed here. Select the link and copy it.", { tone: "error" }),
    );

  return (
    <Sheet open={open} onClose={onClose} title={fresh ? "Your request is ready" : "Share this request"}>
      <div className={s.share}>
        <p className={s.help}>
          Send this link to the people you are asking. They upload without an account; everything is sealed on their
          device to you.
        </p>
        <div className={s.linkBox}>
          <code aria-label="Request link">{link}</code>
          <Button size="sm" variant="cord" icon="copy" onClick={copy}>
            Copy link
          </Button>
        </div>
        <div className={s.qrWrap}>
          {qr ? (
            <img className={s.qr} src={qr} alt="QR code for the request link" />
          ) : qrFailed ? null : (
            <Skeleton height={132} />
          )}
          <div>
            <p className={s.help}>For a desk, a poster or a slide. Scanning it opens the same link.</p>
            {qr ? (
              <ButtonLink href={qr} download={`request-${request.id}-qr.png`} size="sm" variant="line" icon="download">
                Download QR
              </ButtonLink>
            ) : null}
          </div>
        </div>
        <AddToPage request={request} />
        <ButtonLink href={link} target="_blank" rel="noreferrer" variant="line" icon="share" full>
          Open the request page
        </ButtonLink>
        <Button variant="ghost" onClick={onClose} full>
          Done
        </Button>
      </div>
    </Sheet>
  );
}

/** "Upload files" on the owner's public page, opening this request. Fulfils a file request placeholder from setup. */
function AddToPage({ request }: { request: FileRequest }) {
  const o = useOwner();
  const toast = useToast();
  const [queued, setQueued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Publish after the edit has rendered, so the provider publishes the draft that holds it.
  useEffect(() => {
    if (!queued) return;
    const done = queued;
    setQueued(null);
    o.publish().then(
      () => toast.show(done),
      (e: unknown) =>
        setError(`${failureText(e, "Your page was not published.")} The button is saved in your page draft.`),
    );
  }, [queued, o, toast]);

  if (o.loading) return <Skeleton lines={2} />;
  const d = o.draft;
  if (o.loadError || !d)
    return (
      <Oops title="Your page did not open">
        {o.loadError ?? "Your page draft is not available."} The link still works on its own.
      </Oops>
    );
  const block = d.manifest.blocks.find(
    (b): b is Extract<Block, { type: "fileRequest" }> => b.type === "fileRequest" && b.requestId === request.id,
  );
  const live =
    o.published?.blocks.some((b) => b.type === "fileRequest" && b.requestId === request.id && b.on && !b.archived) ??
    false;
  const busy = o.publishing || queued !== null;
  const run = (fn: Parameters<typeof o.edit>[0], message: string) => {
    setError(null);
    o.edit(fn);
    setQueued(message);
  };
  const add = () =>
    run((x) => {
      const b: Block = {
        id: newId(),
        type: "fileRequest",
        requestId: request.id,
        title: request.title.slice(0, 80),
        subtitle: "Upload files, sealed to me",
        on: true,
        archived: false,
      };
      const i = x.pending.findIndex((p) => p.kind === "fileRequest");
      const pending = i < 0 ? x.pending : x.pending.filter((_, j) => j !== i);
      return markChecklist(
        { ...x, pending, manifest: { ...x.manifest, blocks: [...x.manifest.blocks, b] } },
        "block",
        "done",
      );
    }, "Added to your page and published");

  return (
    <div className={s.pageRow}>
      <Icon name="home" size={20} />
      <div className={s.pageText}>
        <b>On my page</b>
        <p className={s.help}>
          {!block
            ? `Adds a button “${request.title.slice(0, 80)}” to your page and publishes it.`
            : block.archived
              ? "The button is in your page's archive, so visitors do not see it."
              : !block.on
                ? "The button is on your page but switched off."
                : live
                  ? "The button is on your page and live."
                  : "The button is in your page draft, not published yet."}
          {o.dirty && !live ? " Publishing also puts your other page changes live." : ""}
        </p>
        {error ? <Oops title="Not published">{error}</Oops> : null}
      </div>
      {!block ? (
        <Button size="sm" variant="line" icon="plus" busy={busy} onClick={add}>
          Add to my page
        </Button>
      ) : block.archived || !block.on ? (
        <Button
          size="sm"
          variant="line"
          icon="undo"
          busy={busy}
          onClick={() =>
            run((x) => updateBlock(x, block.id, { archived: false, on: true }), "The button is back on your page")
          }
        >
          Bring it back
        </Button>
      ) : !live ? (
        <Button
          size="sm"
          variant="line"
          icon="send"
          busy={busy}
          onClick={() => run((x) => x, "Your page is published")}
        >
          Publish my page
        </Button>
      ) : null}
    </div>
  );
}
