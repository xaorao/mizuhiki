"use client";
/**
 * Discounts (Gumroad: Checkout › Discounts): codes with a percent or a fixed
 * amount in one token, the products they apply to, a use limit and an expiry.
 * The server checks a code at order time and the deliverer checks it again;
 * the list never reaches a buyer's browser.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  EmptyState,
  Oops,
  Segmented,
  Sheet,
  Skeleton,
  StatusChip,
  TextField,
  ToggleRow,
  useToast,
} from "@mizuhiki/ui";
import { TOKENS, parseAmount, type ShopToken } from "@mizuhiki/core";
import { ApiFailure } from "@/lib/api";
import { deleteDiscount, listDiscounts, newId, saveDiscount, type DiscountRow } from "../engine";
import { amountInput, codeProblem, discountState, discountValue } from "./model";
import { useProducts } from "./useProducts";
import { Confirm, RowMenu } from "./bits";
import s from "./seller.module.css";

export function DiscountsTab() {
  const { rows: products, tokened } = useProducts();
  const toast = useToast();
  const [list, setList] = useState<DiscountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<DiscountRow | "new" | null>(null);
  const [del, setDel] = useState<DiscountRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await listDiscounts(await tokened()));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your discounts could not be loaded. Nothing changed.");
    }
  }, [tokened]);
  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (d: DiscountRow) => {
    try {
      const { uses: _u, ...rest } = d;
      await saveDiscount(await tokened(), { ...rest, active: !d.active });
      toast.show(d.active ? `${d.code} is off` : `${d.code} is on`);
      await load();
    } catch (e) {
      toast.show(e instanceof ApiFailure ? e.message : "That did not work. Nothing changed.", { tone: "error" });
    }
  };

  const remove = async () => {
    if (!del) return;
    setBusy(true);
    try {
      await deleteDiscount(await tokened(), del.id);
      toast.show(`${del.code} deleted. Orders that used it keep their price.`);
      setDel(null);
      await load();
    } catch (e) {
      toast.show(e instanceof ApiFailure ? e.message : "It was not deleted. Nothing changed.", { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const titleOf = (id: string) => products?.find((p) => p.p.id === id)?.def?.title ?? "A deleted product";

  return (
    <div className={s.stack}>
      {error ? (
        <Oops
          title="Not loaded"
          action={
            <Button variant="line" icon="undo" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {error}
        </Oops>
      ) : list === null ? (
        <Skeleton lines={3} />
      ) : list.length === 0 ? (
        <div className={s.emptyWrap}>
          <EmptyState
            title="No discounts yet"
            face="normal"
            jp="おとく"
            action={
              <Button variant="cord" icon="plus" onClick={() => setEditing("new")}>
                New discount
              </Button>
            }
          >
            Use discounts to make sweet deals for your people. Codes are checked by Mizuhiki and again by whoever seals
            the order.
          </EmptyState>
        </div>
      ) : (
        <>
          <div className={s.barEnd}>
            <Button variant="cord" icon="plus" onClick={() => setEditing("new")}>
              New discount
            </Button>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Discount</th>
                  <th scope="col">Products</th>
                  <th scope="col" className={s.num}>
                    Uses
                  </th>
                  <th scope="col">Expires</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className={s.stagger}>
                {list.map((d) => {
                  const st = discountState(d);
                  return (
                    <tr key={d.id}>
                      <td>
                        <button type="button" className={[s.rowLink, s.mono].join(" ")} onClick={() => setEditing(d)}>
                          {d.code}
                        </button>
                      </td>
                      <td>{discountValue(d)}</td>
                      <td className={s.wrapCell}>
                        {d.productIds.length === 0 ? "All products" : d.productIds.map(titleOf).join(", ")}
                      </td>
                      <td className={s.num}>
                        {d.uses}
                        {d.maxUses !== null ? ` / ${d.maxUses}` : ""}
                      </td>
                      <td>
                        {d.expiresAt
                          ? new Date(d.expiresAt).toLocaleDateString("en-GB", {
                              day: "numeric",
                              month: "short",
                              year: "numeric",
                            })
                          : "Never"}
                      </td>
                      <td>
                        <StatusChip status={st.chip}>{st.label}</StatusChip>
                      </td>
                      <td className={s.menuCell}>
                        <RowMenu
                          label={`Actions for ${d.code}`}
                          items={[
                            { label: "Edit", icon: "pen", onSelect: () => setEditing(d) },
                            {
                              label: d.active ? "Turn off" : "Turn on",
                              icon: d.active ? "eye" : "check",
                              onSelect: () => void toggle(d),
                            },
                            { label: "Delete", icon: "trash", danger: true, onSelect: () => setDel(d) },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      <p className={s.footNote}>Whether checkout shows the code field is set per product, in its Pricing settings.</p>
      {editing ? (
        <DiscountSheet
          initial={editing === "new" ? null : editing}
          others={(list ?? []).filter((d) => editing === "new" || d.id !== editing.id).map((d) => d.code)}
          products={(products ?? [])
            .filter((p) => p.def)
            .map((p) => ({ id: p.p.id, title: p.def?.title ?? "", token: p.def?.price.token ?? "fUSD" }))}
          onClose={() => setEditing(null)}
          onSave={async (d) => {
            await saveDiscount(await tokened(), d);
            toast.show(editing === "new" ? `${d.code.toUpperCase()} is ready to share` : "Changes saved");
            setEditing(null);
            await load();
          }}
        />
      ) : null}
      <Confirm
        open={del !== null}
        title={`Delete ${del?.code ?? "this code"}?`}
        confirm="Delete"
        busy={busy}
        onClose={() => setDel(null)}
        onConfirm={() => void remove()}
      >
        <p>Buyers can no longer use it. Orders that already used it keep their price.</p>
      </Confirm>
    </div>
  );
}

function DiscountSheet({
  initial,
  others,
  products,
  onClose,
  onSave,
}: {
  initial: DiscountRow | null;
  others: string[];
  products: { id: string; title: string; token: ShopToken }[];
  onClose: () => void;
  onSave: (d: Omit<DiscountRow, "uses">) => Promise<void>;
}) {
  const [code, setCode] = useState(initial?.code ?? "");
  const [mode, setMode] = useState<"percent" | "amount">(initial?.amountOff ? "amount" : "percent");
  const [percent, setPercent] = useState(initial?.percent?.toString() ?? "20");
  const [token, setToken] = useState<ShopToken>(initial?.token ?? products[0]?.token ?? "fUSD");
  const [amount, setAmount] = useState(
    initial?.amountOff && initial.token ? amountInput(initial.amountOff, initial.token) : "",
  );
  const [all, setAll] = useState((initial?.productIds.length ?? 0) === 0);
  const [picked, setPicked] = useState<string[]>(initial?.productIds ?? []);
  const [limit, setLimit] = useState(initial?.maxUses !== null && initial?.maxUses !== undefined);
  const [maxUses, setMaxUses] = useState(initial?.maxUses?.toString() ?? "100");
  const [expires, setExpires] = useState(initial?.expiresAt ? initial.expiresAt.slice(0, 10) : "");
  const [active, setActive] = useState(initial?.active ?? true);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const codeErr = codeProblem(code, others);
  const pct = Number(percent);
  const pctErr =
    mode === "percent" && (!/^\d{1,3}$/.test(percent) || pct < 1 || pct > 100)
      ? "Use a whole percent from 1 to 100."
      : null;
  const off = mode === "amount" ? parseAmount(amount, token) : null;
  const amtErr = mode === "amount" && (off === null || off <= 0n) ? `Use an amount in ${token}, like 5.` : null;
  const pickErr = !all && picked.length === 0 ? "Pick at least one product, or choose all products." : null;
  const usesErr =
    limit && (!/^\d{1,7}$/.test(maxUses) || Number(maxUses) < 1) ? "Use a whole number, 1 or more." : null;
  const expiresAt = expires ? new Date(`${expires}T23:59:59`) : null;
  const expErr =
    expires && (!expiresAt || Number.isNaN(expiresAt.getTime()))
      ? "Pick a date."
      : expiresAt && expiresAt < new Date()
        ? "Pick a day that has not passed."
        : null;
  const bad = codeErr ?? pctErr ?? amtErr ?? pickErr ?? usesErr ?? expErr;
  const mismatched =
    mode === "amount" ? products.filter((p) => (all || picked.includes(p.id)) && p.token !== token) : [];

  const save = async () => {
    setTried(true);
    if (bad) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave({
        id: initial?.id ?? newId("dc"),
        code: code.trim().toUpperCase(),
        percent: mode === "percent" ? pct : null,
        amountOff: mode === "amount" && off !== null ? off.toString() : null,
        token: mode === "amount" ? token : null,
        productIds: all ? [] : picked,
        maxUses: limit ? Number(maxUses) : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        active,
      });
    } catch (e) {
      setErr(e instanceof ApiFailure ? e.message : "The discount was not saved. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };

  const show = (e: string | null) => (tried ? (e ?? undefined) : undefined);
  return (
    <Sheet open onClose={onClose} title={initial ? `Edit ${initial.code}` : "New discount"} dismissable={!busy}>
      <form
        className={s.stack}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <TextField
          label="Code"
          value={code}
          maxLength={40}
          autoCapitalize="characters"
          spellCheck={false}
          placeholder="SPRING20"
          onChange={(e) => setCode(e.target.value.replace(/\s/g, "").toUpperCase())}
          error={show(codeErr)}
          hint="Buyers type this at checkout. Letters are not case-sensitive."
        />
        <Segmented<"percent" | "amount">
          label="Kind of discount"
          value={mode}
          onChange={setMode}
          options={[
            { value: "percent", label: "Percent off" },
            { value: "amount", label: "Fixed amount off" },
          ]}
        />
        {mode === "percent" ? (
          <TextField
            label="Percent off (%)"
            inputMode="numeric"
            value={percent}
            onChange={(e) => setPercent(e.target.value.replace(/\D/g, "").slice(0, 3))}
            error={show(pctErr)}
          />
        ) : (
          <div className={s.fieldRow}>
            <TextField
              label="Amount off per order"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              error={show(amtErr)}
            />
            <Segmented<ShopToken>
              label="Token"
              value={token}
              onChange={setToken}
              options={TOKENS.map((t) => ({ value: t, label: t }))}
            />
          </div>
        )}
        {mismatched.length ? (
          <p className={s.warn}>
            {mismatched.map((p) => p.title).join(", ")} {mismatched.length === 1 ? "is" : "are"} priced in another
            token, so this code does not apply to {mismatched.length === 1 ? "it" : "them"}.
          </p>
        ) : null}
        <fieldset className={s.fieldset}>
          <legend>Applies to</legend>
          <label className={s.check}>
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            <span>All products, now and later</span>
          </label>
          {!all ? (
            products.length ? (
              products.map((p) => (
                <label key={p.id} className={s.check}>
                  <input
                    type="checkbox"
                    checked={picked.includes(p.id)}
                    onChange={(e) => setPicked((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))}
                  />
                  <span>
                    {p.title} <small className={s.muted}>({p.token})</small>
                  </span>
                </label>
              ))
            ) : (
              <p className={s.muted}>You have no products yet.</p>
            )
          ) : null}
          {tried && pickErr ? <p className={s.fieldErr}>{pickErr}</p> : null}
        </fieldset>
        <ToggleRow title="Limit how many times it can be used" checked={limit} onChange={setLimit} />
        {limit ? (
          <TextField
            label="Most uses"
            inputMode="numeric"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, "").slice(0, 7))}
            error={show(usesErr)}
            hint={initial ? `Used ${initial.uses} times so far.` : undefined}
          />
        ) : null}
        <TextField
          label="Expires after (optional)"
          type="date"
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          error={show(expErr)}
          hint="It stops working at the end of that day, your time."
        />
        <ToggleRow
          title="Active"
          detail={active ? "Buyers can use it now." : "Saved, but buyers cannot use it."}
          checked={active}
          onChange={setActive}
        />
        {err ? <Oops title="Not saved">{err}</Oops> : null}
        <div className={s.actionsEnd}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="cord" icon="check" busy={busy}>
            {initial ? "Save changes" : "Create discount"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
