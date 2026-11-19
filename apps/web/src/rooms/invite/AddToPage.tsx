"use client";
/**
 * "Add to my page": a "Join my room" button on the owner's public page that
 * carries the room's main invite link. Same pattern as a form's page button
 * (forms/ShareTab.tsx): edit the page draft, then publish it.
 */
import { useEffect, useState } from "react";
import { Button, Icon, Skeleton, useToast } from "@mizuhiki/ui";
import { newId, type Block } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { updateBlock } from "@/editor/blocks";
import { markChecklist } from "@/editor/checklist";
import s from "./invite.module.css";

/** The page stores the path only: `/join/<id>#k=<key>`. */
export const invitePath = (url: string): string | null => {
  const m = /\/join\/([a-z0-9]{12,32})#k=([A-Za-z0-9_-]{43})$/.exec(url);
  return m?.[1] && m[2] ? `/join/${m[1]}#k=${m[2]}` : null;
};

export function AddToPage({ roomId, roomName, url }: { roomId: string; roomName: string; url: string | null }) {
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
      (e: unknown) => setError(`${e instanceof Error ? e.message : "Your page was not published."} The button is saved in your page draft.`),
    );
  }, [queued, o, toast]);

  if (o.loading) return <Skeleton lines={2} />;
  const d = o.draft;
  if (!d) return <p className={s.muted}>{o.loadError ?? "Your page is not set up yet, so there is nowhere to add the button."}</p>;
  const path = url ? invitePath(url) : null;
  const block = d.manifest.blocks.find((b): b is Extract<Block, { type: "room" }> => b.type === "room" && b.roomId === roomId);
  const live = o.published?.blocks.some((b) => b.type === "room" && b.roomId === roomId && b.on && !b.archived && b.invite === path) ?? false;
  const busy = o.publishing || queued !== null;
  const run = (fn: Parameters<typeof o.edit>[0], message: string) => {
    setError(null);
    o.edit(fn);
    setQueued(message);
  };
  const title = `Join ${roomName || "my room"}`.slice(0, 80);

  const add = () =>
    path &&
    run((x) => {
      const b: Block = { id: newId(), type: "room", roomId, invite: path, title, subtitle: "Ask to join · sealed to members", on: true, archived: false };
      const i = x.pending.findIndex((p) => p.kind === "room");
      const pending = i < 0 ? x.pending : x.pending.filter((_, j) => j !== i);
      return markChecklist({ ...x, pending, manifest: { ...x.manifest, blocks: [...x.manifest.blocks, b] } }, "block", "done");
    }, "Added to your page and published");

  return (
    <div className={s.pageBlock}>
      <span className={s.pageIcon}>
        <Icon name="users" size={22} />
      </span>
      <div>
        <b>Add to my page</b>
        {!path ? (
          <p className={s.muted}>The main link was made on another device. Reset it here first.</p>
        ) : !block ? (
          <>
            <p className={s.muted}>Adds a “{title}” button to your public page. Anyone who sees your page can ask to join; you still approve each person.</p>
            <Button variant="cord" size="sm" icon="plus" busy={busy} onClick={add}>
              Add to my page
            </Button>
          </>
        ) : block.invite !== path || block.archived || !block.on ? (
          <>
            <p className={s.muted}>{block.invite !== path ? "The button on your page still uses an old link." : "The button is on your page but hidden."}</p>
            <Button variant="cord" size="sm" icon="check" busy={busy} onClick={() => run((x) => updateBlock(x, block.id, { invite: path, on: true, archived: false }), "The button on your page is updated")}>
              Update the button
            </Button>
          </>
        ) : live ? (
          <p className={s.muted}>“{block.title}” is on your page and live.</p>
        ) : (
          <>
            <p className={s.muted}>“{block.title}” is in your page draft, not published yet.</p>
            <Button variant="cord" size="sm" icon="send" busy={busy} onClick={() => run((x) => x, "Your page is published")}>
              Publish my page
            </Button>
          </>
        )}
        {error ? <p className={s.error}>{error}</p> : null}
      </div>
    </div>
  );
}
