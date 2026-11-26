/**
 * The proof deck: every feature of Mizuhiki, screen by screen, for anyone who cannot watch the demo video. Each
 * screen was captured from the running product on QoreChain testnet by tests/e2e/demo/tour-shots.spec.ts; the
 * payments it shows settled on chain and link to their transactions.
 */
import Image, { type StaticImageData } from "next/image";
import Link from "next/link";
import { ButtonLink, Icon, Kicker, LockLine, Musubi, Wordmark } from "@mizuhiki/ui";
import { explorerAddress, explorerTx } from "@mizuhiki/chain";
import { SiteFooter } from "@/site/SiteFooter";
import s from "./tour.module.css";

import pagePhone from "./shots/page-phone.webp";
import message1 from "./shots/message-1-write.webp";
import message2 from "./shots/message-2-who.webp";
import message3 from "./shots/message-3-sealed.webp";
import message4 from "./shots/message-4-opened.webp";
import pay1 from "./shots/pay-1-amount.webp";
import pay2 from "./shots/pay-2-review.webp";
import pay3 from "./shots/pay-3-paid.webp";
import shop1 from "./shots/shop-1-tab.webp";
import shop2 from "./shots/shop-2-product.webp";
import shop3 from "./shots/shop-3-checkout.webp";
import shop4 from "./shots/shop-4-waiting.webp";
import shop5 from "./shots/shop-5-sales.webp";
import shop6 from "./shots/shop-6-opened.webp";
import invoice1 from "./shots/invoice-1-list.webp";
import invoice2 from "./shots/invoice-2-inbox.webp";
import invoice3 from "./shots/invoice-3-invoice.webp";
import invoice5 from "./shots/invoice-5-paid.webp";
import form1 from "./shots/form-1-question.webp";
import form2 from "./shots/form-2-answer.webp";
import form3 from "./shots/form-3-sent.webp";
import form4 from "./shots/form-4-results.webp";
import request1 from "./shots/request-1-upload.webp";
import request2 from "./shots/request-2-sealed.webp";
import request3 from "./shots/request-3-received.webp";
import room1 from "./shots/room-1-chat.webp";
import pass1 from "./shots/pass-1-detail.webp";
import pass2 from "./shots/pass-2-accountant.webp";
import capsule1 from "./shots/capsule-1-detail.webp";
import capsule2 from "./shots/capsule-2-guardian.webp";
import proof1 from "./shots/proof-1-list.webp";
import proof2 from "./shots/proof-2-check.webp";
import signup1 from "./shots/signup-1-name.webp";
import signup2 from "./shots/signup-2-look.webp";
import signup3 from "./shots/signup-3-key.webp";
import signup4 from "./shots/signup-4-onchain.webp";
import signup5 from "./shots/signup-5-live.webp";
import app1 from "./shots/app-1-blocks.webp";
import app2 from "./shots/app-2-design.webp";
import app3 from "./shots/app-3-insights.webp";
import app4 from "./shots/app-4-spare-key.webp";
import recover1 from "./shots/recover-1.webp";
import chain1 from "./shots/chain-1-contracts.webp";
import chain2 from "./shots/chain-2-keys.webp";
import chain3 from "./shots/chain-3-signatures.webp";
import chain4 from "./shots/chain-4-drill.webp";

interface Shot {
  img: StaticImageData;
  title: string;
  text: string;
  /** A transaction or account on the explorer that this screen produced. */
  proof?: { label: string; href: string };
  /** wide: a whole screen, full width. half: two to a row. dialog and phone: a narrow crop, three to a row. */
  size?: "wide" | "half" | "dialog" | "phone";
}
interface Chapter {
  id: string;
  jp: string;
  title: string;
  lead: string;
  shots: Shot[];
}

const ARIA = "qor1nvcuhyqlyghsll7d0hdqx8qxmk3qqxlqka0r6v";

