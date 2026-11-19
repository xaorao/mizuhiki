"use client";
/**
 * Content (Gumroad 4): what the buyer gets, as pages of text, headings, links
 * and file cards. Files are sealed here in 4 MiB pieces, each piece uploaded
 * as ciphertext; the file's key lives only inside this content, which is
 * sealed with the product key. Only buyers ever get that key.
 */
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button, Icon, IconButton, LockLine, TextArea, TextField, useToast } from "@mizuhiki/ui";
import { decryptFile, encryptFile, parseFileFacts, utf8, type ContentBlock, type FileFacts } from "@mizuhiki/core";
import { api, ApiFailure } from "@/lib/api";
import { newId } from "../engine";
import { Confirm } from "./bits";
import { fileKind, formatBytes, move, uploadLine } from "./model";
import type { EditorProps } from "./editorTypes";
import s from "./seller.module.css";

const MAX_FILE = 2 * 1024 * 1024 * 1024;

interface Upload {
  id: string;
  pageId: string;
  name: string;
  type: string;
  done: number;
  total: number;
  ctrl: AbortController;
  error?: string;
}

type Page = EditorProps["draft"]["content"]["pages"][number];

export function ContentTab({ draft, update, tokened }: EditorProps) {
  const toast = useToast();
  const pages = draft.content.pages;
  const [at, setAt] = useState(0);
  const page = pages[Math.min(at, pages.length - 1)] as Page;
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dropOn, setDropOn] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [killPage, setKillPage] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const live = useRef(uploads);
  live.current = uploads;

  // Leaving the tab cancels uploads still running (their pieces expire unclaimed).
  useEffect(() => () => live.current.forEach((u) => u.ctrl.abort()), []);

  const setPages = (fn: (ps: Page[]) => Page[], coalesce?: string) =>
    update((d) => ({ ...d, content: { ...d.content, pages: fn(d.content.pages) } }), coalesce);
  const setBlocks = (pageId: string, fn: (bs: ContentBlock[]) => ContentBlock[], coalesce?: string) =>
    setPages((ps) => ps.map((p) => (p.id === pageId ? { ...p, blocks: fn(p.blocks) } : p)), coalesce);

  const addBlock = (b: ContentBlock) =>
    setBlocks(page.id, (bs) => {
      // Fill the starting empty text block rather than leaving it above.
      const onlyEmpty = bs.length === 1 && bs[0]?.t === "text" && !bs[0].text.trim();
      return onlyEmpty && b.t !== "text" ? [b] : [...bs, b];
    });

  const sealFiles = async (files: File[]) => {
    for (const f of files) {
      if (f.size > MAX_FILE) {
        toast.show(`${f.name} is larger than 2 GB. Nothing left your device.`, { tone: "error" });
        continue;
      }
      const u: Upload = {
        id: newId("up"),
        pageId: page.id,
        name: f.name,
        type: f.type,
        done: 0,
        total: f.size,
        ctrl: new AbortController(),
      };
      setUploads((x) => [...x, u]);
      const patchU = (p: Partial<Upload>) => setUploads((x) => x.map((y) => (y.id === u.id ? { ...y, ...p } : y)));
      try {
        const a = await tokened();
        const facts: FileFacts = await encryptFile({
          source: f,
          name: f.name,
          type: f.type,
          maxBytes: MAX_FILE,
          signal: u.ctrl.signal,
          onChunk: async (c) => {
            await api.put("/blobs", c.bytes, { token: a.token, signal: u.ctrl.signal });
          },
          onProgress: (done, total) => patchU({ done, total }),
        });
        setUploads((x) => x.filter((y) => y.id !== u.id));
        setBlocks(u.pageId, (bs) => {
          const onlyEmpty = bs.length === 1 && bs[0]?.t === "text" && !bs[0].text.trim();
          const block: ContentBlock = { t: "file", file: facts as unknown as Record<string, unknown> };
          return onlyEmpty ? [block] : [...bs, block];
        });
      } catch (e) {
        if (u.ctrl.signal.aborted) {
          setUploads((x) => x.filter((y) => y.id !== u.id));
          toast.show(`${f.name} cancelled. Pieces already sent are deleted within a day.`, { tone: "info" });
        } else
          patchU({
            error:
              e instanceof ApiFailure
                ? `${e.message} Pieces already sent are deleted within a day.`
                : `${e instanceof Error && e.message ? e.message : "It did not upload."} Nothing was added.`,
          });
      }
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDropOn(false);
    if (e.dataTransfer.files.length) void sealFiles([...e.dataTransfer.files]);
  };

  const pageUploads = uploads.filter((u) => u.pageId === page.id);
  const empty =
    page.blocks.length === 0 ||
    (page.blocks.length === 1 && page.blocks[0]?.t === "text" && !page.blocks[0].text.trim());

  return (
    <div className={s.tabStack}>
      <div className={s.pageTabs} role="tablist" aria-label="Content pages">
        {pages.map((p, i) => (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={i === at}
            className={s.pageTab}
            onClick={() => setAt(i)}
          >
            {p.title.trim() || `Page ${i + 1}`}
          </button>
        ))}
        {pages.length < 60 ? (
          <Button
            size="sm"
            variant="line"
            icon="plus"
            onClick={() => {
              setPages((ps) => [...ps, { id: newId("pg"), title: "", blocks: [{ t: "text", text: "" }] }]);
              setAt(pages.length);
            }}
          >
            Page
          </Button>
        ) : null}
      </div>

      <section
        className={[s.contentSheet, dropOn ? s.dropOn : ""].join(" ")}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDropOn(true);
          }
        }}
        onDragLeave={() => setDropOn(false)}
        onDrop={onDrop}
        aria-label={`Page ${at + 1}`}
      >
        <div className={s.pageHead}>
          <TextField
            label="Page title"
            hideLabel
            className={s.pageTitle}
            value={page.title}
            maxLength={120}
            placeholder={pages.length > 1 ? `Page ${at + 1} title` : "Title (optional)"}
            onChange={(e) =>
              setPages((ps) => ps.map((p) => (p.id === page.id ? { ...p, title: e.target.value } : p)), `pt-${page.id}`)
            }
          />
          {pages.length > 1 ? (
            <div className={s.pageTools}>
              <IconButton
                icon="back"
                label="Move page earlier"
                disabled={at === 0}
                onClick={() => (setPages((ps) => move(ps, at, at - 1)), setAt(at - 1))}
              />
              <IconButton
                icon="arrow"
                label="Move page later"
                disabled={at === pages.length - 1}
                onClick={() => (setPages((ps) => move(ps, at, at + 1)), setAt(at + 1))}
              />
              <IconButton icon="trash" label="Delete this page" onClick={() => setKillPage(at)} />
            </div>
          ) : null}
        </div>

        {empty && pageUploads.length === 0 ? (
          <p className={s.contentHint}>Enter the content you want to sell. Upload your files or start typing.</p>
        ) : null}

        <ol className={s.blocks}>
          {page.blocks.map((b, i) => (
            <li
              key={`${page.id}-${i}`}
              className={[s.blockRow, dragFrom === i ? s.dragging : ""].join(" ")}
              onDragOver={(e) => {
                if (dragFrom !== null) e.preventDefault();
              }}
              onDrop={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                e.stopPropagation();
                setBlocks(page.id, (bs) => move(bs, dragFrom, i));
                setDragFrom(null);
              }}
            >
              <span
                className={s.grip}
                draggable
                onDragStart={(e) => {
                  setDragFrom(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                }}
                onDragEnd={() => setDragFrom(null)}
                aria-hidden="true"
              >
                <Icon name="grip" size={18} />
              </span>
              <div className={s.blockBody}>
                <BlockEditor
                  block={b}
                  onChange={(nb, key) =>
                    setBlocks(page.id, (bs) => bs.map((x, j) => (j === i ? nb : x)), key && `${key}-${page.id}-${i}`)
                  }
                />
              </div>
              <div className={s.blockTools}>
                <IconButton
                  icon="chev"
                  size="sm"
                  className={s.rotUp}
                  label="Move up"
                  disabled={i === 0}
                  onClick={() => setBlocks(page.id, (bs) => move(bs, i, i - 1))}
                />
                <IconButton
                  icon="chev"
                  size="sm"
                  className={s.rotDown}
                  label="Move down"
                  disabled={i === page.blocks.length - 1}
                  onClick={() => setBlocks(page.id, (bs) => move(bs, i, i + 1))}
                />
                <IconButton
                  icon="trash"
                  size="sm"
                  label="Remove"
                  onClick={() =>
                    setBlocks(page.id, (bs) =>
                      bs.length === 1 ? [{ t: "text", text: "" }] : bs.filter((_, j) => j !== i),
                    )
                  }
                />
              </div>
            </li>
          ))}
          {pageUploads.map((u) => (
            <li key={u.id} className={s.blockRow}>
              <span className={s.grip} aria-hidden="true" />
              <div className={[s.fileCard, u.error ? s.fileBad : ""].join(" ")}>
                <span className={s.fileIcon}>
                  {u.error ? <Icon name="alert" size={20} /> : <span className={s.spinner} aria-hidden="true" />}
                </span>
                <span className={s.fileText}>
                  <b>{u.name}</b>
                  <small aria-live="polite">{u.error ?? uploadLine(u.name, u.type, u.done, u.total)}</small>
                  {!u.error ? (
                    <span className={s.bar} aria-hidden="true">
                      <span style={{ transform: `scaleX(${u.total ? u.done / u.total : 1})` }} />
                    </span>
                  ) : null}
                </span>
                {u.error ? (
                  <Button size="sm" variant="ghost" onClick={() => setUploads((x) => x.filter((y) => y.id !== u.id))}>
                    Dismiss
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" icon="x" onClick={() => u.ctrl.abort()}>
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ol>

        <div className={s.insertBar} role="group" aria-label="Add to this page">
          <Button size="sm" variant="cord" icon="upload" onClick={() => picker.current?.click()}>
            Upload files
          </Button>
          <Button size="sm" variant="line" icon="text" onClick={() => addBlock({ t: "text", text: "" })}>
            Text
          </Button>
          <Button size="sm" variant="line" icon="pen" onClick={() => addBlock({ t: "heading", text: "" })}>
            Heading
          </Button>
          <Button
            size="sm"
            variant="line"
            icon="link"
            onClick={() => addBlock({ t: "link", url: "https://", label: "" })}
          >
            Link
          </Button>
          <small className={s.muted}>Or drop files on this page.</small>
        </div>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const fs = [...(e.target.files ?? [])];
            e.target.value = "";
            void sealFiles(fs);
          }}
        />
      </section>

      <LockLine>
        Everything on these pages, files included, is sealed with this product&rsquo;s key before it leaves your device.
        Only people who bought it get the key; Mizuhiki stores ciphertext and file sizes, never the contents.
      </LockLine>

      <Confirm
        open={killPage !== null}
        title="Delete this page?"
        confirm="Delete page"
        onClose={() => setKillPage(null)}
        onConfirm={() => {
          const i = killPage ?? 0;
          setPages((ps) => ps.filter((_, j) => j !== i));
          setAt(Math.max(0, i - 1));
          setKillPage(null);
          toast.show("Page deleted", {
            action: { label: "Undo", onClick: () => document.dispatchEvent(new CustomEvent("mzk-shop-undo")) },
          });
        }}
      >
        <p>
          Its text, links and files are removed from what buyers get once you publish. People who already bought keep
          the copy they have.
        </p>
      </Confirm>
    </div>
  );
}

function BlockEditor({
  block,
  onChange,
}: {
  block: ContentBlock;
  onChange: (b: ContentBlock, coalesce?: string) => void;
}) {
  if (block.t === "text")
    return (
      <TextArea
        label="Text"
        hideLabel
        className={s.blockText}
        value={block.text}
        rows={Math.min(14, Math.max(3, block.text.split("\n").length + 1))}
        maxLength={20000}
        placeholder="Thank you for buying. Here is everything you need…"
        onChange={(e) => onChange({ t: "text", text: e.target.value }, "t")}
      />
    );
  if (block.t === "heading")
    return (
      <TextField
        label="Heading"
        hideLabel
        className={s.blockHeading}
        value={block.text}
        maxLength={200}
        placeholder="Heading"
        onChange={(e) => onChange({ t: "heading", text: e.target.value }, "h")}
      />
    );
  if (block.t === "link")
    return (
      <div className={s.linkBlock}>
        <TextField
          label="Link text"
          value={block.label}
          maxLength={120}
          placeholder="Watch the walkthrough"
          onChange={(e) => onChange({ ...block, label: e.target.value }, "ll")}
        />
        <TextField
          label="Address"
          value={block.url}
          maxLength={2000}
          spellCheck={false}
          autoCapitalize="none"
          onChange={(e) => onChange({ ...block, url: e.target.value.trim() }, "lu")}
          error={
            /^https?:\/\/[^\s/]+\.[^\s]+/.test(block.url) ? undefined : "Use a full address, starting with https://"
          }
          hint="Buyers see this link only inside their sealed copy."
        />
      </div>
    );
  const f = block.file as Partial<FileFacts>;
  return (
    <div className={s.fileCard}>
      <span className={s.fileIcon}>
        <Icon name="file" size={20} />
      </span>
      <span className={s.fileText}>
        <b>{f.name ?? "File"}</b>
        <small>
          {fileKind(f.name ?? "", f.type ?? "")} · {formatBytes(f.size ?? 0)} · sealed
        </small>
      </span>
      <FileDownload facts={block.file} />
    </div>
  );
}

/** Opens the sealed file here, so the seller can check exactly what buyers will download. */
function FileDownload({ facts }: { facts: Record<string, unknown> }) {
  const toast = useToast();
  const [pct, setPct] = useState<number | null>(null);
  const go = async () => {
    setPct(0);
    try {
      const f = parseFileFacts(utf8(JSON.stringify(facts)));
      const parts = await decryptFile({
        facts: f,
        fetchChunk: (hash) => api.bytes(`/blobs/${hash}`),
        onProgress: (done, total) => setPct(total ? Math.floor((done / total) * 100) : 100),
      });
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: f.type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.show(e instanceof Error && e.message ? e.message : "The file did not open here.", { tone: "error" });
    } finally {
      setPct(null);
    }
  };
  return (
    <Button size="sm" variant="line" icon="download" busy={pct !== null} onClick={() => void go()}>
      {pct !== null ? `${pct}%` : "Download"}
    </Button>
  );
}
