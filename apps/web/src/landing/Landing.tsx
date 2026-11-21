"use client";
/**
 * The landing page (spec 5.1), section for section from the approved Level 3
 * preview (`brand/prototype/mizuhiki-l3.html`), with the preview's mock
 * screens replaced by real ones: demo pages and @aria's owner app captured
 * from the running product on the QoreChain test network
 * (`tests/e2e/demo/landing-shots.spec.ts`).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import QRCode from "qrcode";
import {
  Icon,
  Knot,
  Musubi,
  Wordmark,
  burstFrom,
  useMusubi,
  useReducedMotion,
  useToast,
  type IconName,
} from "@mizuhiki/ui";
import { useAccount } from "@/account/AccountProvider";
import { SITE_HOST, pageUrl } from "@/lib/site";
import { ClaimBox } from "./ClaimBox";
import { TrySeal } from "./TrySeal";
import { ProofCards } from "./ProofCards";
import s from "./landing.module.css";
import pageAria from "./shots/page-aria.png";
import pageRohan from "./shots/page-rohan.law.png";
import pageSunrise from "./shots/page-sunrise.clinic.png";
import pageMaya from "./shots/page-maya.studio.png";
import pageKapoor from "./shots/page-kapoor.family.png";
import appInbox from "./shots/app-inbox.png";
import appRoom from "./shots/app-room.png";
import appCapsule from "./shots/app-capsule.png";
import appPass from "./shots/app-pass.png";
import appAddBlock from "./shots/app-add-block.png";

// ---- content -----------------------------------------------------------------------------------------

const NAV: [string, string][] = [
  ["#features", "Features"],
  ["#how", "How it works"],
  ["#templates", "Templates"],
  ["#security", "Security"],
  ["#faq", "Questions"],
];

const MARQUEE: [string, string][] = [
  ["封", "Contracts"],
  ["秘", "Lab results"],
  ["結", "Invoices"],
  ["鍵", "Family documents"],
  ["縁", "Client files"],
  ["封", "Applications"],
  ["秘", "Payroll"],
  ["結", "Course files"],
  ["鍵", "Passport scans"],
  ["縁", "Deal rooms"],
];

const BLOCKS: { icon: IconName; bg: string; fg: string; title: string; body: string; tag: string; pub?: boolean }[] = [
  {
    icon: "coin",
    bg: "var(--matcha-tile)",
    fg: "var(--matcha-ink)",
    title: "Pay me",
    body: "Any amount, with a note only you can read.",
    tag: "Note sealed · amount public",
    pub: true,
  },
  {
    icon: "form",
    bg: "var(--sora)",
    fg: "var(--sora-ink)",
    title: "Invoices",
    body: "Line items open for you, your client and your accountant.",
    tag: "Sealed to its readers",
  },
  {
    icon: "mail",
    bg: "var(--sakura)",
    fg: "var(--cord-text)",
    title: "Messages and files",
    body: "A drop box for notes and files up to 2 GB. No account needed.",
    tag: "Sealed before upload",
  },
  {
    icon: "inbox",
    bg: "var(--butter)",
    fg: "var(--butter-ink)",
    title: "File requests",
    body: "Ask for exactly the documents you need, with a checklist.",
    tag: "Sealed before upload",
  },
  {
    icon: "pen",
    bg: "var(--fuji)",
    fg: "var(--fuji-ink)",
    title: "Forms",
    body: "Intake, applications, feedback. Answers sealed in the browser.",
    tag: "Answers sealed",
  },
  {
    icon: "bag",
    bg: "var(--peach)",
    fg: "var(--cord-text)",
    title: "Shop",
    body: "Sell files and templates. Each buyer gets their own sealed copy.",
    tag: "Sealed per buyer",
  },
  {
    icon: "chat",
    bg: "var(--sora)",
    fg: "var(--sora-ink)",
    title: "Rooms",
    body: "Group chats and files. Remove someone and the room gets a new key.",
    tag: "Sealed to members",
  },
  {
    icon: "pass",
    bg: "var(--matcha-tile)",
    fg: "var(--matcha-ink)",
    title: "Passes",
    body: "Give your accountant one quarter, not everything. Revoke any time.",
    tag: "Scoped readers",
  },
  {
    icon: "hour",
    bg: "var(--butter)",
    fg: "var(--butter-ink)",
    title: "Capsules",
    body: "Files that open on a date, or if you stop checking in.",
    tag: "Sealed until release",
  },
  {
    icon: "key",
    bg: "var(--sakura)",
    fg: "var(--cord-text)",
    title: "Spare key",
    body: "Recovery contacts and a printable sheet, so a lost phone loses nothing.",
    tag: "Split among contacts",
  },
  {
    icon: "check",
    bg: "var(--fuji)",
    fg: "var(--fuji-ink)",
    title: "Receipts and proof",
    body: "Every seal gets a receipt. Anchor any file on QoreChain to prove it existed.",
    tag: "Hash on chain",
    pub: true,
  },
  {
    icon: "chart",
    bg: "var(--peach)",
    fg: "var(--cord-text)",
    title: "Insights",
    body: "Visits, taps and payments. We count, we never read.",
    tag: "Counts only",
    pub: true,
  },
];

const STEPS = [
  {
    n: 1,
    title: "You publish your key",
    body: "When you sign up, your device makes a key pair. The public half goes on QoreChain, next to your page name. The private half never leaves your device.",
    jp: "かぎ · key",
  },
  {
    n: 2,
    title: "They seal on their device",
    body: "A visitor writes a note or drops a file. Their browser reads your public key from QoreChain and seals it before anything is uploaded.",
    jp: "むすぶ · tie",
  },
  {
    n: 3,
    title: "You open it, only you",
    body: "The sealed copy waits in your inbox, and only your device can open it. Both of you keep a receipt that proves what was sealed and when.",
    jp: "ひらく · open",
  },
];

const TOUR: { key: string; icon: IconName; title: string; sub: string; img: StaticImageData; alt: string }[] = [
  {
    key: "inbox",
    icon: "inbox",
    title: "Inbox",
    sub: "Sealed until you open it",
    img: appInbox,
    alt: "Mizuhiki inbox with sealed messages, one opened on this device with a contract attached",
  },
  {
    key: "rooms",
    icon: "chat",
    title: "Rooms",
    sub: "The key changes when people leave",
    img: appRoom,
    alt: "A Mizuhiki room called Spring launch, with sealed messages from two members",
  },
  {
    key: "capsules",
    icon: "hour",
    title: "Capsules",
    sub: "Open later, or if you go quiet",
    img: appCapsule,
    alt: "A capsule set to open for the family after 12 months without a check-in",
  },
  {
    key: "passes",
    icon: "pass",
    title: "Passes",
    sub: "One quarter for your accountant",
    img: appPass,
    alt: "An active pass giving an accountant read-only access to one quarter",
  },
];

const TEMPLATES: { img: StaticImageData; title: string; sub: string; name: string }[] = [
  { img: pageAria, title: "Freelancers", sub: "Payments, client files, briefs", name: "aria" },
  { img: pageRohan, title: "Lawyers and advisers", sub: "Documents in, invoices out", name: "rohan.law" },
  { img: pageSunrise, title: "Clinics", sub: "Questions, results, intake", name: "sunrise.clinic" },
  { img: pageMaya, title: "Creators who sell", sub: "Shop, commissions, tips", name: "maya.studio" },
  { img: pageKapoor, title: "Families", sub: "Documents, rooms, capsules", name: "kapoor.family" },
];

const FAQ: [string, ReactNode][] = [
  [
    "Can Mizuhiki read what people send me?",
    "No. Everything is sealed on the sender's device with your public key before it is uploaded. We store the sealed copy and never have the key that opens it.",
  ],
  [
    "Do my visitors need an account or a wallet?",
    "No. Anyone can send a message, a file or a form answer from a normal browser, on a phone or a computer. A wallet is only needed to pay, and a key only to join a room or keep a purchase.",
  ],
  [
    "What does post-quantum mean for me?",
    "Files are sealed with ML-KEM-1024, the method NIST standardised in 2024 for the age of quantum computers, and pages are signed with ML-DSA-87. What people send you today stays private even if someone records it now and tries to open it years from now.",
  ],
  [
    "What if I lose my phone?",
    "Restore from your recovery phrase, or from your spare key: recovery contacts each hold one piece, and enough of them together rebuild it after a 48-hour wait you can cancel. Without either, nobody can open your sealed items, including us.",
  ],
  [
    "What does it cost?",
    "Mizuhiki is free while it runs on the QoreChain test network. Network fees are paid in test QOR.",
  ],
  ["Is it live?", "Mizuhiki runs on the QoreChain test network today. Payments use test tokens with no real value."],
];

// ---- pieces ------------------------------------------------------------------------------------------

function Petals() {
  const reduced = useReducedMotion();
  if (reduced) return null;
  const spots: [number, number, number][] = [
    [8, -1, 10],
    [22, -6, 12],
    [41, -3, 9],
    [55, -8, 13],
    [70, -2, 11],
    [86, -5, 10],
    [94, -9, 14],
  ];
  return (
    <div className={s.petals} aria-hidden="true">
      {spots.map(([left, delay, dur]) => (
        <svg
          key={left}
          viewBox="0 0 40 40"
          style={{ left: `${left}%`, animationDelay: `${delay}s`, animationDuration: `${dur}s` }}
        >
          <path d="M20 4 C30 10 34 22 20 36 C6 22 10 10 20 4Z" fill="#ffb3c3" stroke="#f08aa3" strokeWidth="1.5" />
          <path d="M20 4 L20 13" stroke="#f08aa3" strokeWidth="1.5" />
        </svg>
      ))}
    </div>
  );
}

/** The noshi envelope with its wax seal (preview `p-env`). */
function Envelope({ className }: { className?: string | undefined }) {
  return (
    <svg viewBox="0 0 240 170" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="lp-paper" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fffaf3" />
          <stop offset="1" stopColor="#eadfcf" />
        </linearGradient>
        <radialGradient id="lp-wax" cx=".35" cy=".3" r=".8">
          <stop offset="0" stopColor="#ff6a45" />
          <stop offset=".6" stopColor="#c62d0d" />
          <stop offset="1" stopColor="#7d1804" />
        </radialGradient>
      </defs>
      <rect x="4" y="10" width="232" height="152" rx="14" fill="url(#lp-paper)" />
      <path d="M4 24 120 104 236 24" fill="none" stroke="#d8cbb7" strokeWidth="3" />
      <path d="M4 24 C4 16 10 10 18 10 H222 C230 10 236 16 236 24 L120 104Z" fill="#f6eee2" />
      <circle cx="120" cy="100" r="34" fill="url(#lp-wax)" />
      <circle cx="120" cy="100" r="25" fill="none" stroke="#ff9a7a" strokeOpacity=".55" strokeWidth="2" />
      <text
        x="120"
        y="111"
        textAnchor="middle"
        fontSize="30"
        fontWeight="700"
        fill="#ffe3d6"
        fontFamily="var(--font-jp), sans-serif"
      >
        封
      </text>
    </svg>
  );
}