const CHAPTERS: Chapter[] = [
  {
    id: "page",
    jp: "ページ",
    title: "One page, checked before it is shown",
    lead: "Aria Kapoor is a brand designer. Her clients reach her through one link. Before the page appears, the visitor's browser reads from QoreChain who holds @aria and which keys she registered, and checks the page's ML-DSA-87 signature against them.",
    shots: [
      {
        img: pagePhone,
        size: "phone",
        title: "Aria's page",
        text: "Payments, a private file drop, invoices, a shop and a client intake form, each marked as sealed to her. Most clients open it on a phone.",
      },
    ],
  },
  {
    id: "message",
    jp: "ふう",
    title: "Send something private",
    lead: "A visitor with no account writes a message and attaches a file. Both are sealed in their browser with ML-KEM-1024 to Aria's key before anything is uploaded.",
    shots: [
      {
        img: message1,
        size: "dialog",
        title: "Write and attach",
        text: "The readers line names who can open it: Aria, and nobody else.",
      },
      {
        img: message2,
        size: "dialog",
        title: "Stay anonymous, or not",
        text: "The sender chooses what Aria sees. Their contact line is sealed with the message.",
      },
      {
        img: message3,
        size: "dialog",
        title: "A seal receipt",
        text: "What was sealed, for whom, and that nothing readable went on chain. The fingerprint proves it later.",
      },
      {
        img: message4,
        title: "Aria opens it on her device",
        text: "The server only ever held ciphertext. The file can be proved to have existed, without revealing it.",
      },
    ],
  },
  {
    id: "pay",
    jp: "しはらい",
    title: "Get paid, with a note only you can read",
    lead: "Her client Leaf & Kettle Tea pays a rush fee in test dollars (fUSD) from their own Mizuhiki wallet. The amount is public on chain; the note is sealed to Aria.",
    shots: [
      {
        img: pay1,
        size: "dialog",
        title: "Amount and a private note",
        text: "The sheet says plainly what is public (amount and addresses) and what is not (the note).",
      },
      {
        img: pay2,
        size: "dialog",
        title: "Review before signing",
        text: "The network fee, the full address and a reference that ties the payment to its sealed note.",
      },
      {
        img: pay3,
        size: "dialog",
        title: "Paid, on chain",
        text: "The receipt carries the block and the transaction, signed with the client's ML-DSA-87 key.",
        proof: {
          label: "Payment on the explorer",
          href: explorerTx("7852791672A1AF35E06D2F74F8D3DCBFCEB255F3497817DBF3AD6D8182D79288"),
        },
      },
    ],
  },
  {
    id: "shop",
    jp: "おみせ",
    title: "Sell a file, sealed to each buyer",
    lead: "Aria sells a brand starter kit. Each buyer gets their own sealed copy, and Mizuhiki never holds a key that opens it: her own device seals the product key to the buyer once the payment is on chain.",
    shots: [
      { img: shop1, size: "dialog", title: "Her shop", text: "Products sit on the same page, under Shop." },
      {
        img: shop2,
        title: "The product",
        text: "Signed by Aria and checked on QoreChain, with what is sealed and what is public spelled out.",
      },
      {
        img: shop3,
        title: "Checkout",
        text: "The buyer picks who opens it (their account, a 12-word buyer key, or a gift) and how to pay.",
      },
      {
        img: shop4,
        title: "Paid, waiting for the seller's device",
        text: "Each step shows its own transaction. The buyer can close the page; it lands in their library.",
        proof: {
          label: "Order payment on the explorer",
          href: explorerTx("426B6D5C5A0F7BA8AA2A7546097783E098B44F6FDCEEF9D16FBED86CDA9FDB94"),
        },
      },
      {
        img: shop5,
        title: "Aria's sales list",
        text: "Her open dashboard checked the payment on chain and sealed the key to @leaf.kettle.",
      },
      {
        img: shop6,
        title: "The buyer opens it",
        text: "Unsealed in the buyer's browser. Reviews are posted as a verified buyer, without a name.",
      },
    ],
  },
  {
    id: "invoice",
    jp: "せいきゅう",
    title: "Invoice a client",
    lead: "Line items are sealed to Aria and her client. The invoice reaches the client's inbox, signed; they pay it from there, and it turns paid from the chain, not from anyone's say-so.",
    shots: [
      { img: invoice1, title: "Aria's invoices", text: "Due on receipt, so it shows as overdue until paid." },
      {
        img: invoice2,
        title: "In the client's inbox",
        text: "Verified as from @aria: signed with her post-quantum key, checked against QoreChain on the client's device.",
      },
      {
        img: invoice3,
        title: "The invoice",
        text: "Opened in the client's browser with the link's key. Mizuhiki cannot read it. The client pays it from here with their Mizuhiki wallet.",
      },
      {
        img: invoice5,
        title: "Marked paid from the chain",
        text: "108 fUSD, with the invoice reference in the payment memo. Aria's list updates by itself once the payment is on QoreChain.",
        proof: {
          label: "Invoice payment on the explorer",
          href: explorerTx("F448E6DDBFA653DD29A8E3B64A359A7310350AE41DE5C7FC3DADC86E4FBF4E0C"),
        },
      },
    ],
  },
  {
    id: "forms",
    jp: "フォーム",
    title: "Forms and file requests",
    lead: "Answers and uploads are sealed in the respondent's browser. The server counts views and submissions without reading a word.",
    shots: [
      {
        img: form1,
        size: "half",
        title: "One question at a time",
        text: "A client intake form, made from a template.",
      },
      { img: form2, size: "half", title: "Choices", text: "Keyboard letters, multiple answers, a progress bar." },
      { img: form3, size: "half", title: "Sent, sealed", text: "Only the form's readers can open the answers." },
      {
        img: form4,
        title: "Results on Aria's device",
        text: "Views, completion and drop-off are counted without reading answers; the answers open here.",
      },
      {
        img: request1,
        size: "dialog",
        title: "A file request",
        text: "The client uploads the signed contract and brand photos, named or anonymous.",
      },
      { img: request2, size: "dialog", title: "Sealed for Aria", text: "Two files, one receipt." },
      { img: request3, title: "Received", text: "Each upload, its size and who sent it, opened on Aria's device." },
    ],
  },
  {
    id: "access",
    jp: "あいかぎ",
    title: "Rooms, passes and capsules",
    lead: "Sharing over time: a group room whose key changes when someone leaves, a pass that lets an accountant read one quarter, and a capsule that opens for family if Aria goes quiet.",
    shots: [
      {
        img: room1,
        title: "A room",
        text: "Messages and files sealed to its members. The key changes when someone leaves; the chain records each change.",
      },
      {
        img: pass1,
        title: "A pass for the accountant",
        text: "Messages, payment notes and invoices for Q4 2026, read-only. Both sides checked the same safety words.",
      },
      {
        img: pass2,
        title: "What the accountant sees",
        text: "Exactly what the pass covers, sealed to them, and nothing else.",
      },
      {
        img: capsule1,
        title: "A capsule for the family",
        text: "If Aria does not check in for 12 months, @kapoor.family can open it. Set on QoreChain; Mizuhiki cannot open it early.",
      },
      {
        img: capsule2,
        title: "The guardian's view",
        text: "@rohan.law holds a sealed piece of the key. Alone it opens nothing.",
      },
    ],
  },
  {
    id: "proof",
    jp: "あかし",
    title: "Prove a document existed",
    lead: "Only a document's fingerprint goes on chain, signed by the account that anchored it. Anyone can check a file against it later.",
    shots: [
      { img: proof1, title: "Aria's anchors", text: "The signed contract, anchored without uploading it." },
      {
        img: proof2,
        title: "Anyone can check",
        text: "Drop the file: the fingerprint is worked out in the browser and read back from QoreChain.",
      },
    ],
  },
  {
    id: "account",
    jp: "アカウント",
    title: "Signing up, and the owner's app",
    lead: "A new florist signs up. There is no faucet to visit: Mizuhiki sends the test QOR for the setup fees, then the browser registers her ML-DSA-87 and ML-KEM-1024 keys and claims her name.",
    shots: [
      { img: signup1, title: "Pick a name", text: "Checked against QoreChain as it is typed." },
      { img: signup2, title: "Pick a look", text: "The live preview updates with every choice." },
      {
        img: signup3,
        title: "Her key",
        text: "24 words, shown once, on this device. A spare-key sheet can be saved as a PDF.",
      },
      {
        img: signup4,
        title: "On chain, step by step",
        text: "Each step is a real transaction on testnet; finished steps are never repeated.",
        proof: {
          label: "Starter test QOR on the explorer",
          href: explorerTx("C7303B636A8F7ABBBED6A78227352D26CDE4E7EA3B40FA637CD273735C5291DF"),
        },
      },
      { img: signup5, title: "Her page is live", text: "Under a minute of on-chain setup." },
      {
        img: app1,
        title: "Aria's blocks",
        text: "Her page as she edits it, with what came in this week and a setup checklist.",
      },
      { img: app2, title: "Design", text: "Header, photo, theme and font, with a live preview." },
      {
        img: app3,
        title: "Insights",
        text: "Visits, sealed items and money received, counted without cookies or reading anything sealed.",
      },
      {
        img: app4,
        title: "Spare key",
        text: "The sheet, and recovery contacts who each hold one sealed piece of her phrase.",
      },
      {
        img: recover1,
        title: "Recovery",
        text: "Enough contacts can bring an account back to a new device, after a 48-hour wait a stranger cannot hide.",
      },
    ],
  },
  {
    id: "chain",
    jp: "チェーン",
    title: "Read it from QoreChain yourself",
    lead: "The proof page reads every number below from the test network in the visitor's browser. These are its sections; the live page is one click away.",
    shots: [
      {
        img: chain1,
        title: "Our contracts",
        text: "Three contracts with no funds and no admin key. Every write carries the account's ML-DSA-87 signature.",
      },
      {
        img: chain2,
        title: "Aria's keys",
        text: "Her ML-DSA-87 signing key (registered with proof of possession) and her ML-KEM-1024 sealing key.",
        proof: { label: "@aria's account on the explorer", href: explorerAddress(ARIA) },
      },
      {
        img: chain3,
        title: "Signatures you can check",
        text: "The exact committed bytes of four transactions, verified in the browser against her registered key.",
      },
      {
        img: chain4,
        title: "A stolen classical key cannot act",
        text: "The Q-Day Drill rehearsal: 16 attacks with only the classical key, all refused by the chain or the contracts.",
      },
    ],
  },
];

