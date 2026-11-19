"use client";
/**
 * The public page a visitor sees at /@name (spec 5.4). It renders the owner's
 * signed manifest and checks, in this browser, that the signature matches the
 * owner's ML-DSA-87 key read straight from QoreChain (EVM precompile), that the
 * name and address agree with MizuhikiRegistry, before anything can be sent.
 * A page that fails the check is replaced by a hard error, never a fallback.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Button,
  ButtonLink,
  Chip,
  CopyValue,
  Icon,
  IconButton,
  Knot,
  LockLine,
  Musubi,
  Oops,
  Sakura,
  Sheet,
  TextArea,
  useToast,
} from "@mizuhiki/ui";
import { verifyRecord, type Block, type Manifest, type RecipientCard, type Signed } from "@mizuhiki/core";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import { PageView } from "@/page/PageView";
import { api } from "@/lib/api";
import { pageUrl } from "@/lib/site";
import { deepLinkPath, type DeepLink } from "./deeplink";
import { MessageSheet } from "./MessageSheet";
import { PaySheet } from "./PaySheet";
import { RoomSheet } from "./RoomSheet";
import { useRouter } from "next/navigation";
import { pendingNotesFor, retryPending } from "@/lib/pay";
import { ShopBlockView } from "@/shop/buyer/ShopBlocks";
import { useShop } from "@/shop/buyer/parts";
import s from "./public.module.css";

type Verify = { state: "checking" } | { state: "ok" } | { state: "failed"; reason: string };

export interface PublicPageProps {
  name: string;
  record: Signed<Manifest>;
  card: RecipientCard | null;
  registry: { owner: string; cardHash: string };
  deepLink: DeepLink;
}

type Open =
  | { kind: "none" }
  | { kind: "info" }
  | { kind: "share" }
  | { kind: "report" }
  | { kind: "text"; block: Extract<Block, { type: "text" }> }
  | { kind: "message" }
  | { kind: "pay"; amount?: string | undefined; blockId?: string | undefined }
  | { kind: "room"; block: Extract<Block, { type: "room" }> };

export function PublicPage({ name, record, card, registry, deepLink }: PublicPageProps) {
  const router = useRouter();
  const m = record.body;
  const [verify, setVerify] = useState<Verify>({ state: "checking" });
  const firstName = (m.displayName || m.name).split(" ")[0] ?? m.name;
  const blocks = m.blocks;
  const messageBlock = blocks.find(
    (b): b is Extract<Block, { type: "message" }> => b.type === "message" && b.on && !b.archived,
  );
  const payBlock = blocks.find((b): b is Extract<Block, { type: "pay" }> => b.type === "pay" && b.on && !b.archived);

  // Verify the page against the chain, in this browser.
  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        if (m.name !== name) throw new Error("This page is for a different name.");
        if (record.signer !== registry.owner || m.address !== registry.owner)
          throw new Error("This page is not signed by the account that owns the name.");
        const pq = await pqKeyViaEvm(registry.owner);
        if (!pq.registered || !pq.publicKey || !pq.possessionProven)
          throw new Error("The owner's signing key is not registered on QoreChain.");
        verifyRecord(record, { kind: "manifest", signer: registry.owner, pqPublicKey: pq.publicKey });
        if (life.alive) setVerify({ state: "ok" });
      } catch (e) {
        if (life.alive) setVerify({ state: "failed", reason: (e as Error).message });
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [m, name, record, registry.owner]);

  // One view per tab session; content-blind (no IP or cookie is stored).
  useEffect(() => {
    const key = `mzk:viewed:${name}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // storage blocked: still count once for this load
    }
    void api.post("/count", { name, kind: "view" }).catch(() => undefined);
  }, [name]);

  // Sheets follow the URL, so back closes them and deep links open them.
  const initial = useMemo<Open>(() => {
    if (deepLink.kind === "message" && messageBlock) return { kind: "message" };
    if (deepLink.kind === "pay" && payBlock) return { kind: "pay", amount: deepLink.amount };
    if (deepLink.kind === "block") {
      const b = blocks.find((x) => x.id === deepLink.id && x.on && !x.archived);
      if (b?.type === "message") return { kind: "message" };
      if (b?.type === "pay") return { kind: "pay", blockId: b.id };
      if (b?.type === "text") return { kind: "text", block: b };
      if (b?.type === "room") return { kind: "room", block: b };
    }
    return { kind: "none" };
  }, [deepLink, blocks, messageBlock, payBlock]);
  const [open, setOpen] = useState<Open>(initial);
  const missingLink = deepLink.kind !== "none" && initial.kind === "none";
  const tap = useCallback(
    (subject: string) => {
      void api.post("/count", { name, kind: "tap", subject }).catch(() => undefined);
    },
    [name],
  );
  const openSheet = (o: Open, path?: string) => {
    setOpen(o);
    if (path) window.history.replaceState(window.history.state, "", path);
  };
  const close = () => {
    setOpen({ kind: "none" });
    if (window.location.pathname !== `/@${name}`) window.history.replaceState(window.history.state, "", `/@${name}`);
  };

  const onBlock = (b: Block) => {
    tap(b.id);
    if (b.type === "message") openSheet({ kind: "message" }, deepLinkPath(name, { kind: "message" }));
    else if (b.type === "text") openSheet({ kind: "text", block: b }, deepLinkPath(name, { kind: "block", id: b.id }));
    else if (b.type === "pay")
      openSheet({ kind: "pay", blockId: b.id }, deepLinkPath(name, { kind: "block", id: b.id }));
    else if (b.type === "room") openSheet({ kind: "room", block: b }, deepLinkPath(name, { kind: "block", id: b.id }));
    // A form is a one-question-per-screen flow, so it opens as its own page (Back returns here).
    else if (b.type === "form") router.push(deepLinkPath(name, { kind: "form", slug: b.slug }));
  };

  // Links | Shop (spec 5.4) when the page has shop blocks; "?tab=shop" (Continue shopping) opens the Shop side.
  // The switch shows when the shop is published: a Shop section on the page, or any published product.
  const shop = useShop(name);
  const hasShop =
    blocks.some((b) => b.type === "shopSection" && b.on && !b.archived) ||
    (shop.state === "ok" && shop.items.length > 0);
  const allProducts: Block | null =
    shop.state === "ok" && shop.items.length > 0
      ? {
          id: "allshop",
          type: "shopSection",
          title: "Shop",
          subtitle: "",
          on: true,
          archived: false,
          productIds: shop.items.map((x) => x.def.id).slice(0, 48),
        }
      : null;
  const [tab, setTab] = useState<"links" | "shop">("links");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "shop") setTab("shop");
  }, []);
  const changeTab = (t: "links" | "shop") => {
    setTab(t);
    const url = t === "shop" ? `${window.location.pathname}?tab=shop` : window.location.pathname;
    window.history.replaceState(window.history.state, "", url);
  };
  const renderBlock = (b: Block) =>
    b.type === "product" || b.type === "shopSection" ? (
      <ShopBlockView block={b} name={name} onTap={(x) => tap(x.id)} />
    ) : undefined;

  // A sealed payment note that did not reach the owner earlier is kept on this device; offer it again.
  const [pendingNotes, setPendingNotes] = useState<Awaited<ReturnType<typeof pendingNotesFor>>>([]);
  const [resending, setResending] = useState(false);
  const toastPending = useToast();
  useEffect(() => {
    void pendingNotesFor(registry.owner).then(setPendingNotes, () => undefined);
  }, [registry.owner, open.kind]);

  if (verify.state === "failed") {
    return (
      <div className={s.stage}>
        <div className={s.failed} role="alert">
          <Musubi face="worried" size={120} />
          <h1>This page could not be verified</h1>
          <p>
            The page for <b>@{name}</b> does not match its owner&apos;s key on QoreChain, so nothing can be sent from
            here. Nothing has left your device.
          </p>
          <p className={s.reason}>{verify.reason}</p>
          <ButtonLink href="/" variant="line">
            Go to Mizuhiki
          </ButtonLink>
        </div>
      </div>
    );
  }

  const ready = verify.state === "ok";
  const activePay =
    open.kind === "pay"
      ? (blocks.find((b): b is Extract<Block, { type: "pay" }> => b.type === "pay" && b.id === open.blockId) ??
        payBlock)
      : payBlock;
  return (
    <div className={s.stage}>
      <Sakura count={6} />
      <div className={s.column}>
        <header className={s.top}>
          <a className={s.home} href="/" aria-label="Mizuhiki home">
            <Knot size={26} />
          </a>
          <span className={s.topRight}>
            {messageBlock ? (
              <Button size="sm" variant="line" icon="send" onClick={() => onBlock(messageBlock)}>
                Message
              </Button>
            ) : null}
            <IconButton
              icon="share"
              label="Share or show QR code"
              size="sm"
              variant="line"
              onClick={() => setOpen({ kind: "share" })}
            />
          </span>
        </header>
        {pendingNotes.length > 0 && ready ? (
          <div className={s.notice}>
            <Oops
              title={`A sealed note for ${firstName} did not arrive`}
              action={
                <Button
                  size="sm"
                  variant="line"
                  busy={resending}
                  onClick={() => {
                    setResending(true);
                    void Promise.allSettled(pendingNotes.map((p) => retryPending(p)))
                      .then(async (r) => {
                        const left = await pendingNotesFor(registry.owner);
                        setPendingNotes(left);
                        toastPending.show(
                          r.every((x) => x.status === "fulfilled")
                            ? "Note delivered"
                            : "Still not delivered. It stays on this device.",
                          r.every((x) => x.status === "fulfilled") ? {} : { tone: "error" },
                        );
                      })
                      .finally(() => setResending(false));
                  }}
                >
                  Send it now
                </Button>
              }
            >
              Your payment went through earlier; the note is kept on this device until it is delivered.
            </Oops>
          </div>
        ) : null}
        {missingLink ? (
          <div className={s.notice}>
            <Oops title="That link has nothing behind it">The page is below. Nothing was sent.</Oops>
          </div>
        ) : null}
        {/* Taps before the chain check finishes are kept: sheets render only once the page is verified. */}
        <PageView
          manifest={m}
          onBlock={onBlock}
          onInfo={() => setOpen({ kind: "info" })}
          hasShop={hasShop}
          shopFallback={allProducts ? <ShopBlockView block={allProducts} name={name} onTap={(x) => tap(x.id)} /> : null}
          tab={tab}
          onTab={changeTab}
          renderBlock={renderBlock}
        />
        <p className={s.verify} aria-live="polite">
          {ready ? (
            <>
              <Icon name="shield" size={14} />
              Signed by @{name}&apos;s post-quantum key, checked on QoreChain just now
            </>
          ) : (
            <>
              <span className={s.spin} aria-hidden="true" />
              Checking @{name}&apos;s key on QoreChain…
            </>
          )}
        </p>
        <footer className={s.foot}>
          <button type="button" onClick={() => setOpen({ kind: "report" })}>
            Report this page
          </button>
          <a href="/">
            <Knot size={16} /> mizuhiki 水引
          </a>
        </footer>
      </div>

      <Sheet open={open.kind === "info"} onClose={() => setOpen({ kind: "none" })} title="What sealed means here">
        <InfoBody firstName={firstName} />
      </Sheet>
      <Sheet open={open.kind === "share"} onClose={() => setOpen({ kind: "none" })} title={`Share @${name}`}>
        <ShareBody name={name} />
      </Sheet>
      <Sheet open={open.kind === "report"} onClose={() => setOpen({ kind: "none" })} title="Report this page">
        <ReportBody name={name} onDone={() => setOpen({ kind: "none" })} />
      </Sheet>
      <Sheet open={open.kind === "text"} onClose={close} title={open.kind === "text" ? open.block.title : ""}>
        {open.kind === "text" ? <p className={s.textBody}>{open.block.body}</p> : null}
      </Sheet>
      {activePay ? (
        <PaySheet
          open={open.kind === "pay" && ready}
          onClose={close}
          block={activePay}
          owner={{ name, displayName: m.displayName, address: registry.owner, card, avatar: m.avatar }}
          initialAmount={open.kind === "pay" ? open.amount : undefined}
          onMessage={
            messageBlock ? () => openSheet({ kind: "message" }, deepLinkPath(name, { kind: "message" })) : undefined
          }
        />
      ) : null}
      <RoomSheet
        block={open.kind === "room" ? open.block : null}
        ownerName={name}
        open={open.kind === "room"}
        onClose={close}
      />
      {messageBlock ? (
        <MessageSheet
          open={open.kind === "message" && ready}
          onClose={close}
          block={messageBlock}
          owner={{ name, displayName: m.displayName, address: registry.owner, card, avatar: m.avatar }}
        />
      ) : null}
    </div>
  );
}