function Phone({
  img,
  alt,
  className,
  preload,
}: {
  img: StaticImageData;
  alt: string;
  className?: string | undefined;
  preload?: boolean | undefined;
}) {
  return (
    <div className={[s.phone, className ?? ""].join(" ")}>
      <div className={s.phoneScr}>
        <Image
          src={img}
          alt={alt}
          sizes="(max-width: 560px) 60vw, 300px"
          placeholder="blur"
          preload={preload ?? false}
        />
      </div>
    </div>
  );
}

function Head({ jp, title, children }: { jp: string; title: string; children?: ReactNode }) {
  return (
    <div className={s.cHead}>
      <p className={s.jp} lang="ja">
        {jp}
      </p>
      <h2 className={s.h2}>{title}</h2>
      {children ? <p className={s.lead}>{children}</p> : null}
    </div>
  );
}

/** Reveal on scroll: sections rise in once (off with reduced motion). */
function useReveal() {
  const reduced = useReducedMotion();
  useEffect(() => {
    if (reduced) return;
    const els = [...document.querySelectorAll<HTMLElement>(`.${s.reveal ?? "reveal"}`)];
    const io = new IntersectionObserver(
      (es) =>
        es.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add(s.shown ?? "");
            io.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px -10% 0px" },
    );
    document.documentElement.classList.add(s.revealing ?? "");
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [reduced]);
}

function CountUp({ to, prefix = "" }: { to: number; prefix?: string }) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLSpanElement>(null);
  const [v, setV] = useState(to);
  useEffect(() => {
    if (reduced || !ref.current) return;
    let raf = 0;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e?.isIntersecting) return;
        io.disconnect();
        const t0 = performance.now();
        const step = (t: number) => {
          const k = Math.min(1, (t - t0) / 900);
          setV(Math.round(to * (1 - Math.pow(1 - k, 3))));
          if (k < 1) raf = requestAnimationFrame(step);
        };
        setV(0);
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.6 },
    );
    io.observe(ref.current);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [to, reduced]);
  return (
    <span ref={ref}>
      {prefix}
      {v.toLocaleString("en-US")}
    </span>
  );
}

