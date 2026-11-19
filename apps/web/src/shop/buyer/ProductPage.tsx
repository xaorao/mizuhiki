"use client";
/**
 * The product page at /@name/p/<slug> (spec 5.11, Gumroad's product page):
 * cover or carousel, title, price ribbon, seller, rating, description, and on
 * the right the options (versions, amount, quantity, a call time), the main
 * button, "What's included", the delivery statement and the refund promise.
 * The record is checked in this browser against the seller's key on
 * QoreChain; a record that fails is a hard error, never the product.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Avatar,
  Button,
  ButtonLink,
  Chip,
  Icon,
  IconButton,
  Musubi,
  Sakura,
  Sheet,
  Skeleton,
  TextField,
  useToast,
} from "@mizuhiki/ui";
import { KIND_INFO, callSlots, formatAmount, parseAmount, type Manifest, type ProductDef } from "@mizuhiki/core";
import { mediaUrl } from "@/lib/api";
import { pageUrl } from "@/lib/site";
import { loadProduct, type PublicProduct } from "../engine";
import {
  addDays,
  amountOnly,
  minAmount,
  dayKey,
  ribbonLabel,
  slotsByDay,
  startOfWeek,
  suggestedAmount,
  unitPrice,
  type CartLine,
} from "./model";
import { RatingLine, RichText, Ribbon, ShopBar, Stars, Thumb, cachedShop, slotLabel, when } from "./parts";
import { getCart, isSaved, onStoreChange, putInCart, startNewCart, toggleSaved } from "./store";
import s from "./buyer.module.css";

type Loaded = PublicProduct & { def: ProductDef };
type Load =
  | { state: "loading" }
  | { state: "ok"; p: Loaded }
  | { state: "failed"; reason: string }
  | { state: "gone"; reason: string };

export interface SellerInfo {
  displayName: string;
  avatar: Manifest["avatar"];
  owner: string;
}

export function ProductPage({
  name,
  slug,
  seller,
  line,
}: {
  name: string;
  slug: string;
  seller: SellerInfo;
  line?: number | undefined;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    const life = { alive: true };
    loadProduct(name, slug).then(
      (p) => {
        if (!life.alive) return;
        if (p.def.owner !== seller.owner || p.def.name !== name)
          setLoad({
            state: "failed",
            reason: "This product is signed by a different account than the one that owns this page.",
          });
        else setLoad({ state: "ok", p });
      },
      (e: unknown) => {
        if (!life.alive) return;
        const msg = (e as Error).message || "";
        if (/not available/i.test(msg)) setLoad({ state: "gone", reason: msg });
        else setLoad({ state: "failed", reason: msg || "The signature on this product did not check out." });
      },
    );
    return () => {
      life.alive = false;
    };
  }, [name, slug, seller.owner]);

  if (load.state === "failed")
    return (
      <div className={s.stage}>
        <div className={s.hardFail} role="alert">
          <Musubi face="worried" size={110} />
          <h1>This product could not be verified</h1>
          <p>
            Its record does not match <b>@{name}</b>&apos;s key on QoreChain, so it is not shown and nothing can be
            bought here. Nothing has left your device.
          </p>
          <p className={s.mono}>{load.reason}</p>
          <ButtonLink href={`/@${name}`} variant="line" icon="back">
            Back to @{name}
          </ButtonLink>
        </div>
      </div>
    );
  if (load.state === "gone")
    return (
      <div className={s.stage}>
        <div className={s.hardFail}>
          <Musubi face="sleepy" size={110} bob />
          <h1>This product isn&apos;t available</h1>
          <p>The seller may have unpublished it. Their page is still there.</p>
          <ButtonLink href={`/@${name}`} variant="cord" icon="back">
            Back to @{name}
          </ButtonLink>
        </div>
      </div>
    );
  return (
    <div className={s.stage}>
      <Sakura count={4} />
      <div className={s.wrap}>
        <ShopBar name={name} />
        {load.state === "loading" ? (
          <ProductSkeleton />
        ) : (
          <Product p={load.p} name={name} seller={seller} line={line} />
        )}
      </div>
    </div>
  );
}

function ProductSkeleton() {
  return (
    <div className={s.productGrid} aria-busy="true" aria-label="Loading the product">
      <div className={[s.cover, s.coverSkel].join(" ")} />
      <div className={s.card}>
        <Skeleton lines={4} />
      </div>
      <div className={s.card}>
        <Skeleton lines={5} />
        <p className={s.checking}>
          <span className={s.spin} aria-hidden="true" />
          Checking the seller&apos;s key on QoreChain…
        </p>
      </div>
    </div>
  );
}

function Product({
  p,
  name,
  seller,
  line,
}: {
  p: Loaded;
  name: string;
  seller: SellerInfo;
  line?: number | undefined;
}) {
  const router = useRouter();
  const toast = useToast();
  const def = p.def;
  const token = def.price.token;
  const editing = line !== undefined ? getCart(name)?.lines[line] : undefined;
  const editingThis = editing && editing.productId === def.id ? editing : undefined;
  const firstOpen = def.versions.find((v) => (p.versionsLeft[v.id] ?? 1) !== 0);
  const [versionId, setVersionId] = useState<string | null>(editingThis?.versionId ?? firstOpen?.id ?? null);
  const [quantity, setQuantity] = useState(editingThis?.quantity ?? 1);
  const open = !!def.price.pwyw || def.kind === "tip";
  const [amount, setAmount] = useState(() =>
    editingThis?.chosen
      ? amountOnly(editingThis.chosen, token)
      : open
        ? amountOnly(suggestedAmount(def, versionId), token)
        : "",
  );
  const [slot, setSlot] = useState<string | null>(editingThis?.slot ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [tokenClash, setTokenClash] = useState<CartLine | null>(null);
  const [saved, setSaved] = useState(false);
  const [sticky, setSticky] = useState(false);
  const cta = useRef<HTMLButtonElement>(null);
  const options = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => setSaved(isSaved(def.id));
    read();
    return onStoreChange(read);
  }, [def.id]);
  // Sticky top bar once the main button scrolls away (Gumroad).
  useEffect(() => {
    const el = cta.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([e]) => setSticky(!!e && !e.isIntersecting && (e.boundingClientRect.top < 0 || window.innerWidth <= 980)),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const soldOut = p.left === 0;
  const versionLeft = versionId ? (p.versionsLeft[versionId] ?? null) : null;
  const maxQty = Math.max(1, Math.min(100, p.left ?? 100, versionLeft ?? 100));
  const chosen = open ? parseAmount(amount, token) : null;
  const unit = unitPrice(def, versionId, chosen);
  const min = open ? minAmount(def, versionId) : null;

  const add = (force?: boolean) => {
    setProblem(null);
    if (soldOut) return setProblem("This is sold out.");
    if (def.versions.length && !versionId) return setProblem("Pick an option first.");
    if (versionLeft === 0) return setProblem("That option is sold out. Pick another.");
    if (open && (chosen === null || unit === null))
      return setProblem(min !== null ? `Enter at least ${formatAmount(min, token)}.` : "Enter an amount.");
    if (def.kind === "call" && !slot) return setProblem("Pick a time for the call.");
    const item: CartLine = {
      productId: def.id,
      slug: def.slug,
      title: def.title,
      productVersion: def.version,
      versionId,
      quantity: def.limits.quantity ? quantity : 1,
      chosen: open && chosen !== null ? chosen.toString() : null,
      slot: def.kind === "call" ? slot : null,
    };
    const base = { name, seller: def.owner, token };
    if (force) startNewCart(base, item);
    else {
      const r = putInCart(base, item, editingThis ? line : undefined);
      if (!r.ok) {
        if (r.reason === "token") return setTokenClash(item);
        if (r.reason === "full") return setProblem("Your cart holds 20 items at most. Check out first.");
        return setProblem("This cart belongs to another shop.");
      }
    }
    router.push(`/@${name}/checkout`);
  };

  const needsChoice = def.versions.length > 0 || open || def.kind === "call";
  const covers = def.covers;
  const ribbon = open ? `${formatAmount(def.price.pwyw?.min ?? def.price.amount, token)}+` : ribbonLabel(def);
  const instant = def.delivery === "instant";

  return (
    <>
      {sticky ? (
        <div className={s.stickyBar} role="region" aria-label="Product summary">
          <div className={s.stickyInner}>
            <Ribbon>{ribbon}</Ribbon>
            <b className={s.stickyTitle}>{def.title}</b>
            <span className={s.stickyRating}>
              <RatingLine rating={p.rating} compact />
            </span>
            <Button
              size="sm"
              variant="cord"
              disabled={soldOut}
              onClick={() => {
                if (needsChoice) {
                  options.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                  options.current?.querySelector<HTMLElement>("button,input")?.focus({ preventScroll: true });
                } else add();
              }}
            >
              {soldOut ? "Sold out" : needsChoice ? "Choose" : def.cta}
            </Button>
          </div>
        </div>
      ) : null}

      <div className={s.productGrid}>
        <Covers def={def} covers={covers} />

        <section className={[s.card, s.mainCard].join(" ")} aria-labelledby="product-title">
          <p className={s.kindLine}>
            <Chip tone="kinari" icon="bag">
              {KIND_INFO[def.kind].label}
            </Chip>
            {p.sales ? (
              <span className={s.salesCount}>
                {p.sales.toLocaleString("en-US")} {p.sales === 1 ? "sale" : "sales"}
              </span>
            ) : null}
          </p>
          <h1 id="product-title" className={s.title}>
            {def.title}
          </h1>
          <div className={s.metaRow}>
            <Ribbon big>{ribbon}</Ribbon>
            <a className={s.sellerLink} href={`/@${name}`}>
              <Avatar
                name={seller.displayName}
                {...(seller.avatar ? { src: mediaUrl(seller.avatar.hash) } : {})}
                size={30}
              />
              <span>{seller.displayName}</span>
            </a>
            <RatingLine rating={p.rating} />
          </div>
          {def.summary ? <p className={s.summary}>{def.summary}</p> : null}
          <RichText text={def.description} />
          {def.kind === "bundle" && def.bundle ? <BundleParts name={name} ids={def.bundle.productIds} /> : null}
          <Reviews reviews={p.reviews} rating={p.rating} />
        </section>

        <aside className={[s.card, s.buyCard].join(" ")} aria-label="Buy">
          <div ref={options} className={s.options}>
            {def.versions.length ? (
              <div role="radiogroup" aria-label="Options" className={s.versions}>
                {def.versions.map((v) => {
                  const left = p.versionsLeft[v.id] ?? null;
                  const gone = left === 0;
                  const price = open
                    ? `${formatAmount(BigInt(def.price.pwyw?.min ?? def.price.amount) + BigInt(v.extra), token)}+`
                    : formatAmount(BigInt(def.price.amount) + BigInt(v.extra), token);
                  return (
                    <button
                      key={v.id}
                      type="button"
                      role="radio"
                      aria-checked={versionId === v.id}
                      disabled={gone}
                      className={[s.version, versionId === v.id ? s.versionOn : ""].join(" ")}
                      onClick={() => {
                        setVersionId(v.id);
                        if (open && !editingThis) setAmount(amountOnly(suggestedAmount(def, v.id), token));
                      }}
                    >
                      <span className={s.versionPrice}>{price}</span>
                      <span className={s.versionText}>
                        <b>{v.name}</b>
                        {v.description ? <small>{v.description}</small> : null}
                      </span>
                      {gone ? (
                        <span className={s.left}>Sold out</span>
                      ) : left !== null ? (
                        <span className={s.left}>{left} left</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {open ? (
              <div className={s.pwyw}>
                <TextField
                  label={
                    def.kind === "tip" ? `How much would you like to give? (${token})` : `Name a fair price (${token})`
                  }
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    const v = e.target.value.replace(/,/g, ".");
                    if (/^\d{0,12}(\.\d{0,6})?$/.test(v)) setAmount(v);
                    setProblem(null);
                  }}
                  error={
                    amount && chosen !== null && unit === null && min !== null
                      ? `At least ${formatAmount(min, token)}`
                      : undefined
                  }
                  hint={`From ${formatAmount(min ?? 0n, token)}. Suggested ${formatAmount(suggestedAmount(def, versionId), token)}.`}
                />
                <div className={s.quick} role="group" aria-label="Quick amounts">
                  {[1n, 2n, 5n].map((m) => {
                    const v = suggestedAmount(def, versionId) * m;
                    const label = amountOnly(v, token);
                    return (
                      <button
                        key={String(m)}
                        type="button"
                        aria-pressed={amount === label}
                        onClick={() => setAmount(label)}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {def.kind === "call" && def.booking ? (
              <SlotPicker booking={def.booking} booked={p.booked} value={slot} onChange={setSlot} />
            ) : null}

            {def.limits.quantity && !soldOut ? (
              <div className={s.qty}>
                <span id="qty-label">Quantity</span>
                <div className={s.qtyCtl} role="group" aria-labelledby="qty-label">
                  <Button
                    size="sm"
                    variant="line"
                    aria-label="One fewer"
                    className={s.qtyBtn}
                    disabled={quantity <= 1}
                    onClick={() => setQuantity((q) => Math.max(1, q - 1))}
                  >
                    −
                  </Button>
                  <output aria-live="polite">{quantity}</output>
                  <Button
                    size="sm"
                    variant="line"
                    aria-label="One more"
                    className={s.qtyBtn}
                    disabled={quantity >= maxQty}
                    onClick={() => setQuantity((q) => Math.min(maxQty, q + 1))}
                  >
                    +
                  </Button>
                </div>
              </div>
            ) : null}
          </div>

          {def.kind === "commission" && def.commission ? (
            <p className={s.note}>
              <Icon name="coin" size={18} />
              <span>
                You pay a <b>{def.commission.depositPercent}% deposit</b> now
                {unit !== null
                  ? ` (${formatAmount((unit * BigInt(quantity) * BigInt(def.commission.depositPercent)) / 100n, token)})`
                  : ""}
                . The rest is due when {seller.displayName.split(" ")[0]} finishes and asks for it; your copy is sealed
                to you after that.
              </span>
            </p>
          ) : null}

          {p.left !== null && !soldOut ? <p className={s.leftLine}>{p.left} left</p> : null}

          <Button ref={cta} variant="cord" size="xl" full disabled={soldOut} onClick={() => add()} className={s.cta}>
            {soldOut ? "Sold out" : editingThis ? "Update cart" : def.cta}
            {!soldOut && unit !== null ? (
              <span className={s.ctaPrice}>
                {formatAmount(unit * BigInt(def.limits.quantity ? quantity : 1), token)}
              </span>
            ) : null}
          </Button>
          {problem ? (
            <p className={s.problem} role="alert">
              {problem}
            </p>
          ) : null}
          <div className={s.ctaRow}>
            <Button
              variant="ghost"
              size="sm"
              icon="heart"
              aria-pressed={saved}
              onClick={() => {
                const now = toggleSaved({
                  name,
                  slug: def.slug,
                  productId: def.id,
                  title: def.title,
                  ribbon,
                  thumbnail: def.thumbnail ? mediaUrl(def.thumbnail.hash) : null,
                });
                toast.show(now ? "Saved on this device" : "Removed from Saved");
              }}
            >
              {saved ? "Saved" : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="link"
              onClick={() => {
                void navigator.clipboard.writeText(`${pageUrl(name)}/p/${def.slug}`).then(
                  () => toast.show("Link copied"),
                  () => toast.show("Copy is not allowed here", { tone: "error" }),
                );
              }}
            >
              Copy link
            </Button>
          </div>

          {def.details.length ? (
            <div className={s.included}>
              <h2>What&apos;s included</h2>
              <dl>
                {def.details.map((d, i) => (
                  <div key={i}>
                    <dt>{d.k}</dt>
                    <dd>{d.v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <div className={s.promises}>
            <p>
              <Icon name="lock" size={18} />
              <span>
                {instant ? (
                  <>
                    <b>Delivered at once by @{name}&apos;s helper.</b> The helper can read this product in order to
                    deliver it; it is then sealed to you.
                  </>
                ) : (
                  <>
                    <b>Sealed to you on your device after payment.</b> {seller.displayName.split(" ")[0]}&apos;s own
                    device seals it to you, so Mizuhiki never holds a key that opens it.
                  </>
                )}
              </span>
            </p>
            {def.refund ? (
              <p>
                <Icon name="undo" size={18} />
                <span>
                  <b>
                    Refund within {def.refund.days} {def.refund.days === 1 ? "day" : "days"}.
                  </b>{" "}
                  A promise from the seller, who sends it back from their wallet. {def.refund.finePrint}
                </span>
              </p>
            ) : null}
            <p>
              <Icon name="eye" size={18} />
              <span>The payment, its amount and the paying address are public on QoreChain.</span>
            </p>
          </div>
          <p className={s.verified}>
            <Icon name="shield" size={14} />
            Signed by @{name}&apos;s key, checked on QoreChain · version {def.version}
          </p>
        </aside>
      </div>

      <Sheet open={!!tokenClash} onClose={() => setTokenClash(null)} title="One token per order">
        <div className={s.sheetBody}>
          <p>
            Your cart with @{name} is paid in {getCart(name)?.token}. This is priced in {token}, and one order is paid
            in one token.
          </p>
          <div className={s.rowWrap}>
            <Button variant="line" onClick={() => router.push(`/@${name}/checkout`)}>
              Go to my cart
            </Button>
            <Button
              variant="cord"
              onClick={() => {
                setTokenClash(null);
                add(true);
              }}
            >
              Start a new cart with this
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

function Covers({ def, covers }: { def: ProductDef; covers: ProductDef["covers"] }) {
  const [i, setI] = useState(0);
  if (covers.length === 0)
    return (
      <div className={[s.cover, s.coverPlain, "seigaiha"].join(" ")}>
        <Thumb def={def} size={150} />
      </div>
    );
  const c = covers[Math.min(i, covers.length - 1)];
  return (
    <div className={s.cover} aria-roledescription="carousel" aria-label="Product pictures">
      {c ? (
        c.type.startsWith("video/") ? (
          <video key={c.hash} src={mediaUrl(c.hash)} controls playsInline className={s.coverMedia} />
        ) : (
          <img
            key={c.hash}
            src={mediaUrl(c.hash)}
            alt={`${def.title}, picture ${i + 1} of ${covers.length}`}
            className={s.coverMedia}
          />
        )
      ) : null}
      {covers.length > 1 ? (
        <>
          <IconButton
            icon="back"
            label="Previous picture"
            variant="line"
            className={s.coverPrev}
            onClick={() => setI((x) => (x - 1 + covers.length) % covers.length)}
          />
          <IconButton
            icon="chev"
            label="Next picture"
            variant="line"
            className={s.coverNext}
            onClick={() => setI((x) => (x + 1) % covers.length)}
          />
          <div className={s.dots} role="tablist" aria-label="Pictures">
            {covers.map((x, j) => (
              <button
                key={x.hash}
                type="button"
                role="tab"
                aria-selected={j === i}
                aria-label={`Picture ${j + 1}`}
                onClick={() => setI(j)}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function BundleParts({ name, ids }: { name: string; ids: string[] }) {
  const [parts, setParts] = useState<ProductDef[] | null>(null);
  useEffect(() => {
    void cachedShop(name).then(
      (items) => setParts(ids.map((id) => items.find((x) => x.def.id === id)?.def).filter((d): d is ProductDef => !!d)),
      () => setParts([]),
    );
  }, [name, ids]);
  if (!parts?.length) return null;
  return (
    <div className={s.bundle}>
      <h2>In this bundle</h2>
      <ul>
        {parts.map((d) => (
          <li key={d.id}>
            <a href={`/@${name}/p/${d.slug}`}>
              <Thumb def={d} size={44} />
              <span>
                <b>{d.title}</b>
                <small>{KIND_INFO[d.kind].label}</small>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reviews({ reviews, rating }: { reviews: PublicProduct["reviews"]; rating: PublicProduct["rating"] }) {
  if (rating.count === 0) return null;
  const fresh = Date.now() - 14 * 86_400_000;
  return (
    <section className={s.reviews} aria-label="Ratings and reviews">
      <h2>
        Ratings <span>{rating.count}</span>
      </h2>
      <ul>
        {reviews.map((r, i) => (
          <li key={i} style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}>
            <div className={s.reviewHead}>
              <Stars value={r.rating} size={15} />
              <span className="sr-only">{r.rating} out of 5</span>
              {new Date(r.at).getTime() > fresh ? <span className={s.newBadge}>New</span> : null}
              <small>{when(r.at)}</small>
            </div>
            {r.text ? <p>{r.text}</p> : null}
            <small className={s.verifiedBuyer}>
              <Icon name="check" size={13} /> Verified buyer
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A week of free call times in the buyer's own time zone (from the seller's weekly hours, minus booked ones). */
function SlotPicker({
  booking,
  booked,
  value,
  onChange,
}: {
  booking: NonNullable<ProductDef["booking"]>;
  booked: string[];
  value: string | null;
  onChange: (iso: string) => void;
}) {
  const [week, setWeek] = useState(0);
  const [now] = useState(() => new Date());
  const start = useMemo(() => addDays(startOfWeek(now), week * 7), [now, week]);
  const days = useMemo(() => slotsByDay(callSlots(booking, start, booked, now), start), [booking, start, booked, now]);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [day, setDay] = useState<string | null>(null);
  const firstFree = days.find((d) => d.slots.length)?.day;
  const shown =
    days.find((d) => dayKey(d.day) === day) ?? (firstFree ? days.find((d) => d.day === firstFree) : undefined);
  const total = days.reduce((n, d) => n + d.slots.length, 0);
  return (
    <div className={s.slots}>
      <div className={s.slotHead}>
        <b>
          <Icon name="calendar" size={18} /> Pick a time · {booking.minutes} min
        </b>
        <span className={s.slotNav}>
          <IconButton
            icon="back"
            label="Earlier week"
            size="sm"
            variant="line"
            disabled={week === 0}
            onClick={() => (setWeek((w) => w - 1), setDay(null))}
          />
          <span>{start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
          <IconButton
            icon="chev"
            label="Later week"
            size="sm"
            variant="line"
            disabled={week >= 7}
            onClick={() => (setWeek((w) => w + 1), setDay(null))}
          />
        </span>
      </div>
      <div className={s.days} role="tablist" aria-label="Days">
        {days.map((d) => {
          const k = dayKey(d.day);
          const on = shown && dayKey(shown.day) === k;
          return (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={!!on}
              disabled={d.slots.length === 0}
              onClick={() => setDay(k)}
            >
              <small>{d.day.toLocaleDateString("en-GB", { weekday: "short" })}</small>
              <b>{d.day.getDate()}</b>
            </button>
          );
        })}
      </div>
      {total === 0 ? (
        <p className={s.fine}>No free times this week. Try the next one.</p>
      ) : shown ? (
        <div
          className={s.times}
          role="radiogroup"
          aria-label={`Times on ${shown.day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}`}
        >
          {shown.slots.map((iso) => (
            <button key={iso} type="button" role="radio" aria-checked={value === iso} onClick={() => onChange(iso)}>
              {new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </button>
          ))}
        </div>
      ) : null}
      <p className={s.fine}>
        {value ? <b>{slotLabel(value)}. </b> : null}Times shown in your time zone ({tz}).
        {booking.place ? ` Where: ${booking.place}` : ""}
      </p>
    </div>
  );
}
