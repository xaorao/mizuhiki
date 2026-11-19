"use client";
/**
 * New product (Gumroad's /products/new): three fields, Name, a type card and
 * Price, then "Next: Customize" makes the sealed working copy and opens the editor.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink, ChoiceCard, Icon, Kicker, Oops, Segmented, TextField } from "@mizuhiki/ui";
import { KIND_INFO, PRODUCT_KINDS, TOKENS, parseAmount, type ProductKind, type ShopToken } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { ApiFailure } from "@/lib/api";
import { newDraft, saveDraft, withToken } from "../engine";
import { KIND_ICON, KIND_TONE } from "./model";
import s from "./seller.module.css";

export function NewProduct() {
  const owner = useOwner();
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ProductKind | null>(null);
  const [token, setToken] = useState<ShopToken>("fUSD");
  const [price, setPrice] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const name = owner.published?.name ?? owner.draft?.manifest.name ?? null;

  const amount = parseAmount(price, token);
  const titleErr = !title.trim() ? "Give your product a name." : null;
  const kindErr = !kind ? "Pick what you are selling." : null;
  const priceErr = amount === null ? `Price it in ${token}, like 12 or 4.50.` : amount <= 0n ? "Payments on QoreChain need an amount above zero." : null;

  const next = async () => {
    setTried(true);
    if (titleErr || kindErr || priceErr || !kind || amount === null) return;
    if (!name) {
      setErr("Your page is not set up yet, so a product has nowhere to live. Finish setting up your page first. Nothing was saved.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const d = newDraft({ owner: owner.account.owner.address, name, kind, title: title.trim(), token, amount });
      await saveDraft(withToken(owner.account, await owner.token()), d);
      router.push(`/app/shop/${d.def.id}`);
    } catch (e) {
      setBusy(false);
      setErr(e instanceof ApiFailure ? e.message : "The product was not created. Nothing was saved.");
    }
  };

  const groups = (["Products", "Services"] as const).map((g) => ({ g, kinds: PRODUCT_KINDS.filter((k) => KIND_INFO[k].group === g) }));
  const show = (e: string | null) => (tried ? (e ?? undefined) : undefined);

  return (
    <div className={s.page}>
      <header className={s.top}>
        <div className={s.titleBlock}>
          <Kicker>あたらしい</Kicker>
          <h1>What are you making?</h1>
        </div>
        <div className={s.pushRight}>
          <ButtonLink href="/app/shop" variant="ghost">
            Cancel
          </ButtonLink>
          <Button variant="cord" iconRight="arrow" busy={busy} onClick={() => void next()}>
            Next: Customize
          </Button>
        </div>
      </header>
      <div className={s.newGrid}>
        <aside className={s.newIntro}>
          <p>
            Turn your idea into a live product in minutes. A name, a type and a price are enough to start; everything else waits in the editor.
          </p>
          <p className={s.help}>
            <Icon name="lock" size={15} /> What buyers get is sealed with a key only you hold, and each buyer receives their own sealed copy after their payment shows on QoreChain.
          </p>
        </aside>
        <form
          className={s.newForm}
          onSubmit={(e) => {
            e.preventDefault();
            void next();
          }}
        >
          <TextField label="Name" value={title} maxLength={120} placeholder="Name of product" onChange={(e) => setTitle(e.target.value)} error={show(titleErr)} autoFocus />
          {groups.map(({ g, kinds }) => (
            <fieldset key={g} className={s.typeGroup}>
              <legend>{g}</legend>
              <div className={s.typeGrid} role="radiogroup" aria-label={g}>
                {kinds.map((k) => (
                  <ChoiceCard
                    key={k}
                    selected={kind === k}
                    onSelect={() => setKind(k)}
                    tone={KIND_TONE[k]}
                    icon={<Icon name={KIND_ICON[k]} size={22} />}
                    title={KIND_INFO[k].label}
                    detail={KIND_INFO[k].line}
                  />
                ))}
              </div>
            </fieldset>
          ))}
          {tried && kindErr ? (
            <p className={s.fieldErr} role="alert">
              <Icon name="alert" size={15} /> {kindErr}
            </p>
          ) : null}
          <div className={s.fieldRow}>
            <TextField
              label={kind === "tip" ? "Smallest tip" : kind === "commission" ? "Full price (the deposit is part of it)" : "Price"}
              inputMode="decimal"
              value={price}
              placeholder="Price your product"
              onChange={(e) => setPrice(e.target.value)}
              error={show(priceErr)}
            />
            <Segmented<ShopToken> label="Token" value={token} onChange={setToken} options={TOKENS.map((t) => ({ value: t, label: t }))} />
          </div>
          {err ? <Oops title="Not created">{err}</Oops> : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      </div>
    </div>
  );
}
