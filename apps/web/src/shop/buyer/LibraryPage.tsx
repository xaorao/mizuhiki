"use client";
import Link from "next/link";
/**
 * The library at /library (spec 5.11, Gumroad's Library): "Purchases for this
 * wallet" from the unlocked account, every buyer key kept on this device, and
 * orders placed here; "Open with my 12 words" for another device. Tabs
 * Purchases · Saved · Reviews (Saved and Reviews live on this device).
 */
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  Kicker,
  Oops,
  Sakura,
  Skeleton,
  StatusChip,
  Tabs,
  TextArea,
  TextField,
  type Status,
} from "@mizuhiki/ui";
import { formatAmount, isValidPhrase, normalizePhrase, type ProductDef } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { ApiFailure } from "@/lib/api";
import {
  buyerKeyFrom,
  buyerKeys,
  forgetBuyerKey,
  getOrder,
  keyOrders,
  myOrders,
  rememberBuyerKey,
  verifyProduct,
  withToken,
  type BuyerKey,
  type OrderView,
} from "../engine";
import { fingerprint } from "./model";
import { ShopBar, Stars, Thumb, when } from "./parts";
import {
  localOrders,
  onStoreChange,
  postedReviews,
  savedProducts,
  toggleSaved,
  type PostedReview,
  type SavedProduct,
} from "./store";
import s from "./buyer.module.css";

type Tab = "purchases" | "saved" | "reviews";
interface Row {
  o: OrderView;
  defs: ProductDef[];
  via: string;
}

const STATUS: Record<OrderView["status"], { s: Status; w: string }> = {
  awaiting: { s: "wait", w: "Not paid yet" },
  in_progress: { s: "info", w: "Deposit paid" },
  paid: { s: "wait", w: "Being prepared" },
  delivered: { s: "ok", w: "Ready" },
  refunded: { s: "neutral", w: "Refunded" },
  expired: { s: "neutral", w: "Hold ended" },
};

const defCache = new Map<string, Promise<ProductDef | null>>();
const checked = (r: OrderView["records"][number]) => {
  const k = `${r.body.id}:${r.body.version}`;
  let p = defCache.get(k);
  if (!p) {
    p = verifyProduct(r).catch(() => null);
    defCache.set(k, p);
  }
  return p;
};