function InfoBody({ firstName }: { firstName: string }) {
  return (
    <div className={s.info}>
      <p>
        Whatever you send is locked on your device with {firstName}&apos;s public key, read from QoreChain. Mizuhiki
        stores only the locked copy and cannot open it.
      </p>
      <div className={s.colSealed}>
        <h3>
          <Icon name="lock" size={18} /> Sealed
        </h3>
        <p>Messages, files, form answers, payment notes.</p>
      </div>
      <div className={s.colPublic}>
        <h3>
          <Icon name="eye" size={18} /> Public on chain
        </h3>
        <p>Addresses, payment amounts and timing. Mizuhiki also sees sizes, times and how many items arrive.</p>
      </div>
      <LockLine>QoreSeal is version 0.1.0 and its design is awaiting an external review.</LockLine>
    </div>
  );
}

function ShareBody({ name }: { name: string }) {
  const url = pageUrl(name);
  const toast = useToast();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current)
      void QRCode.toCanvas(canvas.current, url, {
        width: 220,
        margin: 1,
        color: { dark: "#2b2340", light: "#ffffff" },
      });
  }, [url]);
  const nav = typeof navigator === "undefined" ? undefined : (navigator as { share?: Navigator["share"] });
  return (
    <div className={s.share}>
      <canvas ref={canvas} className={s.qr} aria-label={`QR code for ${url}`} role="img" />
      <div className={s.shareUrl}>
        <CopyValue
          value={url}
          label="page link"
          onCopied={(ok) => toast.show(ok ? "Link copied" : "Copy is not allowed here", { tone: ok ? "ok" : "error" })}
        />
      </div>
      {nav?.share ? (
        <Button
          variant="cord"
          icon="share"
          full
          onClick={() => void nav.share?.call(navigator, { title: `@${name} on Mizuhiki`, url }).catch(() => undefined)}
        >
          Share
        </Button>
      ) : null}
    </div>
  );
}

