"use client";
/**
 * The product editor (Gumroad 3): the product name as title, pill tabs
 * Product · Content · Receipt · Share, header actions that follow the state,
 * and a sticky live preview on the right (a Preview sheet on phones). The
 * working copy is sealed to the owner and autosaved shortly after each change;
 * undo and redo cover every edit; Publish signs the record with the owner's key.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, ButtonLink, Icon, IconButton, Oops, Sheet, Skeleton, StatusChip, Tabs, useToast } from "@mizuhiki/ui";
import { useOwner } from "@/owner/OwnerProvider";
import { ApiFailure } from "@/lib/api";
import { SITE_URL } from "@/lib/site";
import {
  listMyProducts,
  openDraft,
  publish as publishProduct,
  publishProblems,
  saveDraft,
  setProductStatus,
  withToken,
  type OwnerProduct,
} from "../engine";
import { allProblems, fingerprint, productPath, type EditorDraft } from "./model";
import type { EditorProps } from "./editorTypes";
import { ProductTab } from "./ProductTab";
import { ContentTab } from "./ContentTab";
import { ReceiptTab } from "./ReceiptTab";
import { ShareTab } from "./ShareTab";
import { ProductPreview, ReceiptPreview } from "./ProductPreview";
import s from "./seller.module.css";
import { failureText } from "@/lib/failure";

type Tab = "product" | "content" | "receipt" | "share";
const TABS: { value: Tab; label: string }[] = [
  { value: "product", label: "Product" },
  { value: "content", label: "Content" },
  { value: "receipt", label: "Receipt" },
  { value: "share", label: "Share" },
];
const isTab = (t: string | null): t is Tab => TABS.some((x) => x.value === t);
type Save = "idle" | "pending" | "saving" | "saved" | "error";
type Step = "content" | "sign" | "upload" | null;
const STEP_LABEL: Record<Exclude<Step, null>, string> = {
  content: "Sealing the content with the product key…",
  sign: "Signing with your post-quantum key…",
  upload: "Publishing…",
};

/** Which tab holds the fix for a publish problem. */
const tabFor = (p: string): Tab => (/Content|link needs/.test(p) ? "content" : "product");

