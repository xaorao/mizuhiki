"use client";
/**
 * Share (spec 5.9): Tally's publish confirmation, the link with copy, open and
 * QR, the form as a button on the owner's page, and Typeform's embed modes for
 * other websites through /embed.js (whose attribute contract is documented at
 * the top of that file). The "Launch me" test runs that same script here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Button,
  ButtonLink,
  CopyValue,
  EmptyState,
  Icon,
  Kicker,
  LockLine,
  Musubi,
  Oops,
  Panel,
  Segmented,
  Skeleton,
  TextField,
  useToast,
} from "@mizuhiki/ui";
import { formProblems, newId, type Block, type FormDef } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { updateBlock } from "@/editor/blocks";
import { markChecklist } from "@/editor/checklist";
import { SITE_URL } from "@/lib/site";
import { contrast } from "@/page/theme";
import type { TabProps } from "./tabTypes";
import s from "./settings.module.css";

type EmbedMode = "standard" | "popup" | "slider" | "sidetab";

interface EmbedApi {
  open: (url: string, opts?: { mode?: "popup" | "slider" }) => { close: () => void } | null;
  mount: (el: Element) => boolean;
  sideTab: (url: string, opts?: { label?: string; color?: string }) => { remove: () => void } | null;
  close: () => void;
}
declare global {
  interface Window {
    MizuhikiEmbed?: EmbedApi;
  }
}

const HEX_RE = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR = "#c2300f";
const DEFAULT_LABEL = "Open the form";

/** Same JSON for the same content, whatever the key order. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canon(x)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
const content = (d: FormDef): string => {
  const { version: _v, updatedAt: _u, ...rest } = d;
  return canon(rest);
};

const attr = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let embedScript: Promise<EmbedApi> | null = null;
/** Load the real /embed.js into this page once. */
function loadEmbed(): Promise<EmbedApi> {
  const ready = window.MizuhikiEmbed;
  if (ready) return Promise.resolve(ready);
  embedScript ??= new Promise<EmbedApi>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = "/embed.js";
    el.async = true;
    el.onload = () => {
      const api = window.MizuhikiEmbed;
      if (api) resolve(api);
      else reject(new Error("The embed script loaded but did not start."));
    };
    el.onerror = () => {
      embedScript = null;
      reject(new Error("The embed script could not be loaded. Check your connection."));
    };
    document.head.appendChild(el);
  });
  return embedScript;
}

