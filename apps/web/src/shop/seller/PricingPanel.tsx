"use client";
/**
 * Pricing (Gumroad 5): price and token, pay what you want, versions with an
 * additional amount and a cap, sales limits, quantity, the public sales
 * count, a refund promise, tips and the discount field rule.
 */
import { Button, IconButton, Panel, Segmented, TextArea, TextField, ToggleRow } from "@mizuhiki/ui";
import { TOKENS, formatAmount, type ProductDef, type ShopToken } from "@mizuhiki/core";
import { newId } from "../engine";
import { move } from "./model";
import { AmountField, CountField } from "./fields";
import type { EditorProps } from "./editorTypes";
import s from "./seller.module.css";

type Version = ProductDef["versions"][number];

export function PricingPanel({ draft, patch, row }: EditorProps) {
  const def = draft.def;
  const p = def.price;
  const tip = def.kind === "tip";
  const pwyw = p.pwyw ?? (tip ? { min: p.amount, suggested: p.amount } : null);
  const soldBefore = row.sales > 0;

  const setPrice = (amount: string) =>
    patch(
      {
        price: {
          ...p,
          amount,
          pwyw: pwyw
            ? { min: amount, suggested: BigInt(pwyw.suggested) < BigInt(amount) ? amount : pwyw.suggested }
            : null,
        },
      },
      "price",
    );
  const setVersion = (i: number, v: Partial<Version>, key?: string) =>
    patch({ versions: def.versions.map((x, j) => (j === i ? { ...x, ...v } : x)) }, key);

  return (
    <Panel title="Pricing" kicker="ねだん">
      <div className={s.stack}>
        <div className={s.fieldRow}>
          <AmountField
            label={tip ? "Smallest tip" : def.kind === "commission" ? "Full price" : pwyw ? "Minimum amount" : "Amount"}
            value={p.amount}
            token={p.token}
            onChange={setPrice}
            hint={
              def.kind === "commission" && def.commission
                ? `The buyer pays ${def.commission.depositPercent}% now and the rest when you ask.`
                : undefined
            }
          />
          <Segmented<ShopToken>
            label="Token"
            value={p.token}
            onChange={(token) => patch({ price: { ...p, token } })}
            options={TOKENS.map((t) => ({ value: t, label: t }))}
          />
        </div>
        {soldBefore ? (
          <p className={s.help}>People who already bought keep what they paid; a new price applies once you publish.</p>
        ) : null}

        {!tip ? (
          <ToggleRow
            title="Let buyers pay what they want"
            detail="They choose an amount, at least the minimum above."
            checked={!!p.pwyw}
            onChange={(on) => patch({ price: { ...p, pwyw: on ? { min: p.amount, suggested: p.amount } : null } })}
          />
        ) : null}
        {pwyw ? (
          <div className={s.indent}>
            <AmountField
              label="Suggested amount"
              value={pwyw.suggested}
              token={p.token}
              min={BigInt(pwyw.min)}
              onChange={(suggested) => patch({ price: { ...p, pwyw: { min: p.amount, suggested } } }, "suggested")}
              hint={`Shown as the starting amount. The minimum is ${formatAmount(p.amount, p.token)}.`}
            />
          </div>
        ) : null}

        {!tip ? (
          <div className={s.stack}>
            <div className={s.subHead}>
              <b>Versions</b>
              <small>Offer variations of this product, like a format or an extra. Each adds to the base price.</small>
            </div>
            {def.versions.length ? (
              <ol className={s.versions}>
                {def.versions.map((v, i) => (
                  <li key={v.id} className={s.version}>
                    <div className={s.versionTools}>
                      <span className={s.versionNum}>{i + 1}</span>
                      <IconButton
                        icon="chev"
                        label="Move up"
                        disabled={i === 0}
                        onClick={() => patch({ versions: move(def.versions, i, i - 1) })}
                        className={s.rotUp}
                      />
                      <IconButton
                        icon="chev"
                        label="Move down"
                        disabled={i === def.versions.length - 1}
                        onClick={() => patch({ versions: move(def.versions, i, i + 1) })}
                        className={s.rotDown}
                      />
                      <IconButton
                        icon="trash"
                        label={`Remove ${v.name || "version"}`}
                        onClick={() => patch({ versions: def.versions.filter((_, j) => j !== i) })}
                      />
                    </div>
                    <div className={s.versionFields}>
                      <TextField
                        label="Name"
                        value={v.name}
                        maxLength={80}
                        onChange={(e) => setVersion(i, { name: e.target.value }, `vn-${v.id}`)}
                        error={v.name.trim() ? undefined : "Name this version."}
                      />
                      <TextField
                        label="Description"
                        value={v.description}
                        maxLength={300}
                        onChange={(e) => setVersion(i, { description: e.target.value }, `vd-${v.id}`)}
                      />
                      <div className={s.fieldRow}>
                        <AmountField
                          label="Additional amount"
                          value={v.extra}
                          token={p.token}
                          allowZero
                          onChange={(extra) => setVersion(i, { extra }, `ve-${v.id}`)}
                          hint={`Total ${formatAmount(BigInt(p.amount) + BigInt(v.extra), p.token)}`}
                        />
                        <CountField
                          label="Most purchases"
                          value={v.max}
                          placeholder="No limit"
                          onChange={(max) => setVersion(i, { max }, `vm-${v.id}`)}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            ) : null}
            {def.versions.length < 12 ? (
              <div>
                <Button
                  size="sm"
                  variant="line"
                  icon="plus"
                  onClick={() =>
                    patch({
                      versions: [
                        ...def.versions,
                        { id: newId("vr"), name: "", description: "", extra: "0", max: null },
                      ],
                    })
                  }
                >
                  Add version
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className={s.subHead}>
          <b>Settings</b>
        </div>
        <ToggleRow
          title="Limit product sales"
          detail="Stops selling once this many are sold. Unpaid orders hold a place for an hour."
          checked={def.limits.maxSales !== null}
          onChange={(on) => patch({ limits: { ...def.limits, maxSales: on ? 100 : null } })}
        />
        {def.limits.maxSales !== null ? (
          <div className={s.indent}>
            <CountField
              label="Most purchases"
              value={def.limits.maxSales}
              onChange={(maxSales) => maxSales !== null && patch({ limits: { ...def.limits, maxSales } }, "maxSales")}
            />
          </div>
        ) : null}
        {def.kind !== "call" && def.kind !== "commission" ? (
          <ToggleRow
            title="Let buyers choose a quantity"
            checked={def.limits.quantity}
            onChange={(quantity) => patch({ limits: { ...def.limits, quantity } })}
          />
        ) : null}
        <ToggleRow
          title="Show the number of sales on the product page"
          checked={def.limits.showSales}
          onChange={(showSales) => patch({ limits: { ...def.limits, showSales } })}
        />
        <ToggleRow
          title="Promise refunds for this product"
          detail="Shown to buyers before they pay."
          checked={def.refund !== null}
          onChange={(on) => patch({ refund: on ? { days: 30, finePrint: "" } : null })}
        />
        {def.refund ? (
          <div className={[s.indent, s.stack].join(" ")}>
            <CountField
              label="Refund period in days"
              value={def.refund.days}
              max={365}
              onChange={(days) =>
                days !== null && def.refund && patch({ refund: { ...def.refund, days } }, "refundDays")
              }
            />
            <TextArea
              label="Fine print (optional)"
              value={def.refund.finePrint}
              maxLength={500}
              rows={3}
              onChange={(e) =>
                def.refund && patch({ refund: { ...def.refund, finePrint: e.target.value } }, "finePrint")
              }
            />
            <p className={s.note}>
              Payments on QoreChain cannot be charged back. This is your promise: when a buyer asks within{" "}
              {def.refund.days} days, you send the money back yourself from Sales › Refund. Their sealed copy stays
              theirs.
            </p>
          </div>
        ) : null}
        {!tip ? (
          <ToggleRow title="Let buyers add a tip" checked={def.tips} onChange={(tips) => patch({ tips })} />
        ) : null}
        <div className={s.stack}>
          <div className={s.subHead}>
            <b>Discount code field at checkout</b>
          </div>
          <Segmented<ProductDef["discountField"]>
            stackOnPhone
            label="Discount code field at checkout"
            value={def.discountField}
            onChange={(discountField) => patch({ discountField })}
            options={[
              { value: "available", label: "Only if a discount is available" },
              { value: "never", label: "Never" },
            ]}
          />
        </div>
      </div>
    </Panel>
  );
}
