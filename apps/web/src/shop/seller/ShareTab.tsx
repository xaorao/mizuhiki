"use client";
/**
 * Share (Gumroad 3.4): copy the link, a QR code, and "Show on my page": a
 * product button, or a place in a Shop section. Publishing alone does not put
 * a product on the page; the page draft is edited and published here.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  Button,
  ButtonLink,
  CopyValue,
  EmptyState,
  Icon,
  Kicker,
  Musubi,
  Oops,
  Panel,
  Skeleton,
  useToast,
} from "@mizuhiki/ui";
import { newId, type Block } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { updateBlock } from "@/editor/blocks";
import { markChecklist } from "@/editor/checklist";
import { SITE_URL } from "@/lib/site";
import { productPath } from "./model";
import type { EditorProps } from "./editorTypes";
import s from "./seller.module.css";
import { failureText } from "@/lib/failure";

export function ShareTab({ draft, row, name, publish, publishing }: EditorProps) {
  const toast = useToast();
  const live = row.status === "published" && row.record;
  const slug = row.record?.body.slug ?? draft.def.slug;
  const link = `${SITE_URL}${productPath(name, slug)}`;

  if (!live)
    return (
      <div className={s.tabStack}>
        <Panel>
          <EmptyState
            title={row.record ? "This product is unpublished" : "Publish to get a link"}
            face="sleepy"
            jp="まだ"
            action={
              <Button variant="cord" icon="send" busy={publishing} onClick={() => void publish()}>
                {row.record ? "Publish again" : "Publish"}
              </Button>
            }
          >
            Publishing signs the product with your key. Then you get a link, a QR code and a way to show it on your
            page.
          </EmptyState>
        </Panel>
      </div>
    );

  return (
    <div className={s.tabStack}>
      <div className={s.hero}>
        <Musubi face="happy" size={84} />
        <div>
          <Kicker>できた！</Kicker>
          <h2>Your product is live.</h2>
          <p>Anyone with the link can buy it. Each buyer gets their own sealed copy.</p>
        </div>
      </div>
      <Panel title="Share the link" kicker="リンク">
        <div className={s.stack}>
          <div className={s.linkLine}>
            <CopyValue
              value={link}
              label="product link"
              onCopied={(ok) =>
                toast.show(
                  ok ? "Link copied and ready to share" : "Copy is not allowed here",
                  ok ? {} : { tone: "error" },
                )
              }
            />
            <ButtonLink href={link} target="_blank" rel="noopener" size="sm" variant="line" iconRight="arrow">
              Open
            </ButtonLink>
          </div>
          <Qr link={link} slug={slug} />
        </div>
      </Panel>
      <ShowOnPage productId={draft.def.id} title={row.record?.body.title ?? draft.def.title} />
    </div>
  );
}

function Qr({ link, slug }: { link: string; slug: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(link, {
      margin: 2,
      width: 1024,
      errorCorrectionLevel: "M",
      color: { dark: "#2b2340", light: "#ffffff" },
    }).then(
      (u) => alive && (setQr(u), setFailed(false)),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [link]);
  return (
    <div className={s.qrWrap}>
      {qr ? (
        <img className={s.qr} src={qr} alt="QR code for the product link" />
      ) : failed ? null : (
        <Skeleton height={160} />
      )}
      <div className={s.stack}>
        <b>QR code</b>
        <p className={s.help}>
          {failed
            ? "The QR code could not be drawn in this browser. The link above works the same."
            : "For a stall, a poster or the last slide of a talk. Scanning it opens the same link."}
        </p>
        {qr ? (
          <div>
            <ButtonLink href={qr} download={`${slug}-qr.png`} size="sm" variant="line" icon="download">
              Download PNG
            </ButtonLink>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ShowOnPage({ productId, title }: { productId: string; title: string }) {
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
        setError(`${failureText(e, "Your page was not published.")} The change is saved in your page draft.`),
    );
  }, [queued, o, toast]);

  if (o.loading)
    return (
      <Panel title="Show on my page" kicker="おみせ">
        <Skeleton lines={2} />
      </Panel>
    );
  const d = o.draft;
  if (o.loadError || !d)
    return (
      <Panel title="Show on my page" kicker="おみせ">
        <Oops title="Your page did not open">
          {o.loadError ?? "Your page draft is not available."} The product link still works on its own.
        </Oops>
      </Panel>
    );

  const blocks = d.manifest.blocks;
  const button = blocks.find(
    (b): b is Extract<Block, { type: "product" }> => b.type === "product" && b.productId === productId,
  );
  const sections = blocks.filter((b): b is Extract<Block, { type: "shopSection" }> => b.type === "shopSection");
  const inSection = sections.find((b) => b.productIds.includes(productId));
  const pub = o.published?.blocks ?? [];
  const buttonLive = pub.some((b) => b.type === "product" && b.productId === productId && b.on && !b.archived);
  const sectionLive = pub.some(
    (b) => b.type === "shopSection" && b.productIds.includes(productId) && b.on && !b.archived,
  );
  const busy = o.publishing || queued !== null;

  const run = (fn: Parameters<typeof o.edit>[0], message: string) => {
    setError(null);
    o.edit(fn);
    setQueued(message);
  };
  const addButton = () =>
    run((x) => {
      const b: Block = {
        id: newId(),
        type: "product",
        productId,
        title: title.slice(0, 80) || "My product",
        subtitle: "Sealed to each buyer",
        on: true,
        archived: false,
      };
      return markChecklist({ ...x, manifest: { ...x.manifest, blocks: [...x.manifest.blocks, b] } }, "block", "done");
    }, "Added to your page and published");
  const addToSection = () =>
    run(
      (x) => {
        const first = x.manifest.blocks.find(
          (b): b is Extract<Block, { type: "shopSection" }> => b.type === "shopSection" && !b.archived,
        );
        if (first)
          return updateBlock(x, first.id, {
            productIds: [...first.productIds.filter((p) => p !== productId), productId].slice(0, 48),
            on: true,
          });
        const b: Block = {
          id: newId(),
          type: "shopSection",
          productIds: [productId],
          title: "Shop",
          subtitle: "",
          on: true,
          archived: false,
        };
        return markChecklist({ ...x, manifest: { ...x.manifest, blocks: [...x.manifest.blocks, b] } }, "block", "done");
      },
      sections.length
        ? "Added to your Shop section and published"
        : "Shop section made, with this product, and published",
    );

  const removeFrom = (kind: "button" | "section") =>
    run(
      (x) =>
        kind === "button" && button
          ? { ...x, manifest: { ...x.manifest, blocks: x.manifest.blocks.filter((b) => b.id !== button.id) } }
          : inSection
            ? updateBlock(x, inSection.id, { productIds: inSection.productIds.filter((p) => p !== productId) })
            : x,
      kind === "button" ? "Button removed from your page" : "Removed from your Shop section",
    );

  const line = (isIn: boolean, isLive: boolean, hidden: boolean) =>
    !isIn
      ? null
      : hidden
        ? "On your page but switched off or archived."
        : isLive
          ? "On your page and live."
          : "In your page draft, not published yet.";

  return (
    <Panel title="Show on my page" kicker="おみせ">
      <div className={s.stack}>
        <p className={s.note}>
          <Icon name="info" size={15} /> Publishing a product does not put it on your page. Add it as a button, or to a
          Shop section, here.
        </p>
        <div className={s.showRow}>
          <span className={s.showIcon}>
            <Icon name="bag" size={20} />
          </span>
          <div className={s.showText}>
            <b>A button for this product</b>
            <small>
              {line(!!button, buttonLive, !!button && (!button.on || button.archived)) ??
                `A “${title.slice(0, 40)}” button on your page.`}
            </small>
          </div>
          {!button ? (
            <Button size="sm" variant="cord" icon="plus" busy={busy} onClick={addButton}>
              Add button
            </Button>
          ) : !button.on || button.archived ? (
            <Button
              size="sm"
              variant="cord"
              icon="check"
              busy={busy}
              onClick={() =>
                run((x) => updateBlock(x, button.id, { on: true, archived: false }), "The button is back on your page")
              }
            >
              Show it
            </Button>
          ) : !buttonLive ? (
            <Button
              size="sm"
              variant="cord"
              icon="send"
              busy={busy}
              onClick={() => run((x) => x, "Your page is published")}
            >
              Publish my page
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon="x" busy={busy} onClick={() => removeFrom("button")}>
              Remove
            </Button>
          )}
        </div>
        <div className={s.showRow}>
          <span className={s.showIcon}>
            <Icon name="folder" size={20} />
          </span>
          <div className={s.showText}>
            <b>
              {inSection
                ? `In “${inSection.title}”`
                : sections.length
                  ? `Add to “${sections[0]?.title ?? "Shop"}”`
                  : "A Shop section"}
            </b>
            <small>
              {line(!!inSection, sectionLive, !!inSection && (!inSection.on || inSection.archived)) ??
                (sections.length
                  ? "A grid of products on your page, with thumbnails and prices."
                  : "You have no Shop section yet. This makes one with this product in it.")}
            </small>
          </div>
          {!inSection ? (
            <Button size="sm" variant={button ? "line" : "cord"} icon="plus" busy={busy} onClick={addToSection}>
              {sections.length ? "Add" : "Make section"}
            </Button>
          ) : !sectionLive ? (
            <Button
              size="sm"
              variant="cord"
              icon="send"
              busy={busy}
              onClick={() =>
                run(
                  (x) =>
                    inSection.on && !inSection.archived
                      ? x
                      : updateBlock(x, inSection.id, { on: true, archived: false }),
                  "Your page is published",
                )
              }
            >
              Publish my page
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon="x" busy={busy} onClick={() => removeFrom("section")}>
              Remove
            </Button>
          )}
        </div>
        {o.dirty ? (
          <p className={s.help}>Publishing your page also puts your other unpublished page changes live.</p>
        ) : null}
        {error ? <Oops title="Your page was not published">{error}</Oops> : null}
      </div>
    </Panel>
  );
}