export function ShareTab(props: TabProps) {
  const { def, published, ownerName } = props;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problems = useMemo(() => formProblems(def), [def]);
  const changed = published !== null && content(def) !== content(published);

  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await props.publish();
      if (r) toast.show("Published. The link is live.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The form was not published. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };

  const problemList =
    problems.length > 0 ? (
      <ul className={s.problems} aria-label="Fix before publishing">
        {problems.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    ) : null;
  const errorBox = error ? <Oops title="Not published">{error}</Oops> : null;

  if (!published)
    return (
      <div className={s.tab}>
        <Panel>
          <EmptyState
            title="Publish to get a link"
            face="sleepy"
            jp="まだ"
            action={
              <Button
                variant="cord"
                icon="send"
                busy={busy}
                disabled={problems.length > 0}
                onClick={() => void publish()}
              >
                Publish
              </Button>
            }
          >
            Publishing signs the form with your key. Then you get a link, a QR code and a button for your page.
          </EmptyState>
          {problemList}
          {errorBox}
        </Panel>
      </div>
    );

  const link = `${SITE_URL}/@${ownerName}/f/${published.slug}`;

  return (
    <div className={s.tab}>
      <div className={s.hero}>
        <Musubi face="happy" size={84} />
        <div>
          <Kicker>できた！</Kicker>
          <h2>Your form is published and ready to be shared.</h2>
          <p>Copy the link for messages, social posts or email. Anyone with it can open the form.</p>
        </div>
      </div>

      {changed ? (
        <div className={s.note} role="status">
          <Icon name="clock" size={16} />
          <span className={s.noteGrow}>
            <b>Changes not published yet.</b> People who open the link see the last published version.
            {problemList}
          </span>
          <Button size="sm" variant="cord" busy={busy} disabled={problems.length > 0} onClick={() => void publish()}>
            Publish
          </Button>
        </div>
      ) : null}
      {errorBox}

      <Panel title="Share the link" kicker="リンク">
        <div className={s.stack}>
          <div className={s.linkBox}>
            <CopyValue
              value={link}
              label="form link"
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
          <QrBlock link={link} slug={published.slug} />
        </div>
      </Panel>

      <PageButton def={def} published={published} />

      <EmbedPanel ownerName={ownerName} slug={published.slug} />

      <LockLine>
        Answers are encrypted inside the form on the respondent&rsquo;s device, also when it is embedded. The website
        around it cannot read them.
      </LockLine>
    </div>
  );
}

function QrBlock({ link, slug }: { link: string; slug: string }) {
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
      (u) => {
        if (alive) {
          setQr(u);
          setFailed(false);
        }
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [link]);
  return (
    <div className={s.qrWrap}>
      {qr ? (
        <img className={s.qr} src={qr} alt="QR code for the form link" />
      ) : failed ? null : (
        <Skeleton height={176} />
      )}
      <div className={s.qrText}>
        <b>QR code</b>
        <p className={s.help}>
          {failed
            ? "The QR code could not be drawn in this browser. The link above works the same."
            : "For posters, tables and slides. Scanning it opens the same link."}
        </p>
        {qr ? (
          <div className={s.row}>
            <ButtonLink href={qr} download={`${slug}-qr.png`} size="sm" variant="line" icon="download">
              Download PNG
            </ButtonLink>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PageButton({ def, published }: { def: FormDef; published: FormDef }) {
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
        setError(
          `${e instanceof Error ? e.message : "Your page was not published."} The button is saved in your page draft.`,
        ),
    );
  }, [queued, o, toast]);

  if (o.loading)
    return (
      <Panel title="Add to my page as a button" kicker="ボタン">
        <Skeleton lines={2} />
      </Panel>
    );
  const d = o.draft;
  if (o.loadError || !d)
    return (
      <Panel title="Add to my page as a button" kicker="ボタン">
        <Oops title="Your page did not open">
          {o.loadError ?? "Your page draft is not available."} The form link still works on its own.
        </Oops>
      </Panel>
    );

  const block = d.manifest.blocks.find(
    (b): b is Extract<Block, { type: "form" }> => b.type === "form" && b.formId === def.id,
  );
  const live =
    o.published?.blocks.some((b) => b.type === "form" && b.formId === def.id && !b.archived && b.on) ?? false;
  const title = (published.title.trim() || "Fill in my form").slice(0, 80);
  const busy = o.publishing || queued !== null;
  const otherChanges = o.dirty;

  const run = (fn: Parameters<typeof o.edit>[0], message: string) => {
    setError(null);
    o.edit(fn);
    setQueued(message);
  };

  const add = () =>
    run((x) => {
      const b: Block = {
        id: newId(),
        type: "form",
        formId: def.id,
        slug: published.slug,
        title,
        subtitle: "Answers are sealed to me",
        on: true,
        archived: false,
      };
      // A "form" placeholder from setup is fulfilled by this block.
      const i = x.pending.findIndex((p) => p.kind === "form");
      const pending = i < 0 ? x.pending : x.pending.filter((_, j) => j !== i);
      return markChecklist(
        { ...x, pending, manifest: { ...x.manifest, blocks: [...x.manifest.blocks, b] } },
        "block",
        "done",
      );
    }, "Added to your page and published");

  let body;
  if (!block)
    body = (
      <>
        <p className={s.help}>
          Adds a button titled &ldquo;{title}&rdquo; to your page, then publishes your page. You can rename or move it
          in My page.
        </p>
        <div className={s.row}>
          <Button variant="cord" icon="plus" busy={busy} onClick={add}>
            Add to my page
          </Button>
        </div>
      </>
    );
  else if (block.archived)
    body = (
      <>
        <p className={s.help}>The button for this form is in your page&rsquo;s archive, so visitors do not see it.</p>
        <div className={s.row}>
          <Button
            variant="cord"
            icon="undo"
            busy={busy}
            onClick={() =>
              run(
                (x) => updateBlock(x, block.id, { archived: false, on: true, slug: published.slug }),
                "The button is back on your page",
              )
            }
          >
            Bring it back
          </Button>
        </div>
      </>
    );
  else
    body = (
      <>
        <p className={s.help}>
          {block.slug !== published.slug
            ? `The button on your page still opens /f/${block.slug}, the old link.`
            : !block.on
              ? "The button is on your page but switched off, so visitors do not see it."
              : live
                ? `“${block.title}” is on your page and live.`
                : `“${block.title}” is in your page draft, not published yet.`}
        </p>
        <div className={s.row}>
          {block.slug !== published.slug || !block.on ? (
            <Button
              variant="cord"
              icon="check"
              busy={busy}
              onClick={() =>
                run(
                  (x) => updateBlock(x, block.id, { slug: published.slug, on: true }),
                  "The button on your page is updated",
                )
              }
            >
              {block.slug !== published.slug ? "Update the button" : "Switch it on"}
            </Button>
          ) : !live ? (
            <Button variant="cord" icon="send" busy={busy} onClick={() => run((x) => x, "Your page is published")}>
              Publish my page
            </Button>
          ) : null}
        </div>
      </>
    );

  return (
    <Panel title="Add to my page as a button" kicker="ボタン">
      <div className={s.pageBlock}>
        <span className={s.pageIcon}>
          <Icon name="form" size={22} />
        </span>
        <div className={s.pageText}>
          {body}
          {otherChanges && !(block && live && block.slug === published.slug && block.on && !block.archived) ? (
            <p className={s.help}>Publishing your page also puts your other unpublished page changes live.</p>
          ) : null}
          {error ? <Oops title="Your page was not published">{error}</Oops> : null}
        </div>
      </div>
    </Panel>
  );
}

function EmbedPanel({ ownerName, slug }: { ownerName: string; slug: string }) {
  const toast = useToast();
  const [mode, setMode] = useState<EmbedMode>("popup");
  const [label, setLabel] = useState(DEFAULT_LABEL);
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [heightText, setHeightText] = useState("560");
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [inlineOn, setInlineOn] = useState(false);
  const [tabOn, setTabOn] = useState(false);
  const mountEl = useRef<HTMLDivElement>(null);
  const tab = useRef<{ remove: () => void } | null>(null);

  const formUrl = `${SITE_URL}/@${ownerName}/f/${slug}`;
  const colorOk = HEX_RE.test(color);
  const height = Math.min(1200, Math.max(300, Number.parseInt(heightText, 10) || 560));
  const heightError =
    /^\d{3,4}$/.test(heightText) && Number(heightText) >= 300 && Number(heightText) <= 1200
      ? null
      : "Use a height from 300 to 1200 pixels.";
  const cleanLabel = label.trim().slice(0, 24) || DEFAULT_LABEL;
  const useColor = colorOk ? color.toLowerCase() : DEFAULT_COLOR;
  const textOnColor = contrast(useColor, "#ffffff") >= 4.5 ? "#ffffff" : "#2b2340";

  const snippet =
    mode === "standard"
      ? `<div data-mizuhiki-inline="${attr(formUrl)}" data-height="${height}"></div>\n<script src="${attr(`${SITE_URL}/embed.js`)}" async></script>`
      : `<script src="${attr(`${SITE_URL}/embed.js`)}" data-mizuhiki-form="${attr(formUrl)}" data-mode="${mode}" data-label="${attr(cleanLabel)}" data-color="${attr(useColor)}" async></script>`;

  // Leave nothing behind from a test when the mode changes or the tab closes.
  useEffect(
    () => () => {
      tab.current?.remove();
      tab.current = null;
      window.MizuhikiEmbed?.close();
    },
    [mode],
  );
  useEffect(() => {
    setTabOn(false);
    if (mode !== "standard") setInlineOn(false);
  }, [mode]);

  /** The test uses this page's own address, so it works on every deployment of this app. */
  const testUrl = () => `${window.location.origin}/@${ownerName}/f/${slug}`;

  const launch = async () => {
    setTesting(true);
    setTestError(null);
    try {
      const api = await loadEmbed();
      if (mode === "standard") {
        const el = mountEl.current;
        if (!el) return;
        el.setAttribute("data-mizuhiki-inline", testUrl());
        el.setAttribute("data-height", String(height));
        if (!api.mount(el)) throw new Error("The embed script refused this link.");
        setInlineOn(true);
      } else if (mode === "sidetab") {
        if (tab.current) {
          tab.current.remove();
          tab.current = null;
          setTabOn(false);
        } else {
          tab.current = api.sideTab(testUrl(), { label: cleanLabel, color: useColor });
          if (!tab.current) throw new Error("The embed script refused this link.");
          setTabOn(true);
          toast.show("The side tab is on the right edge of this page");
        }
      } else if (!api.open(testUrl(), { mode })) throw new Error("The embed script refused this link.");
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "The test did not start.");
    } finally {
      setTesting(false);
    }
  };

  const copy = () =>
    navigator.clipboard.writeText(snippet).then(
      () => toast.show("Code copied. Paste it into your website's HTML."),
      () => toast.show("Copy is not allowed here. Select the code and copy it by hand.", { tone: "error" }),
    );

  return (
    <Panel title="Embed on other websites" kicker="うめこみ">
      <div className={s.stack}>
        <Segmented<EmbedMode>
          label="Embed mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: "standard", label: "Standard" },
            { value: "popup", label: "Popup" },
            { value: "slider", label: "Slider" },
            { value: "sidetab", label: "Side tab" },
          ]}
        />
        <p className={s.help}>
          {mode === "standard"
            ? "The form sits inside your page, full width, at the height you choose."
            : mode === "popup"
              ? "A button opens the form in a window over your page."
              : mode === "slider"
                ? "A button slides the form in from the right."
                : "A tab stays on the right edge of every page it is on, and slides the form in."}{" "}
          On phones, the popup and slider fill the screen.
        </p>
        <div className={s.options}>
          {mode === "standard" ? (
            <TextField
              label="Height in pixels"
              inputMode="numeric"
              value={heightText}
              onChange={(e) => setHeightText(e.target.value.replace(/\D/g, "").slice(0, 4))}
              error={heightError ?? undefined}
            />
          ) : (
            <>
              <TextField
                label="Button text"
                maxLength={24}
                counter
                value={label}
                onChange={(e) => setLabel(e.target.value.slice(0, 24))}
              />
              <div className={s.fieldRow}>
                <TextField
                  label="Button colour"
                  maxLength={7}
                  spellCheck={false}
                  autoCapitalize="none"
                  value={color}
                  onChange={(e) => {
                    const t = e.target.value.trim();
                    setColor(t && !t.startsWith("#") ? `#${t}` : t);
                  }}
                  error={colorOk ? undefined : "Use six hex digits, like #c2300f."}
                />
                <span
                  className={[s.accentSample, s.fieldAction].join(" ")}
                  style={{ background: useColor, color: textOnColor }}
                  aria-hidden="true"
                >
                  {cleanLabel}
                </span>
              </div>
            </>
          )}
        </div>
        <pre className={s.code} aria-label="Embed code">
          <code>{snippet}</code>
        </pre>
        <div className={s.row}>
          <Button variant="line" icon="copy" onClick={() => void copy()}>
            Copy code
          </Button>
          <Button
            variant="cord"
            icon="eye"
            busy={testing}
            disabled={mode === "standard" && heightError !== null}
            onClick={() => void launch()}
          >
            {mode === "sidetab" && tabOn ? "Remove the test tab" : "Launch me"}
          </Button>
          {mode === "standard" && inlineOn ? (
            <Button
              variant="ghost"
              icon="x"
              onClick={() => {
                if (mountEl.current) mountEl.current.replaceChildren();
                setInlineOn(false);
              }}
            >
              Hide test
            </Button>
          ) : null}
        </div>
        <p className={s.help}>Hit the button to see it in action on this page, with the same script your site loads.</p>
        {testError ? <Oops title="The test did not start">{testError}</Oops> : null}
        <div ref={mountEl} className={inlineOn ? s.mount : undefined} hidden={!inlineOn} />
      </div>
    </Panel>
  );
}
