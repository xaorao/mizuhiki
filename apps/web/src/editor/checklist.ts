/** The setup checklist ring (Linktree pattern, spec 5.3): 6 items, each with its own action and Skip. */
import type { Stats } from "@/owner/OwnerProvider";
import { CHECKLIST, type ChecklistItem, type Draft } from "./state";

export interface ChecklistRow {
  id: ChecklistItem;
  title: string;
  state: "done" | "skipped" | "todo";
}

export function checklistState(d: Draft, stats: Stats | null): { items: ChecklistRow[]; done: number; total: number } {
  const derived: Record<ChecklistItem, boolean> = {
    profile: Boolean(d.manifest.displayName && d.manifest.avatar),
    spareKey: d.checklist.done.includes("spareKey"),
    block: d.checklist.done.includes("block"),
    design: d.checklist.done.includes("design"),
    share: d.checklist.done.includes("share"),
    firstItem: Object.values(stats?.items ?? {}).some((x) => x.count > 0) || (stats?.paid.length ?? 0) > 0,
  };
  const items = CHECKLIST.map((c) => ({
    ...c,
    state: derived[c.id]
      ? ("done" as const)
      : d.checklist.skipped.includes(c.id)
        ? ("skipped" as const)
        : ("todo" as const),
  }));
  return { items, done: items.filter((i) => i.state !== "todo").length, total: items.length };
}

export function markChecklist(d: Draft, id: ChecklistItem, as: "done" | "skipped"): Draft {
  const list = d.checklist[as];
  if (list.includes(id)) return d;
  return { ...d, checklist: { ...d.checklist, [as]: [...list, id] } };
}