export function ProductEditor({ id }: { id: string }) {
  const owner = useOwner();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const name = owner.published?.name ?? owner.draft?.manifest.name ?? "";
  const displayName = owner.published?.displayName ?? owner.draft?.manifest.displayName ?? "";
  const [row, setRow] = useState<OwnerProduct | null>(null);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const q = params.get("tab");
  const [tab, setTab] = useState<Tab>(isTab(q) ? q : "product");
  const [save, setSave] = useState<Save>("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [step, setStep] = useState<Step>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const past = useRef<EditorDraft[]>([]);
  const future = useRef<EditorDraft[]>([]);
  const coalesced = useRef<{ key: string; at: number } | null>(null);
  const latest = useRef<EditorDraft | null>(null);
  latest.current = draft;
  const rowRef = useRef<OwnerProduct | null>(null);
  rowRef.current = row;
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [, bump] = useState(0);

  const { account: ownerAccount, token: ownerToken } = owner;
  const tokened = useCallback(async () => withToken(ownerAccount, await ownerToken()), [ownerAccount, ownerToken]);

  const refreshRow = useCallback(async () => {
    const r = (await listMyProducts(await tokened())).find((p) => p.id === id);
    if (r) setRow(r);
    return r;
  }, [id, tokened]);

  // Open the sealed working copy.
  useEffect(() => {
    void (async () => {
      try {
        const a = await tokened();
        const r = (await listMyProducts(a)).find((p) => p.id === id);
        if (!r) throw new Error("This product does not exist, or it is not yours.");
        const d = (await openDraft(a, r)) as EditorDraft;
        setRow(r);
        setDraft(d);
      } catch (e) {
        setLoadErr(
          e instanceof ApiFailure
            ? e.message
            : e instanceof Error && e.message.includes("not yours")
              ? e.message
              : "This product's working copy did not open on this device. It is sealed to your key; nothing was changed.",
        );
      }
    })();
  }, [id, tokened]);

  const flush = useCallback(async (): Promise<boolean> => {
    clearTimeout(timer.current);
    const d = latest.current;
    if (!d || !dirty.current) return true;
    dirty.current = false;
    setSave("saving");
    try {
      await saveDraft(await tokened(), d, rowRef.current?.agentEnvelope ?? null);
      setSave("saved");
      setSaveErr(null);
      setSlugError(null);
      return true;
    } catch (e) {
      dirty.current = true;
      setSave("error");
      if (e instanceof ApiFailure && e.code === "SLUG_TAKEN") {
        setSlugError(e.message);
        setSaveErr(null);
      } else setSaveErr(failureText(e, "Your latest changes are not saved yet. They are still here; we keep trying."));
      return false;
    }
  }, [tokened]);

  const schedule = useCallback(() => {
    dirty.current = true;
    setSave("pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 900);
  }, [flush]);

  // Retry a failed save when the connection comes back, and every 15 s while it keeps failing.
  useEffect(() => {
    if (save !== "error" || slugError) return;
    const on = () => void flush();
    addEventListener("online", on);
    const t = setInterval(on, 15_000);
    return () => {
      removeEventListener("online", on);
      clearInterval(t);
    };
  }, [save, slugError, flush]);

  // Leaving: save what is pending, and warn while something is not saved.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault();
        void flush();
      }
    };
    const click = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest("a[href]");
      if (!a || a.getAttribute("target") === "_blank" || !dirty.current) return;
      if (save === "error" && !confirm("Your latest changes are not saved yet. Leave anyway?")) {
        e.preventDefault();
        e.stopPropagation();
      } else void flush();
    };
    addEventListener("beforeunload", warn);
    document.addEventListener("click", click, true);
    return () => {
      removeEventListener("beforeunload", warn);
      document.removeEventListener("click", click, true);
    };
  }, [flush, save]);
  useEffect(
    () => () => {
      if (dirty.current) void flush();
    },
    [flush],
  );

  const update = useCallback<EditorProps["update"]>(
    (fn, key) => {
      const cur = latest.current;
      if (!cur) return;
      const next = fn(cur);
      if (next === cur) return;
      const now = Date.now();
      const merge = key && coalesced.current?.key === key && now - coalesced.current.at < 1200;
      if (!merge) {
        past.current = [...past.current.slice(-99), cur];
        future.current = [];
      }
      coalesced.current = key ? { key, at: now } : null;
      latest.current = next;
      setDraft(next);
      setProblems([]);
      schedule();
    },
    [schedule],
  );
  const patch = useCallback<EditorProps["patch"]>(
    (p, key) => update((d) => ({ ...d, def: { ...d.def, ...(typeof p === "function" ? p(d.def) : p) } }), key),
    [update],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    const cur = latest.current;
    if (!prev || !cur) return;
    future.current.push(cur);
    coalesced.current = null;
    latest.current = prev;
    setDraft(prev);
    bump((x) => x + 1);
    schedule();
  }, [schedule]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    const cur = latest.current;
    if (!next || !cur) return;
    past.current.push(cur);
    coalesced.current = null;
    latest.current = next;
    setDraft(next);
    bump((x) => x + 1);
    schedule();
  }, [schedule]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    const fromToast = () => undo();
    addEventListener("keydown", key);
    document.addEventListener("mzk-shop-undo", fromToast);
    return () => {
      removeEventListener("keydown", key);
      document.removeEventListener("mzk-shop-undo", fromToast);
    };
  }, [undo, redo]);

  const publish = useCallback(async (): Promise<boolean> => {
    const d = latest.current;
    if (!d) return false;
    const p = allProblems(publishProblems(d), d);
    if (!name) p.unshift("Your page is not set up yet. Finish your page first, so the product has an address.");
    if (slugError) p.unshift(slugError);
    setProblems(p);
    if (p.length) {
      setTab(tabFor(p[0] ?? ""));
      return false;
    }
    clearTimeout(timer.current);
    const first = !rowRef.current?.record;
    try {
      setStep("content");
      const signing: EditorDraft = { ...d, publishedFp: fingerprint(d) };
      const next = await publishProduct(await tokened(), signing, setStep);
      const kept: EditorDraft = { ...next, publishedFp: fingerprint(next) };
      dirty.current = false;
      // Keep edits made while publishing; otherwise take the signed copy (it carries the new version).
      if (latest.current === d) {
        latest.current = kept;
        setDraft(kept);
      } else {
        const mine = latest.current;
        if (mine) {
          const merged = {
            ...mine,
            def: { ...mine.def, version: kept.def.version, content: kept.def.content, updatedAt: kept.def.updatedAt },
            publishedFp: kept.publishedFp,
          };
          latest.current = merged;
          setDraft(merged);
          schedule();
        }
      }
      setSave("saved");
      await refreshRow();
      toast.show(first ? "Published. Your link is live. できた！" : "Published. Buyers see the new version. できた！");
      if (first) setTab("share");
      return true;
    } catch (e) {
      setProblems([
        e instanceof ApiFailure
          ? e.message
          : e instanceof Error && e.message
            ? `${e.message} Nothing was published.`
            : "It was not published. Nothing changed.",
      ]);
      dirty.current = true;
      return false;
    } finally {
      setStep(null);
    }
  }, [name, slugError, tokened, refreshRow, toast, schedule]);

  const setStatus = async (to: "published" | "unpublished") => {
    setStatusBusy(true);
    try {
      await setProductStatus(await tokened(), id, to);
      await refreshRow();
      toast.show(
        to === "unpublished"
          ? "Unpublished. The link now says it is not available; buyers keep their copies."
          : "Published again. The link is live.",
      );
    } catch (e) {
      toast.show(failureText(e, "That did not work. Nothing changed."), { tone: "error" });
    } finally {
      setStatusBusy(false);
    }
  };

  if (loadErr)
    return (
      <div className={s.page}>
        <Oops
          title="Not opened"
          action={
            <Button variant="line" icon="back" onClick={() => router.push("/app/shop")}>
              Back to Shop
            </Button>
          }
        >
          {loadErr}
        </Oops>
      </div>
    );
  if (!draft || !row)
    return (
      <div className={s.editor} aria-busy="true">
        <Skeleton height={44} />
        <div className={s.edGrid}>
          <div className={s.stack}>
            <Skeleton lines={4} />
            <Skeleton lines={5} />
          </div>
          <Skeleton height={420} />
        </div>
      </div>
    );

  const def = draft.def;
  const published = !!row.record;
  const live = row.status === "published";
  const changed = published && fingerprint(draft) !== draft.publishedFp;
  const link = name ? `${SITE_URL}${productPath(name, row.record?.body.slug ?? def.slug)}` : null;
  const publishing = step !== null;
  const props: EditorProps = { draft, update, patch, tokened, name, displayName, row, slugError, publish, publishing };
  const pane =
    tab === "receipt" ? (
      <ReceiptPreview def={def} name={name} displayName={displayName} />
    ) : (
      <ProductPreview def={def} name={name} displayName={displayName} />
    );

  return (
    <div className={s.editor}>
      <header className={s.edTop}>
        <IconButton icon="back" label="Back to Shop" onClick={() => router.push("/app/shop")} />
        <h1 title={def.title}>{def.title || "Untitled product"}</h1>
        {published ? (
          !live ? (
            <StatusChip status="neutral">Unpublished</StatusChip>
          ) : changed ? (
            <StatusChip status="wait">Changes not published</StatusChip>
          ) : (
            <StatusChip status="ok">Published</StatusChip>
          )
        ) : (
          <StatusChip status="neutral">Draft</StatusChip>
        )}
        <span className={[s.saveState, save === "error" ? s.saveBad : ""].join(" ")} aria-live="polite">
          {step
            ? STEP_LABEL[step]
            : save === "pending" || save === "saving"
              ? "Saving sealed draft…"
              : save === "saved"
                ? "Draft saved, sealed"
                : save === "error"
                  ? slugError
                    ? "Not saved: pick another link"
                    : "Not saved yet. Retrying…"
                  : ""}
        </span>
        <div className={s.edActions}>
          <IconButton icon="undo" label="Undo" onClick={undo} disabled={past.current.length === 0} />
          <IconButton icon="redo" label="Redo" onClick={redo} disabled={future.current.length === 0} />
          <Button variant="line" icon="eye" className={s.onlyPhoneInline} onClick={() => setPreview(true)}>
            Preview
          </Button>
          {link && live ? (
            <>
              <IconButton
                icon="link"
                label="Copy link"
                onClick={() =>
                  void navigator.clipboard.writeText(link).then(
                    () => toast.show("Link copied"),
                    () => toast.show("Copy is not allowed here", { tone: "error" }),
                  )
                }
              />
              <ButtonLink
                href={link}
                target="_blank"
                rel="noopener"
                variant="line"
                icon="eye"
                className={s.hideOnPhone}
              >
                View
              </ButtonLink>
            </>
          ) : null}
          {published && live ? (
            <Button
              variant="ghost"
              size="sm"
              icon="eye"
              className={s.unpublish}
              busy={statusBusy}
              onClick={() => void setStatus("unpublished")}
            >
              Unpublish
            </Button>
          ) : null}
          {!published ? (
            <>
              <Button
                variant="line"
                busy={save === "saving"}
                className={s.hideOnPhone}
                onClick={() => {
                  dirty.current = true;
                  void flush().then((ok) => ok && toast.show("Changes saved"));
                }}
              >
                Save changes
              </Button>
              <Button variant="cord" icon="send" busy={publishing} onClick={() => void publish()}>
                Publish and continue
              </Button>
            </>
          ) : !live && !changed ? (
            <Button variant="cord" icon="send" busy={statusBusy} onClick={() => void setStatus("published")}>
              Publish
            </Button>
          ) : changed ? (
            <Button variant="cord" icon="send" busy={publishing} onClick={() => void publish()}>
              Publish changes
            </Button>
          ) : null}
        </div>
      </header>
      {saveErr ? (
        <Oops
          title="Not saved yet"
          action={
            <Button size="sm" variant="line" icon="undo" onClick={() => void flush()}>
              Save now
            </Button>
          }
        >
          {saveErr}
        </Oops>
      ) : null}
      {problems.length ? (
        <Oops title="Not published yet">
          <ul className={s.problems}>
            {problems.map((p) => (
              <li key={p}>
                <button type="button" className={s.linkBtn} onClick={() => setTab(tabFor(p))}>
                  {p}
                </button>
              </li>
            ))}
          </ul>
        </Oops>
      ) : null}
      <div className={s.tabsRow}>
        <Tabs label="Product sections" value={tab} onChange={setTab} tabs={TABS} />
      </div>
      <div className={tab === "content" ? s.edFull : s.edGrid}>
        <div className={s.edMain}>
          {tab === "product" ? <ProductTab {...props} /> : null}
          {tab === "content" ? <ContentTab {...props} /> : null}
          {tab === "receipt" ? <ReceiptTab {...props} /> : null}
          {tab === "share" ? <ShareTab {...props} /> : null}
        </div>
        {tab !== "content" ? (
          <aside className={s.edPane} aria-label="Live preview">
            <div className={s.paneHead}>
              <b>Preview</b>
              {link && live ? (
                <a href={link} target="_blank" rel="noopener" className={s.paneOpen}>
                  <Icon name="share" size={15} /> Open live page
                </a>
              ) : (
                <small>{tab === "receipt" ? "What buyers get after paying" : "What buyers see"}</small>
              )}
            </div>
            <div className={s.paneBody}>{pane}</div>
          </aside>
        ) : null}
      </div>
      <Sheet open={preview} onClose={() => setPreview(false)} title={tab === "receipt" ? "Receipt preview" : "Preview"}>
        {pane}
      </Sheet>
    </div>
  );
}
