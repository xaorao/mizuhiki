"use client";
/**
 * Delivery (spec 11, decision 1): private by default, where this device seals
 * each buyer's copy while your dashboard is open or the next time it opens;
 * or "Instant delivery" through a helper, which can read this product.
 */
import { useEffect, useState } from "react";
import { ChoiceCard, Icon, Panel, TextField } from "@mizuhiki/ui";
import { cardOf, offeredHelper } from "../engine";
import type { EditorProps } from "./editorTypes";
import s from "./seller.module.css";
import { failureText } from "@/lib/failure";

const ADDR = /^qor1[02-9ac-hj-np-z]{38}$/;

export function DeliveryPanel({ draft, patch }: EditorProps) {
  const def = draft.def;
  const [offered, setOffered] = useState<string | null | undefined>(undefined);
  const [check, setCheck] = useState<{ addr: string; ok: boolean; why?: string } | null>(null);

  useEffect(() => {
    offeredHelper().then(setOffered, () => setOffered(null));
  }, []);

  const agent = def.agent ?? "";
  const valid = ADDR.test(agent);
  // Check that the helper has a sealing key before the seller relies on it.
  useEffect(() => {
    if (def.delivery !== "instant" || !valid) return;
    let alive = true;
    const t = setTimeout(() => {
      cardOf(agent).then(
        () => alive && setCheck({ addr: agent, ok: true }),
        (e: unknown) =>
          alive &&
          setCheck({
            addr: agent,
            ok: false,
            why: failureText(e, "This address has no sealing key."),
          }),
      );
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [agent, valid, def.delivery]);
  const status = check?.addr === agent ? check : null;

  return (
    <Panel title="Delivery" kicker="おとどけ">
      <div className={s.stack}>
        <div className={s.typeGrid} role="radiogroup" aria-label="How buyers get their copy">
          <ChoiceCard
            selected={def.delivery === "seller"}
            onSelect={() => patch({ delivery: "seller", agent: null })}
            tone="matcha"
            icon={<Icon name="lock" size={22} />}
            title="Your device (private)"
            detail="Nobody else ever holds the product key."
          />
          <ChoiceCard
            selected={def.delivery === "instant"}
            onSelect={() => patch({ delivery: "instant", agent: def.agent ?? offered ?? null })}
            tone="butter"
            icon={<Icon name="send" size={22} />}
            title="Instant delivery"
            detail="A helper seals each copy at once, day or night."
          />
        </div>
        {def.delivery === "seller" ? (
          <p className={s.note}>
            The buyer&rsquo;s copy is sealed when your dashboard is open, or the next time it opens. Until then the
            buyer sees their payment confirmed and &ldquo;waiting for the seller to seal your copy&rdquo;.
          </p>
        ) : (
          <div className={s.stack}>
            <TextField
              label="Helper address"
              value={agent}
              spellCheck={false}
              autoCapitalize="none"
              placeholder="qor1…"
              onChange={(e) => patch({ agent: e.target.value.trim() || null }, "agent")}
              error={
                agent && !valid
                  ? "Use a full QoreChain address, starting with qor1."
                  : !agent
                    ? "Instant delivery needs a helper's address."
                    : status && !status.ok
                      ? status.why
                      : undefined
              }
              ok={status?.ok ? "This helper has a sealing key on QoreChain." : undefined}
              hint={
                offered === undefined
                  ? "Looking up the helper Mizuhiki offers…"
                  : offered
                    ? agent === offered
                      ? "The helper Mizuhiki runs. You can run your own and put its address here instead."
                      : "Your own helper. The one Mizuhiki runs can be filled back in below."
                    : "Mizuhiki does not offer a helper here. Run your own and put its address here."
              }
            />
            {offered && agent !== offered ? (
              <button type="button" className={s.linkBtn} onClick={() => patch({ agent: offered })}>
                Use the helper Mizuhiki runs
              </button>
            ) : null}
            <p className={s.warnStrong}>
              <Icon name="alert" size={16} /> The helper can read this product. Publishing seals the product key to it,
              so it can open what buyers get. Choose this only for something you are comfortable sharing with the
              helper&rsquo;s operator.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}
