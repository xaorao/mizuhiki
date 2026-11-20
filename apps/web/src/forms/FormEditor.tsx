"use client";
/**
 * The form editor (spec 5.9). Typeform's tabs (Build · Logic · Settings ·
 * Share · Results) around Tally's doc-style builder. The working copy autosaves
 * sealed to the owner; Publish signs it with the owner's keys. Preview runs the
 * real respondent screen and never sends anything.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, IconButton, Oops, Sheet, Skeleton, StatusChip, Tabs, useToast } from "@mizuhiki/ui";
import { canonicalJson, formProblems, type FormDef, type Signed } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { api, ApiFailure } from "@/lib/api";
import { themeVars } from "@/page/theme";
import { openDraft, publishForm, saveFormDraft, type FormRow } from "./model";
import { FormRunner } from "./FormRunner";
import { BuildTab } from "./BuildTab";
import { LogicTab } from "./LogicTab";
import { SettingsTab } from "./SettingsTab";
import { ShareTab } from "./ShareTab";
import { ResultsTab } from "./ResultsTab";
import type { TabProps } from "./tabTypes";
import s from "./forms.module.css";

type Tab = "build" | "logic" | "settings" | "share" | "results";
const TABS: { value: Tab; label: string }[] = [
  { value: "build", label: "Build" },
  { value: "logic", label: "Logic" },
  { value: "settings", label: "Settings" },
  { value: "share", label: "Share" },
  { value: "results", label: "Results" },
];

/** Compare what matters for "unpublished changes" (not version or timestamp). */
const same = (a: FormDef | null, b: FormDef | null) =>
  !!a &&
  !!b &&
  canonicalJson({ ...a, version: 0, updatedAt: "" }) === canonicalJson({ ...b, version: 0, updatedAt: "" });