export function LibraryPage() {
  const acct = useAccount();
  const [tab, setTab] = useState<Tab>("purchases");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [keys, setKeys] = useState<BuyerKey[]>([]);
  const [saved, setSaved] = useState<SavedProduct[]>([]);
  const [reviews, setReviews] = useState<PostedReview[]>([]);
  const [words, setWords] = useState(false);

  useEffect(() => {
    const read = () => {
      setSaved(savedProducts());
      setReviews(postedReviews());
    };
    read();
    return onStoreChange(read);
  }, []);

  const load = useCallback(async () => {
    const found = new Map<string, Row>();
    const errs: string[] = [];
    const add = async (list: OrderView[], via: string) => {
      for (const o of list) {
        if (found.has(o.ref)) continue;
        const defs = (await Promise.all(o.records.map(checked))).filter(
          (d): d is ProductDef => !!d && o.request.lines.some((l) => l.productId === d.id),
        );
        found.set(o.ref, { o, defs, via });
      }
    };
    if (acct.status === "unlocked" && acct.account) {
      try {
        await add(await myOrders(withToken(acct.account, await acct.token())), "account");
      } catch (e) {
        errs.push(
          `Your account's purchases could not be loaded: ${e instanceof ApiFailure ? e.message : "try again"}.`,
        );
      }
    }
    const ks = await buyerKeys().catch(() => [] as BuyerKey[]);
    setKeys(ks);
    for (const k of ks) {
      try {
        await add(await keyOrders(k), `key ${fingerprint(k.hash, 8)}`);
      } catch {
        errs.push(`Purchases for buyer key ${fingerprint(k.hash, 8)} could not be loaded.`);
      }
    }
    for (const l of localOrders()) {
      if (found.has(l.ref)) continue;
      try {
        const o = await getOrder(l.ref);
        if (o.status === "expired" && l.txs.length === 0) continue;
        await add([o], "this device");
      } catch {
        // An order this device placed that the server no longer has (an unpaid hold that was swept).
      }
    }
    setRows(
      [...found.values()]
        .filter((r) => r.o.status !== "expired" || r.via === "this device")
        .sort((a, b) => b.o.createdAt.localeCompare(a.o.createdAt)),
    );
    setProblems(errs);
  }, [acct]);

  useEffect(() => {
    if (acct.status === "loading") return;
    void load();
  }, [acct.status, load]);

  return (
    <div className={s.stage}>
      <Sakura count={4} />
      <div className={s.wrap}>
        <ShopBar inLibrary />
        <header className={s.checkoutHead}>
          <div>
            <Kicker>ライブラリ</Kicker>
            <h1 className={s.pageTitle}>Library</h1>
            <p className={s.lede}>
              Purchases for this wallet. Everything opens on this device; Mizuhiki only holds the sealed copies.
            </p>
          </div>
          <Button variant="line" icon="key" onClick={() => setWords((w) => !w)} aria-expanded={words}>
            Open with my 12 words
          </Button>
        </header>
        {words ? (
          <WordsBox
            onKey={(k) => {
              setWords(false);
              setKeys((all) => [...all.filter((x) => x.hash !== k.hash), k]);
              void load();
            }}
          />
        ) : null}

        <Tabs<Tab>
          label="Library"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "purchases", label: "Purchases", badge: rows?.length || undefined },
            { value: "saved", label: "Saved", badge: saved.length || undefined },
            { value: "reviews", label: "Reviews", badge: reviews.length || undefined },
          ]}
        />

        {tab === "purchases" ? (
          <section aria-label="Purchases" className={s.libSection}>
            <WhoBar keys={keys} onForget={(h) => void forgetBuyerKey(h).then(load)} />
            {problems.map((p) => (
              <Oops key={p} title="Some purchases are missing here">
                {p} Nothing you bought is lost; it stays sealed on Mizuhiki.
              </Oops>
            ))}
            {rows === null ? (
              <div className={s.libGrid}>
                {[0, 1, 2].map((i) => (
                  <div key={i} className={s.card}>
                    <Skeleton lines={3} avatar />
                  </div>
                ))}
              </div>
            ) : rows.length === 0 ? (
              <div className={s.card}>
                <EmptyState title="You haven't bought anything... yet" face="sleepy" jp="まだないよ">
                  Once you do, it shows up here for this wallet, ready to open. Bought with a buyer key on another
                  device? Use Open with my 12 words.
                </EmptyState>
              </div>
            ) : (
              <ul className={s.libGrid}>
                {rows.map((r, i) => {
                  const d = r.defs[0];
                  const st = STATUS[r.o.status];
                  return (
                    <li key={r.o.ref} style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
                      <Link className={s.libCard} href={`/library/${r.o.ref}`}>
                        {d ? <Thumb def={d} size={96} /> : <span className={s.thumbGone} />}
                        <span className={s.libText}>
                          <b>{r.defs.map((x) => x.title).join(", ") || "A product that could not be checked"}</b>
                          <small>
                            @{d?.name ?? "?"} · {when(r.o.createdAt)}
                          </small>
                          <span className={s.libMeta}>
                            <StatusChip status={st.s}>{st.w}</StatusChip>
                            <span>{formatAmount(r.o.total, r.o.token)}</span>
                            {r.o.request.gift ? <span className={s.giftTag}>Gift</span> : null}
                          </span>
                        </span>
                        <Icon name="chev" size={18} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ) : tab === "saved" ? (
          <section aria-label="Saved" className={s.libSection}>
            {saved.length === 0 ? (
              <div className={s.card}>
                <EmptyState title="Save products you are wishing for" face="wink" jp="ほしいもの">
                  Tap the heart on any product page to keep it here. Saved items stay on this device only.
                </EmptyState>
              </div>
            ) : (
              <ul className={s.libGrid}>
                {saved.map((p) => (
                  <li key={p.productId}>
                    <div className={s.libCard}>
                      <Link href={`/@${p.name}/p/${p.slug}`} className={s.libLink}>
                        {p.thumbnail ? (
                          <span className={s.thumb}>
                            <img src={p.thumbnail} alt="" />
                          </span>
                        ) : (
                          <span className={[s.thumb, s.tt_sakura].join(" ")}>
                            <Icon name="heart" size={32} />
                          </span>
                        )}
                        <span className={s.libText}>
                          <b>{p.title}</b>
                          <small>@{p.name}</small>
                          <span className={s.libMeta}>{p.ribbon}</span>
                        </span>
                      </Link>
                      <Button size="sm" variant="ghost" onClick={() => toggleSaved(p)}>
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <section aria-label="Reviews" className={s.libSection}>
            {reviews.length === 0 ? (
              <div className={s.card}>
                <EmptyState
                  title="You haven't reviewed anything... yet"
                  face="sleepy"
                  action={
                    rows?.some((r) => r.o.status === "delivered") ? (
                      <Button variant="cord" onClick={() => setTab("purchases")}>
                        Rate a purchase
                      </Button>
                    ) : undefined
                  }
                >
                  Once you rate a purchase, it shows up here so you can find and edit it.
                </EmptyState>
              </div>
            ) : (
              <ul className={s.libGrid}>
                {reviews.map((r) => (
                  <li key={`${r.ref}-${r.productId}`}>
                    <Link className={s.libCard} href={`/library/${r.ref}`}>
                      <span className={s.libText}>
                        <b>{r.title}</b>
                        <small>
                          @{r.name} · {when(r.at)}
                        </small>
                        <Stars value={r.rating} size={16} />
                        {r.text ? <span className={s.reviewText}>{r.text}</span> : null}
                      </span>
                      <Icon name="chev" size={18} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** Whose purchases are listed: the account (or why not) and the buyer keys kept here. */
function WhoBar({ keys, onForget }: { keys: BuyerKey[]; onForget: (hash: string) => void }) {
  const acct = useAccount();
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <div className={[s.card, s.who].join(" ")}>
      {acct.status === "unlocked" && acct.account ? (
        <p>
          <Icon name="key" size={16} /> Account{" "}
          <code className={s.mono}>
            {acct.account.owner.address.slice(0, 14)}…{acct.account.owner.address.slice(-6)}
          </code>
        </p>
      ) : acct.status === "locked" ? (
        <form
          className={s.unlockRow}
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setErr(undefined);
            acct
              .unlock(pass)
              .catch((x: unknown) => setErr((x as Error).message))
              .finally(() => setBusy(false));
          }}
        >
          <TextField
            label="Unlock to see your account's purchases"
            type="password"
            placeholder="Device passphrase"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={err}
            autoComplete="current-password"
          />
          <Button type="submit" variant="line" icon="key" busy={busy} disabled={!pass}>
            Unlock
          </Button>
        </form>
      ) : acct.status === "none" ? (
        <p className={s.fine}>
          <span>
            No Mizuhiki account on this device. <a href="/login?next=/library">Log in</a> to see its purchases too.
          </span>
        </p>
      ) : null}
      {keys.map((k) => (
        <p key={k.hash}>
          <Icon name="lock" size={16} /> Buyer key <code className={s.mono}>{fingerprint(k.hash, 16)}</code>
          <button type="button" className={s.linkBtn} onClick={() => onForget(k.hash)}>
            Forget on this device
          </button>
        </p>
      ))}
    </div>
  );
}

function WordsBox({ onKey }: { onKey: (k: BuyerKey) => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const n = normalizePhrase(text) ? normalizePhrase(text).split(" ").length : 0;
  return (
    <form
      className={[s.card, s.wordsBox].join(" ")}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(undefined);
        if (n !== 12 || !isValidPhrase(text))
          return setErr("Type all 12 words of your buyer key, in order. Each word is checked on this device.");
        setBusy(true);
        const k = buyerKeyFrom(text);
        rememberBuyerKey(k)
          .then(() => onKey(k))
          .catch(() => setErr("This browser would not keep the key; your words still work each time you type them."))
          .finally(() => setBusy(false));
      }}
    >
      <TextArea
        label="Your buyer key's 12 words"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        error={err}
        autoComplete="off"
        spellCheck={false}
        hint={`${n} of 12 words. Never sent anywhere.`}
      />
      <Button type="submit" variant="cord" icon="key" busy={busy} disabled={n !== 12}>
        Open my purchases
      </Button>
      <p className={s.fine}>
        The key is kept on this device so your purchases open next time too. You can forget it here any time.
      </p>
      <ButtonLink variant="ghost" href="/login?next=/library">
        Have a full Mizuhiki account? Log in
      </ButtonLink>
    </form>
  );
}