function QrCard() {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(pageUrl("aria"), {
      margin: 1,
      width: 240,
      color: { dark: "#2b2340", light: "#ffffff" },
    }).then(setSrc);
  }, []);
  return src ? <img src={src} alt="" width={84} height={84} className={s.qrImg} /> : <span className={s.qrImg} />;
}

// ---- page --------------------------------------------------------------------------------------------

export function Landing() {
  const { status } = useAccount();
  const hasAccount = status === "locked" || status === "unlocked";
  const hero = useMusubi("normal");
  const heroRef = useRef<HTMLButtonElement>(null);
  const [tour, setTour] = useState(0);
  const [menu, setMenu] = useState(false);
  useReveal();
  // Arriving after deleting a page (Settings > Data): say what happened, once, then tidy the address.
  const toast = useToast();
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get("left") !== "deleted") return;
    toast.show("Your page is deleted. What is on QoreChain stays.");
    q.delete("left");
    const rest = q.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }, [toast]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    addEventListener("keydown", close);
    return () => removeEventListener("keydown", close);
  }, [menu]);
  const t = TOUR[tour] ?? TOUR[0];

  return (
    <div className={s.page}>
      <a href="#main" className={s.skip}>
        Skip to content
      </a>

      {/* 1. Glass pill nav (a menu on narrow screens) */}
      <header className={s.nav}>
        <div className={s.bar}>
          <Wordmark size={22} href="/" />
          <nav className={s.links} aria-label="Product">
            {NAV.map(([href, label]) => (
              <a key={href} href={href}>
                {label}
              </a>
            ))}
          </nav>
          <div className={s.navRight}>
            {hasAccount ? (
              <Link className={s.navCta} href="/app">
                Open Mizuhiki
              </Link>
            ) : (
              <>
                <Link className={s.navLogin} href="/login">
                  Log in
                </Link>
                <Link className={s.navCta} href="/signup">
                  Sign up free
                </Link>
              </>
            )}
            <button
              type="button"
              className={s.menuBtn}
              aria-expanded={menu}
              aria-controls="landing-menu"
              aria-label={menu ? "Close menu" : "Open menu"}
              onClick={() => setMenu((m) => !m)}
            >
              <Icon name={menu ? "x" : "menu"} size={22} />
            </button>
          </div>
        </div>
        {menu ? (
          <nav id="landing-menu" className={s.menuPanel} aria-label="Menu">
            {NAV.map(([href, label]) => (
              <a key={href} href={href} onClick={() => setMenu(false)}>
                {label}
                <Icon name="chev" size={18} />
              </a>
            ))}
            {hasAccount ? null : (
              <Link className={s.menuLogin} href="/login" onClick={() => setMenu(false)}>
                Log in
              </Link>
            )}
          </nav>
        ) : null}
      </header>

      <main id="main">
        {/* 2-3. Hero with the claim box */}
        <section className={s.hero}>
          <Petals />
          <div className={s.tate} aria-hidden="true" lang="ja">
            秘密のリンク
          </div>
          <div className={s.sec}>
            <div className={s.heroCopy}>
              <p className={s.jp} lang="ja">
                ひとつのリンクで、ぜんぶ秘密に
              </p>
              <h1 className={s.h1}>
                One link for everything <span className={s.cord}>private.</span>
              </h1>
              <p className={s.lead}>
                Get paid, receive files, collect forms and sell from one page. Everything people send is sealed on their
                device before it leaves, so only you can open it.
              </p>
              <ClaimBox />
              <ul className={s.ticks}>
                <li>
                  <Icon name="check" size={18} />
                  Free on the test network
                </li>
                <li>
                  <Icon name="check" size={18} />
                  No account to send you files or forms
                </li>
                <li>
                  <Icon name="check" size={18} />
                  Keys never leave your device
                </li>
              </ul>
            </div>
            <div className={s.scene}>
              <Envelope className={s.env} />
              <Phone
                img={pageAria}
                alt="Aria Kapoor's Mizuhiki page: Pay Aria, Send a private file, Ask for an invoice"
                className={s.heroPhone}
                preload
              />
              <span className={s.say} aria-hidden="true">
                こんにちは! Tap me
              </span>
              <button
                ref={heroRef}
                type="button"
                className={s.mascot}
                aria-label="Musubi, the Mizuhiki mascot. Tap to say hello"
                onClick={() => {
                  hero.react("happy", 1400);
                  burstFrom(heroRef.current);
                }}
              >
                <Musubi face={hero.face} hopKey={hero.hopKey} watch bob size={180} />
              </button>
              <span className={s.hanko} aria-hidden="true" lang="ja">
                秘密
                <br />封
              </span>
            </div>
          </div>
        </section>

        {/* 4. Marquee */}
        <div className={s.marq} aria-label="Things people seal with Mizuhiki">
          <ul className={s.track}>
            {[...MARQUEE, ...MARQUEE].map(([k, w], i) => (
              <li key={`${w}-${i}`} aria-hidden={i >= MARQUEE.length ? true : undefined}>
                <i lang="ja">{k}</i>
                {w}
              </li>
            ))}
          </ul>
        </div>

        {/* 5. Twelve blocks */}
        <section className={s.cSec} id="features">
          <div className={[s.inner, s.reveal].join(" ")}>
            <Head jp="ぜんぶ、ひとつのページに" title="Twelve blocks. Sealed before anything leaves.">
              Everything a link in bio does, plus the private things it never could. Add the blocks you need; each one
              seals what people send before it leaves their device.
            </Head>
            <ul className={s.blockgrid}>
              {BLOCKS.map((b) => (
                <li key={b.title} className={s.bk}>
                  <span className={s.bkIc} style={{ background: b.bg, color: b.fg }}>
                    <Icon name={b.icon} size={22} />
                  </span>
                  <b>{b.title}</b>
                  <p>{b.body}</p>
                  <span className={[s.bkTag, b.pub ? s.bkPub : ""].join(" ")}>
                    <Icon name={b.icon === "chart" ? "eye" : "lock"} size={13} />
                    {b.tag}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 6. Build your page */}
        <section className={[s.band, s.sora].join(" ")} id="build">
          <div className={[s.sec, s.reveal].join(" ")}>
            <div className={s.vis} aria-hidden="true">
              <Phone img={pageRohan} alt="" className={s.buildPhone} />
              <div className={s.sheetShot}>
                <Image src={appAddBlock} alt="" sizes="(max-width: 560px) 70vw, 360px" placeholder="blur" />
              </div>
              <span className={s.badge}>
                <Icon name="lock" size={18} />
                Sealed on their device
              </span>
            </div>
            <div>
              <p className={s.jp} lang="ja">
                かんたん・すぐできる
              </p>
              <h2 className={s.h2}>Build your private page in minutes.</h2>
              <p className={s.lead}>
                Pick a look for your work, then add blocks: a file drop, a payment link, an intake form, a shop. Every
                block that takes something in seals it with your key first.
              </p>
              <Link className={s.bandBtn} href="/signup">
                Get started for free
              </Link>
            </div>
          </div>
        </section>

        {/* 7. How sealing works + Try it */}
        <section className={s.cSec} id="how">
          <div className={[s.inner, s.reveal].join(" ")}>
            <Head jp="むすびかた" title="How sealing works.">
              What people send is sealed on their device with your public key from QoreChain. Only your device holds the
              key that opens it.
            </Head>
            <ol className={s.steps}>
              {STEPS.map((st) => (
                <li key={st.n} className={s.st}>
                  <span className={s.stN}>{st.n}</span>
                  <b>{st.title}</b>
                  <p>{st.body}</p>
                  <span className={s.stJp} lang="ja">
                    {st.jp}
                  </span>
                </li>
              ))}
            </ol>
            <TrySeal />
          </div>
        </section>

        {/* 8. Why post-quantum now */}
        <section className={[s.cSec, s.joined].join(" ")} id="why">
          <div className={[s.inner, s.reveal].join(" ")}>
            <Head jp="いま、まもる" title="Why seal it for the quantum age now.">
              Contracts, medical results and family papers stay sensitive for decades. Anything recorded today can be
              opened the day a large quantum computer arrives, unless it was sealed with encryption built for that day.
            </Head>
            <ol className={s.pq}>
              <li>
                <span className={s.dot} lang="ja">
                  今
                </span>
                <b>Today</b>
                <p>
                  Someone copies encrypted files from a breach or a network. They can&rsquo;t read them yet, so they
                  store them.
                </p>
              </li>
              <li>
                <span className={s.dot} lang="ja">
                  待
                </span>
                <b>Years of waiting</b>
                <p>Storage is cheap. Old files that matter, like IDs and contracts, are worth keeping.</p>
              </li>
              <li>
                <span className={s.dot} lang="ja">
                  封
                </span>
                <b>Q-Day</b>
                <p>
                  Today&rsquo;s common encryption can be broken. Files sealed with ML-KEM-1024, the NIST 2024 standard
                  Mizuhiki uses, are built to stay shut.
                </p>
              </li>
            </ol>
            <div className={s.cmp}>
              <table>
                <caption className="sr-only">Who can open what people send you</caption>
                <thead>
                  <tr>
                    <th scope="col">Who can open it</th>
                    <th scope="col">Tools that keep the keys on their servers</th>
                    <th scope="col" className={s.us}>
                      Mizuhiki
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">The company running the service</th>
                    <td>Can, it holds the keys</td>
                    <td className={s.us}>
                      <span className={s.no}>Cannot</span>, it never has your key
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Someone who breaches the servers</th>
                    <td>Can, if the keys are taken too</td>
                    <td className={s.us}>
                      <span className={s.no}>Cannot</span>, only sealed copies are stored
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">A future quantum computer</th>
                    <td>Depends on the encryption used</td>
                    <td className={s.us}>
                      <span className={s.yes}>Built to resist</span> with ML-KEM-1024
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">A thief with today&rsquo;s signing keys</th>
                    <td>Can act as you</td>
                    <td className={s.us}>
                      <span className={s.no}>Cannot</span>, every change needs your post-quantum signature
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">You</th>
                    <td>Yes</td>
                    <td className={s.us}>
                      <span className={s.yes}>Yes</span>, on your own device
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* 9. Proof, joined to the comparison */}
        <section className={[s.cSec, s.joined].join(" ")} id="proof">
          <div className={[s.inner, s.reveal].join(" ")}>
            <Head jp="あかし" title="Built on QoreChain. Checked on the live test network.">
              Mizuhiki uses QoreChain&rsquo;s post-quantum key registry and signatures. These transactions are on the
              QoreChain test network now; each card reads its own from the chain as you look.
            </Head>
            <ProofCards />
            <p className={s.proofMore}>
              <Link href="/onchain">
                See every contract, key and signature, checked live <Icon name="arrow" size={14} />
              </Link>
            </p>
          </div>
        </section>

        {/* 10. Share it */}
        <section className={[s.band, s.matcha, s.rev].join(" ")}>
          <div className={[s.sec, s.reveal].join(" ")}>
            <div>
              <p className={s.jp} lang="ja">
                どこでもシェア
              </p>
              <h2 className={s.h2}>Share it wherever clients find you.</h2>
              <p className={s.lead}>
                Put your link in your bio, your email signature, your invoices and a QR code on your desk. People tap it
                and send you what you need, sealed, without making an account.
              </p>
              <a className={s.bandBtn} href="/@aria" target="_blank" rel="noreferrer">
                See an example page
              </a>
            </div>
            <div className={[s.vis, s.stack].join(" ")} aria-hidden="true">
              <div
                className={s.sc}
                style={{ left: "40%", top: "0%", background: "var(--wash-kinari)", color: "var(--kinari-ink)" }}
              >
                <span className={s.scTop}>
                  <span className={s.scAv}>AK</span>
                  <span>
                    <b>Email signature</b>
                    <small>{SITE_HOST}/@aria</small>
                  </span>
                </span>
                <Icon name="mail" size={28} className={s.scIc} />
              </div>
              <div
                className={s.sc}
                style={{ left: "31%", top: "13%", background: "var(--sakura)", color: "var(--sakura-ink)" }}
              >
                <span className={s.scTop}>
                  <span className={s.scAv}>AK</span>
                  <span>
                    <b>Instagram bio</b>
                    <small>Link in bio</small>
                  </span>
                </span>
                <Icon name="share" size={28} className={s.scIc} />
              </div>
              <div
                className={s.sc}
                style={{ left: "22%", top: "26%", background: "var(--white)", color: "var(--ink)" }}
              >
                <span className={s.scTop}>
                  <span className={s.scAv}>AK</span>
                  <span>
                    <b>QR on your desk</b>
                    <small>Scan to send files</small>
                  </span>
                </span>
                <QrCard />
                <Icon name="qr" size={28} className={s.scIc} />
              </div>
              <div
                className={s.sc}
                style={{ left: "13%", top: "39%", background: "var(--cord-fill)", color: "var(--white)" }}
              >
                <span className={s.scTop}>
                  <span className={s.scAv}>AK</span>
                  <span>
                    <b>On every invoice</b>
                    <small>Pay and reply privately</small>
                  </span>
                </span>
                <Icon name="coin" size={28} className={s.scIc} />
              </div>
              <span className={s.urlpill}>
                <Knot size={22} />
                <span>{SITE_HOST}/@aria</span>
              </span>
            </div>
          </div>
        </section>

        {/* 11. Owner app tour */}
        <section className={s.cSec} id="app">
          <div className={[s.inner, s.reveal].join(" ")}>
            <Head jp="あなたのへや" title="Your private desk, behind the page.">
              Everything people send lands in one inbox that only opens on your device. Rooms, capsules and passes live
              right beside it.
            </Head>
            <div className={s.tour}>
              <div className={s.tabs} role="tablist" aria-label="Owner app tour">
                {TOUR.map((x, i) => (
                  <button
                    key={x.key}
                    role="tab"
                    id={`tour-${x.key}`}
                    aria-selected={i === tour}
                    aria-controls="tour-panel"
                    tabIndex={i === tour ? 0 : -1}
                    onClick={() => setTour(i)}
                    onKeyDown={(e) => {
                      if (
                        e.key !== "ArrowDown" &&
                        e.key !== "ArrowUp" &&
                        e.key !== "ArrowRight" &&
                        e.key !== "ArrowLeft"
                      )
                        return;
                      e.preventDefault();
                      const n =
                        (i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : TOUR.length - 1)) % TOUR.length;
                      setTour(n);
                      document.getElementById(`tour-${TOUR[n]?.key ?? ""}`)?.focus();
                    }}
                  >
                    <Icon name={x.icon} size={22} />
                    <span>
                      {x.title}
                      <small>{x.sub}</small>
                    </span>
                  </button>
                ))}
              </div>
              <div className={s.screen} id="tour-panel" role="tabpanel" aria-labelledby={`tour-${t?.key ?? ""}`}>
                <div className={s.bar3} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <span>{SITE_HOST}/app</span>
                </div>
                {t ? (
                  <Image
                    key={t.key}
                    className={s.pane}
                    src={t.img}
                    alt={t.alt}
                    sizes="(max-width: 860px) 100vw, 900px"
                    placeholder="blur"
                  />
                ) : null}
              </div>
            </div>
            <p className={s.realNote}>
              <Icon name="info" size={14} /> Real screens from Mizuhiki on the QoreChain test network: the demo account
              @aria, with messages, a room, a pass and a capsule made through the app.
            </p>
          </div>
        </section>

        {/* 12. Insights bento */}
        <section className={[s.band, s.kinari].join(" ")}>
          <div className={[s.sec, s.reveal].join(" ")}>
            <div className={s.bento} aria-label="An example week in Insights">
              <div className={[s.t, s.t1].join(" ")}>
                <svg className={s.spark} viewBox="0 0 120 70" aria-hidden="true">
                  <g stroke="#8fb66d" strokeWidth="1">
                    <path d="M10 5V65M30 5V65M50 5V65M70 5V65M90 5V65M110 5V65" />
                  </g>
                  <path
                    d="M8 52 C24 10 34 62 50 40 S78 18 92 30 112 8 116 6"
                    fill="none"
                    stroke="#24461c"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
                <div>
                  <div className={s.num}>
                    <CountUp to={37} />
                  </div>
                  <div className={s.lab}>Sealed files this week</div>
                </div>
              </div>
              <div className={[s.t, s.t2].join(" ")}>
                <Icon name="form" size={34} />
                <div className={s.num}>
                  <CountUp to={14} />
                </div>
                <div className={s.lab}>Form answers</div>
              </div>
              <div className={[s.t, s.t3].join(" ")}>
                <Icon name="coin" size={34} />
                <div className={s.num}>
                  <CountUp to={1940} prefix="$" />
                </div>
                <div className={s.lab}>Paid to you</div>
              </div>
              <div className={[s.t, s.t4].join(" ")}>
                <Musubi face="normal" size={84} sticker={false} />
                <div className={s.t4Text}>
                  <div className={s.num}>0</div>
                  <div className={s.lab}>Items we can read</div>
                </div>
              </div>
              <p className={s.bentoNote}>An example week. The zero is always true.</p>
            </div>
            <div>
              <p className={s.jp} lang="ja">
                あなただけが読める
              </p>
              <h2 className={s.h2}>See what came in. We only see that something did.</h2>
              <p className={s.lead}>
                Visits, taps, payments and answers in one view. Counts are kept without reading content: the files,
                notes and answers open only on your device.
              </p>
              <Link className={s.bandBtn} href={hasAccount ? "/app/insights" : "/signup"}>
                {hasAccount ? "Open Insights" : "Start your page"}
              </Link>
            </div>
          </div>
        </section>

        {/* 13. Templates */}
        <section className={[s.grey, s.center].join(" ")} id="templates">
          <div className={[s.inner, s.reveal].join(" ")}>
            <p className={s.jp} lang="ja">
              ひながた
            </p>
            <h2 className={s.h2}>A private page for every kind of work.</h2>
            <p className={s.lead}>Real pages on the QoreChain test network. Open one and send it something.</p>
            <ul className={s.gal} aria-label="Example pages">
              {TEMPLATES.map((x) => (
                <li key={x.name} className={s.tp}>
                  <a href={`/@${x.name}`} target="_blank" rel="noreferrer">
                    <Phone img={x.img} alt={`@${x.name}`} className={s.galPhone} />
                    <b>{x.title}</b>
                    <small>
                      {x.sub} · @{x.name}
                    </small>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 14. What stays public */}
        <section className={[s.grey, s.center].join(" ")} id="security">
          <div className={[s.inner, s.reveal].join(" ")}>
            <p className={s.jp} lang="ja">
              おおやけ
            </p>
            <h2 className={s.h2}>We tell you what stays public first.</h2>
            <p className={s.lead}>
              Your page runs on QoreChain, a public blockchain built for post-quantum security. A few things are public
              so that it works. Here is exactly which.
            </p>
            <div className={s.limits}>
              <div className={[s.lim, s.limS].join(" ")}>
                <h3>
                  <Icon name="lock" size={28} />
                  Sealed for your readers
                </h3>
                <ul>
                  {[
                    "Messages, notes and files",
                    "Form answers and invoice details",
                    "Everything said in rooms",
                    "What is inside a capsule",
                  ].map((x) => (
                    <li key={x}>
                      <Icon name="check" size={20} />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
              <div className={[s.lim, s.limP].join(" ")}>
                <h3>
                  <Icon name="eye" size={28} />
                  Public on the chain
                </h3>
                <ul>
                  {[
                    "Payment amounts and addresses",
                    "That a room changed members",
                    "Your page name and public keys",
                    "Roughly how big a file was",
                  ].map((x) => (
                    <li key={x}>
                      <Icon name="check" size={20} />
                      {x}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* 15. FAQ, closing claim, footer */}
        <section className={[s.grey, s.center].join(" ")} id="faq">
          <div className={[s.inner, s.reveal].join(" ")}>
            <p className={s.jp} lang="ja">
              しつもん
            </p>
            <h2 className={s.h2}>Questions? Answered.</h2>
            <div className={s.faq}>
              {FAQ.map(([q, a]) => (
                <details key={q}>
                  <summary>
                    {q}
                    <Icon name="chev" size={24} />
                  </summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className={s.cta}>
          <div className={s.inner}>
            <Musubi face="happy" size={150} bob className={s.ctaMusubi} />
            <h2 className={s.h2}>Claim your private page today.</h2>
            <ClaimBox tone="cta" />
          </div>
        </section>
      </main>

      <footer className={s.foot}>
        <div className={s.inner}>
          <div className={s.footTop}>
            <div>
              <span className={s.footBrand}>
                <Knot size={30} color="#ff6b5e" hub="#fff" />
                mizuhiki
                <span lang="ja">水引</span>
              </span>
              <p className={s.footTag}>
                Mizuhiki are the paper cords tied around Japanese gifts. We tie what people send you the same way, on
                their device.
              </p>
            </div>
            <nav aria-label="Product links">
              <h3>Product</h3>
              <a href="#features">Features</a>
              <a href="#templates">Templates</a>
              <a href="/@aria">Example page</a>
              <Link href={hasAccount ? "/app" : "/login"}>Owner app</Link>
            </nav>
            <nav aria-label="Pages for">
              <h3>For</h3>
              <a href="/@aria">Freelancers</a>
              <a href="/@rohan.law">Lawyers</a>
              <a href="/@sunrise.clinic">Clinics</a>
              <a href="/@kapoor.family">Families</a>
            </nav>
            <nav aria-label="Security links">
              <h3>Security</h3>
              <a href="#security">What is public</a>
              <a href="#how">How sealing works</a>
              <Link href="/recover">Recover an account</Link>
              <Link href="/proof">Check a proof</Link>
              <Link href="/onchain">Proof on QoreChain</Link>
            </nav>
            <nav aria-label="Legal links">
              <h3>Legal</h3>
              <Link href="/legal/privacy">Privacy</Link>
              <Link href="/legal/terms">Terms</Link>
              <Link href="/legal/report">Report a page</Link>
            </nav>
          </div>
          <div className={s.footBot}>
            <span>© 2026 Mizuhiki · Runs on the QoreChain test network</span>
            <span>Built on QoreChain with QoreSeal and QoreSign</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