export function FormEditor({ id }: { id: string }) {
  const acct = useAccount();
  const owner = useOwner();
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const account = acct.account;
  if (!account) throw new Error("Forms need an unlocked account");
  const ownerName = owner.draft?.manifest.name ?? "";
  const [def, setDef] = useState<FormDef | null>(null);
  const latest = useRef<FormDef | null>(null);
  latest.current = def;
  const [published, setPublished] = useState<FormDef | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab | null) ?? "build");
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [preview, setPreview] = useState<"desktop" | "phone" | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const past = useRef<FormDef[]>([]);
  const future = useRef<FormDef[]>([]);
  const lastCoalesce = useRef<{ key: string; at: number } | null>(null);
  const dirty = useRef(false);

  // Load the sealed draft and the published definition.
  useEffect(() => {
    void (async () => {
      try {
        const t = await owner.token();
        const { forms } = await api.get<{ forms: FormRow[] }>("/owner/forms", { token: t });
        const row = forms.find((f) => f.id === id);
        if (!row?.draftEnvelope) throw new Error("This form does not exist, or it is not yours.");
        const d = openDraft(account, id, await api.bytes(`/blobs/${row.draftEnvelope}`));
        setDef(d);
        if (row.published && ownerName) {
          const served = await api
            .get<{ record: Signed<FormDef> }>(`/forms/${ownerName}/${row.slug}`)
            .catch(() => null);
          setPublished(served?.record.body ?? null);
        }
      } catch (e) {
        setLoadErr(e instanceof ApiFailure ? e.message : (e as Error).message || "This form could not be opened.");
      }
    })();
  }, [account, id, owner, ownerName]);

  // History lives outside state updaters (they must be pure: React runs them twice in development, which made one
  // Undo skip two steps). `latest` moves at once so edits made before the next render build on each other.
  const update = useCallback<TabProps["update"]>((fn, coalesce) => {
    const cur = latest.current;
    if (!cur) return;
    const next = fn(cur);
    if (next === cur) return;
    const now = Date.now();
    const merge = coalesce && lastCoalesce.current?.key === coalesce && now - lastCoalesce.current.at < 1200;
    if (!merge) {
      past.current = [...past.current.slice(-99), cur];
      future.current = [];
    }
    lastCoalesce.current = coalesce ? { key: coalesce, at: now } : null;
    dirty.current = true;
    setProblems([]);
    latest.current = next;
    setDef(next);
  }, []);

  const undo = useCallback(() => {
    const cur = latest.current;
    const prev = past.current.at(-1);
    if (!prev || !cur) return;
    past.current = past.current.slice(0, -1);
    future.current = [...future.current, cur];
    lastCoalesce.current = null;
    dirty.current = true;
    latest.current = prev;
    setDef(prev);
  }, []);
  const redo = useCallback(() => {
    const cur = latest.current;
    const next = future.current.at(-1);
    if (!next || !cur) return;
    future.current = future.current.slice(0, -1);
    past.current = [...past.current, cur];
    lastCoalesce.current = null;
    dirty.current = true;
    latest.current = next;
    setDef(next);
  }, []);

  // Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z (not while typing in a field: the browser undoes text there).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [undo, redo]);

  // Autosave the sealed draft shortly after the last change.
  useEffect(() => {
    if (!def || !dirty.current) return;
    const h = setTimeout(() => {
      dirty.current = false;
      setSave("saving");
      void owner
        .token()
        .then((t) => saveFormDraft(account, t, def))
        .then(
          () => setSave("saved"),
          (e: unknown) => {
            dirty.current = true;
            setSave("error");
            if (e instanceof ApiFailure && e.code === "SLUG_TAKEN") toast.show(e.message, { tone: "error" });
          },
        );
    }, 900);
    return () => clearTimeout(h);
  }, [account, def, owner, toast]);

  const publish = useCallback(async (): Promise<FormDef | null> => {
    if (!def) return null;
    const p = formProblems(def);
    setProblems(p);
    if (p.length) {
      setTab("build");
      return null;
    }
    setPublishing(true);
    try {
      const body = await publishForm(account, await owner.token(), def, published?.version ?? 0);
      setPublished(body);
      setDef(body);
      dirty.current = false;
      setSave("saved");
      toast.show("Published, signed with your key");
      return body;
    } catch (e) {
      const msg = e instanceof ApiFailure ? e.message : "The form could not be published. Nothing changed.";
      setProblems([msg]);
      throw new Error(msg, { cause: e });
    } finally {
      setPublishing(false);
    }
  }, [account, def, owner, published, toast]);

  if (loadErr)
    return (
      <div className={s.page}>
        <Oops
          title="Not opened"
          action={
            <Button variant="line" onClick={() => router.push("/app/forms")}>
              Back to forms
            </Button>
          }
        >
          {loadErr}
        </Oops>
      </div>
    );
  if (!def)
    return (
      <div className={s.page}>
        <Skeleton lines={6} />
      </div>
    );

  const changed = published ? !same(def, published) : true;
  const props: TabProps = { def, update, account, token: owner.token, published, ownerName, publish };
  return (
    <div className={s.editor}>
      <header className={s.edTop}>
        <IconButton icon="back" label="Back to forms" onClick={() => router.push("/app/forms")} />
        <h1>{def.title || "Untitled form"}</h1>
        {published ? (
          changed ? (
            <StatusChip status="wait">Changes not published</StatusChip>
          ) : (
            <StatusChip status="ok">Published</StatusChip>
          )
        ) : (
          <StatusChip status="neutral">Draft</StatusChip>
        )}
        <span className={s.saveState} aria-live="polite">
          {save === "saving"
            ? "Saving sealed draft…"
            : save === "saved"
              ? "Draft saved, sealed"
              : save === "error"
                ? "Not saved. Retrying…"
                : ""}
        </span>
        <div className={s.edActions}>
          <IconButton icon="undo" label="Undo" onClick={undo} disabled={past.current.length === 0} />
          <IconButton icon="redo" label="Redo" onClick={redo} disabled={future.current.length === 0} />
          <Button variant="line" icon="eye" onClick={() => setPreview("desktop")}>
            Preview
          </Button>
          <Button
            variant="cord"
            icon="send"
            busy={publishing}
            disabled={published !== null && !changed}
            onClick={() => void publish().catch(() => undefined)}
          >
            {published ? "Publish changes" : "Publish"}
          </Button>
        </div>
      </header>
      {problems.length ? (
        <Oops title="Not published yet">
          <ul className={s.problemList}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Oops>
      ) : null}
      <Tabs label="Form sections" value={tab} onChange={setTab} tabs={TABS} />
      <div className={s.tabBody}>
        {tab === "build" ? <BuildTab {...props} /> : null}
        {tab === "logic" ? <LogicTab {...props} /> : null}
        {tab === "settings" ? <SettingsTab {...props} /> : null}
        {tab === "share" ? <ShareTab {...props} /> : null}
        {tab === "results" ? <ResultsTab {...props} /> : null}
      </div>

      <Sheet open={preview !== null} onClose={() => setPreview(null)} title="Preview" wide>
        <div className={s.previewBar}>
          <Button
            size="sm"
            variant={preview === "desktop" ? "ink" : "line"}
            icon="desktop"
            onClick={() => setPreview("desktop")}
          >
            Desktop
          </Button>
          <Button
            size="sm"
            variant={preview === "phone" ? "ink" : "line"}
            icon="phone"
            onClick={() => setPreview("phone")}
          >
            Phone
          </Button>
          <span>Answers here are not sent.</span>
        </div>
        {preview ? (
          <div className={preview === "phone" ? s.previewPhone : s.previewDesktop}>
            <FormRunner
              key={`${preview}-${def.updatedAt}-${String(past.current.length)}`}
              def={def}
              ownerCard={null}
              ownerName={ownerName}
              pageStyle={owner.draft ? themeVars(owner.draft.manifest.theme) : undefined}
              preview
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