const SHOT_COUNT = CHAPTERS.reduce((n, c) => n + c.shots.length, 0);

export function Tour() {
  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <Wordmark size={20} href="/" />
        <nav aria-label="Proof">
          <Link href="/onchain">Proof on QoreChain</Link>
          <Link href="/@aria">Aria&rsquo;s page</Link>
          <Link href="/signup">Sign up free</Link>
        </nav>
      </header>
      <main className={s.main}>
        <div className={s.hero}>
          <span className={s.heroMm}>
            <Musubi face="happy" size={96} bob />
          </span>
          <Kicker>ツアー</Kicker>
          <h1>Every feature, screen by screen</h1>
          <p className={s.lead}>
            For anyone who cannot watch the demo: {SHOT_COUNT} screens of Mizuhiki doing real work. Aria, a brand
            designer, runs her studio through one private link; her client Leaf &amp; Kettle Tea messages, pays, buys
            and settles an invoice through it.
          </p>
          <p className={s.lead}>
            Every screen was captured from the running product on the QoreChain test network by a script in the
            repository. Nothing is mocked: the payments settled on chain, and each links to its transaction.
          </p>
          <LockLine>Testnet: no real money is involved.</LockLine>
        </div>

        <nav className={s.toc} aria-label="Chapters">
          {CHAPTERS.map((c, i) => (
            <a key={c.id} href={`#${c.id}`}>
              <span aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
              {c.title}
            </a>
          ))}
        </nav>

        {CHAPTERS.map((c, i) => (
          <section key={c.id} id={c.id} className={s.chapter} aria-labelledby={`${c.id}-h`}>
            <div className={s.chapterHead}>
              <Kicker>{c.jp}</Kicker>
              <h2 id={`${c.id}-h`}>
                <span className={s.num} aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                {c.title}
              </h2>
              <p className={s.lead}>{c.lead}</p>
            </div>
            <ol className={s.shots}>
              {c.shots.map((x, j) => (
                <li key={x.title} className={s[x.size ?? "wide"]}>
                  <figure>
                    <a
                      href={x.img.src}
                      target="_blank"
                      rel="noopener"
                      className={s.frame}
                      aria-label={`${x.title}, full size`}
                    >
                      <Image
                        src={x.img}
                        alt={`${x.title}. ${x.text}`}
                        sizes={
                          x.size === "wide" || !x.size
                            ? "(max-width: 720px) 100vw, 1120px"
                            : "(max-width: 720px) 90vw, 360px"
                        }
                        placeholder="blur"
                      />
                    </a>
                    <figcaption>
                      <b>
                        <span className={s.step}>{j + 1}</span>
                        {x.title}
                      </b>
                      <span>{x.text}</span>
                      {x.proof ? (
                        <a href={x.proof.href} target="_blank" rel="noopener noreferrer" className={s.proof}>
                          <Icon name="check" size={14} /> {x.proof.label}
                        </a>
                      ) : null}
                    </figcaption>
                  </figure>
                </li>
              ))}
            </ol>
          </section>
        ))}

        <section className={s.end}>
          <h2>See it for yourself</h2>
          <p className={s.lead}>
            The proof page reads the same contracts, keys and signatures from QoreChain as you look. Or make your own
            page in about two minutes; it is free on the test network.
          </p>
          <div className={s.endLinks}>
            <ButtonLink variant="cord" href="/onchain" iconRight="arrow">
              Proof on QoreChain
            </ButtonLink>
            <ButtonLink variant="line" href="/signup">
              Make your page
            </ButtonLink>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
