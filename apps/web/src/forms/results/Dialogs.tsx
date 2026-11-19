"use client";
/**
 * Two owner actions over opened answers: "Choose a file to download" (CSV,
 * XLSX or PDF, built here, Typeform's export dialog) and "Share a snapshot"
 * (an explicit, honest choice to make a link anyone can read).
 */
import { useState } from "react";
import { Button, ButtonLink, ChoiceCard, CopyValue, Icon, Sheet, ToggleRow, useToast } from "@mizuhiki/ui";
import { ApiFailure } from "@/lib/api";
import { toCsv } from "./csv";
import { xlsx } from "./xlsx";
import { resultsPdf } from "./pdf";
import type { Snapshot } from "./schema";
import type { TableModel } from "./aggregate";
import s from "../results.module.css";

export type ExportFormat = "csv" | "xlsx" | "pdf";

function save(bytes: Uint8Array | string, name: string, type: string): void {
  const blob = new Blob([bytes as BlobPart], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const fileBase = (title: string) => {
  const slug =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "form";
  return `${slug}-responses-${new Date().toISOString().slice(0, 10)}`;
};

export function ExportSheet({
  open,
  onClose,
  title,
  allCount,
  shownCount,
  table,
  snapshot,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  allCount: number;
  shownCount: number;
  /** Builds the table for a file: every response, or only the ones the filters show. */
  table: (onlyShown: boolean) => TableModel;
  /** Builds the summary (and responses) the PDF prints. */
  snapshot: (onlyShown: boolean) => Snapshot;
}) {
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [onlyShown, setOnlyShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const filtered = shownCount !== allCount;
  const count = filtered && onlyShown ? shownCount : allCount;

  const run = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const base = fileBase(title);
      if (format === "pdf") {
        save(await resultsPdf(snapshot(filtered && onlyShown)), `${base}.pdf`, "application/pdf");
      } else {
        const t = table(filtered && onlyShown);
        const rows: (string | number)[][] = [t.columns.map((c) => c.label), ...t.rows.map((r) => r.cells)];
        if (format === "csv") save(toCsv(rows), `${base}.csv`, "text/csv;charset=utf-8");
        else {
          const snap = snapshot(filtered && onlyShown);
          const summary: (string | number)[][] = [["Question", "Answer", "Count", "Share of people who answered"]];
          for (const q of snap.summary) {
            if (q.type === "bars")
              for (const b of q.bars)
                summary.push([
                  q.title,
                  b.label,
                  b.count,
                  q.answered ? Math.round((b.count / q.answered) * 1000) / 10 : 0,
                ]);
            else if (q.type === "numbers")
              summary.push(
                [q.title, "Lowest", q.min ?? "", ""],
                [q.title, "Average", q.avg ?? "", ""],
                [q.title, "Highest", q.max ?? "", ""],
              );
            else if (q.type === "files") summary.push([q.title, "Files", q.files, ""]);
            else summary.push([q.title, "Text answers", q.answered, ""]);
          }
          save(
            xlsx([
              { name: "Responses", rows },
              { name: "Summary", rows: summary },
            ]),
            `${base}.xlsx`,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          );
        }
      }
      toast.show(`Your ${format.toUpperCase()} file is downloading. It was made on this device.`, { tone: "ok" });
      onClose();
    } catch {
      setFailure("The file could not be made. Nothing was sent anywhere; try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Choose a file to download" dismissable={!busy}>
      <div className={s.dialog}>
        <div role="radiogroup" aria-label="File type" className={s.choices}>
          <ChoiceCard
            selected={format === "csv"}
            onSelect={() => setFormat("csv")}
            title="CSV file"
            detail="One row per response. Opens in any spreadsheet."
            icon={<Icon name="file" size={20} />}
          />
          <ChoiceCard
            selected={format === "xlsx"}
            onSelect={() => setFormat("xlsx")}
            title="XLSX file"
            detail="An Excel workbook with the responses and the answer counts."
            icon={<Icon name="chart" size={20} />}
            tone="matcha"
          />
          <ChoiceCard
            selected={format === "pdf"}
            onSelect={() => setFormat("pdf")}
            title="PDF file"
            detail="The summary with charts, then every response. Good for printing."
            icon={<Icon name="invoice" size={20} />}
            tone="fuji"
          />
        </div>
        {filtered ? (
          <ToggleRow
            title={`Only the ${shownCount} response${shownCount === 1 ? "" : "s"} your filters show`}
            detail={`Off: all ${allCount} opened responses.`}
            checked={onlyShown}
            onChange={setOnlyShown}
          />
        ) : null}
        <p className={s.lockNote}>
          <Icon name="lock" size={13} /> Made in this browser from answers opened here. Nothing is uploaded. Keep the
          file somewhere private.
        </p>
        {failure ? <p className={s.fileErr}>{failure}</p> : null}
        <div className={s.dialogActions}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="cord" icon="download" busy={busy} onClick={() => void run()} disabled={count === 0}>
            Download
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

type ShareState =
  | { s: "choose" }
  | { s: "sealing" }
  | { s: "done"; link: string; withTable: boolean; seedsSaved: boolean }
  | { s: "failed"; why: string };

export function SnapshotSheet({
  open,
  onClose,
  onShare,
  count,
}: {
  open: boolean;
  onClose: () => void;
  /** Seal, upload, sign and keep the snapshot; resolves to its link. */
  onShare: (withTable: boolean) => Promise<{ link: string; seedsSaved: boolean }>;
  count: number;
}) {
  const toast = useToast();
  const [withTable, setWithTable] = useState(false);
  const [state, setState] = useState<ShareState>({ s: "choose" });
  const close = () => {
    onClose();
    setState({ s: "choose" });
  };
  const run = async () => {
    setState({ s: "sealing" });
    try {
      const r = await onShare(withTable);
      setState({ s: "done", link: r.link, withTable, seedsSaved: r.seedsSaved });
    } catch (e) {
      setState({
        s: "failed",
        why:
          e instanceof ApiFailure && e.status === 413
            ? "With every response this snapshot is too large for one link. Nothing was shared; turn off the full table and try again."
            : e instanceof ApiFailure
              ? `${e.message} No link was made.`
              : "The snapshot could not be sealed or uploaded. No link was made; try again.",
      });
    }
  };
  return (
    <Sheet open={open} onClose={close} title="Share a snapshot" dismissable={state.s !== "sealing"}>
      <div className={s.dialog}>
        <p className={s.warn}>
          <Icon name="alert" size={16} />
          <span>
            <b>Export a snapshot. Anyone with the link can read it.</b> It is a copy of your results as they are now,
            sealed on this device to a key that travels inside the link. It does not update.
          </span>
        </p>
        {state.s === "done" ? (
          <div className={s.shareDone}>
            <p className={s.kicker} lang="ja">
              できた！
            </p>
            <CopyValue
              value={state.link}
              label="snapshot link"
              short
              onCopied={(ok) => toast.show(ok ? "Link copied" : "Copy did not work. Select the link and copy it.")}
            />
            <p className={s.note}>
              {state.withTable ? "Summary and every response" : "Summary only"}, signed with your post-quantum key. The
              link works until you delete the snapshot under Shared snapshots.
            </p>
            {state.seedsSaved ? null : (
              <p className={s.fileErr}>
                The link&apos;s key could not be saved for your other devices. Copy the link now: it works, but only
                this screen can show it.
              </p>
            )}
            <div className={s.dialogActions}>
              <ButtonLink variant="line" icon="eye" href={state.link} target="_blank" rel="noreferrer">
                Open it
              </ButtonLink>
              <Button variant="cord" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            <ul className={s.includes}>
              <li>
                <Icon name="check" size={14} /> The form title and every question
              </li>
              <li>
                <Icon name="check" size={14} /> Views, starts, submissions, completion rate and time
              </li>
              <li>
                <Icon name="check" size={14} /> The summary of {count} opened answer{count === 1 ? "" : "s"}: charts,
                numbers and the latest text answers
              </li>
              <li>
                <Icon name="x" size={14} /> Never files, signatures or your tags
              </li>
            </ul>
            <ToggleRow
              title="Include the full responses table"
              detail="Every answer, one row per person. Names, emails and anything else they wrote become readable to anyone with the link."
              checked={withTable}
              onChange={setWithTable}
              disabled={state.s === "sealing"}
            />
            {state.s === "failed" ? <p className={s.fileErr}>{state.why}</p> : null}
            <div className={s.dialogActions}>
              <Button variant="ghost" onClick={close} disabled={state.s === "sealing"}>
                Cancel
              </Button>
              <Button variant="cord" icon="link" busy={state.s === "sealing"} onClick={() => void run()}>
                {state.s === "sealing" ? "Sealing the snapshot…" : "Create the link"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
