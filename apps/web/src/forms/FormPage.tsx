"use client";
/**
 * A form at /@name/f/<slug>. Before showing a single question, this browser
 * checks that the form and the page are signed by the account that owns the
 * name, against that account's ML-DSA key read from QoreChain. A form that
 * fails the check is refused, so nobody types answers into a forgery.
 */
import { useEffect, useState } from "react";
import { ButtonLink, Musubi, Skeleton } from "@mizuhiki/ui";
import { verifyRecord, type FormDef, type Manifest, type RecipientCard, type Signed } from "@mizuhiki/core";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import { themeVars } from "@/page/theme";
import { FormRunner } from "./FormRunner";
import s from "./runner.module.css";

export function FormPage({
  name,
  page,
  card,
  owner,
  form,
  closedReason,
}: {
  name: string;
  page: Signed<Manifest>;
  card: RecipientCard | null;
  owner: string;
  form: Signed<FormDef>;
  closedReason: string | null;
}) {
  const [check, setCheck] = useState<"checking" | "ok" | "failed">("checking");
  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        const def = form.body;
        if (form.signer !== owner || def.owner !== owner || page.signer !== owner || def.name !== name)
          throw new Error("mismatch");
        const pq = await pqKeyViaEvm(owner);
        if (!pq.registered || !pq.publicKey || !pq.possessionProven) throw new Error("no key");
        verifyRecord(form, { kind: "form", signer: owner, pqPublicKey: pq.publicKey });
        if (life.alive) setCheck("ok");
      } catch {
        if (life.alive) setCheck("failed");
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [form, name, owner, page.signer]);

  const style = themeVars(page.body.theme);
  if (check === "checking")
    return (
      <div className={s.stage} style={style}>
        <main className={s.main}>
          <p className={s.kicker}>Checking @{name}&apos;s key on QoreChain…</p>
          <Skeleton lines={4} />
        </main>
      </div>
    );
  if (check === "failed")
    return (
      <div className={s.stage} style={style}>
        <div className={s.card} role="alert">
          <Musubi face="worried" size={110} />
          <h1 className={s.title}>This form could not be verified</h1>
          <p className={s.desc}>
            It does not match @{name}&apos;s key on QoreChain, so it was not opened. Nothing was sent.
          </p>
          <ButtonLink href={`/@${name}`} variant="line">
            Go to @{name}
          </ButtonLink>
        </div>
      </div>
    );
  return <FormRunner def={form.body} ownerCard={card} ownerName={name} pageStyle={style} closedReason={closedReason} />;
}