const REASONS = [
  { id: "impersonation", label: "Pretending to be someone else" },
  { id: "scam", label: "A scam or fraud" },
  { id: "abuse", label: "Harassment or hate" },
  { id: "illegal", label: "Something illegal" },
  { id: "other", label: "Something else" },
] as const;

function ReportBody({ name, onDone }: { name: string; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState<(typeof REASONS)[number]["id"] | null>(null);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={s.report}
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason) return;
        setBusy(true);
        api
          .post("/reports", { name, reason, detail })
          .then(() => {
            toast.show("Thank you. We will look at this page.");
            onDone();
          })
          .catch(() => toast.show("The report was not sent. Try again.", { tone: "error" }))
          .finally(() => setBusy(false));
      }}
    >
      <p>
        Tell us what is wrong with @{name}. Sealed items cannot be read by anyone at Mizuhiki; we can only take down the
        public page.
      </p>
      <div role="radiogroup" aria-label="Reason" className={s.reasons}>
        {REASONS.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={reason === r.id} onClick={() => setReason(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
      <TextArea
        label="Anything else (optional)"
        value={detail}
        maxLength={1000}
        counter
        onChange={(e) => setDetail(e.target.value)}
      />
      <Button type="submit" variant="cord" full busy={busy} disabled={!reason}>
        Send report
      </Button>
    </form>
  );
}

/** Missing, unpublished or moved pages (spec 5.4 states). */
export function PageUnavailable({
  state,
  message,
  name,
}: {
  state: "missing" | "moved" | "error";
  message: string;
  name: string;
}) {
  return (
    <div className={s.stage}>
      <div className={s.failed}>
        <Musubi face={state === "error" ? "worried" : "sleepy"} size={120} bob />
        <h1>{message}</h1>
        <p>
          {state === "error"
            ? "Nothing was sent. Reload the page to try again."
            : `If you were sent here, ask the person for their new link. You can also claim @${name} if it is free.`}
        </p>
        <div className={s.row}>
          <ButtonLink href="/" variant="line">
            Go to Mizuhiki
          </ButtonLink>
          {state !== "error" ? (
            <ButtonLink href={`/signup?name=${encodeURIComponent(name)}`} variant="cord">
              Claim a page
            </ButtonLink>
          ) : null}
        </div>
        <Chip icon="shield">Pages are signed by their owners</Chip>
      </div>
    </div>
  );
}
