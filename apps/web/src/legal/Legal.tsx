"use client";
/**
 * Legal (spec 5.17): privacy, terms and reporting a page, in plain words that
 * match what the product does (ARCHITECTURE, THREAT_MODEL). No marketing.
 */
import { useState } from "react";
import Link from "next/link";
import { Kicker, LockLine, TextField, Wordmark } from "@mizuhiki/ui";
import { normalizeNameInput } from "@mizuhiki/core";
import { ReportBody } from "@/public/ReportBody";
import s from "./legal.module.css";

export type LegalDoc = "privacy" | "terms" | "report";

export function Legal({ doc }: { doc: LegalDoc }) {
  return (
    <div className={s.shell}>
      <header className={s.bar}>
        <Wordmark size={20} href="/" />
        <nav aria-label="Legal">
          <Link href="/legal/privacy" aria-current={doc === "privacy" ? "page" : undefined}>
            Privacy
          </Link>
          <Link href="/legal/terms" aria-current={doc === "terms" ? "page" : undefined}>
            Terms
          </Link>
          <Link href="/legal/report" aria-current={doc === "report" ? "page" : undefined}>
            Report a page
          </Link>
        </nav>
      </header>
      <main className={s.card}>{doc === "privacy" ? <Privacy /> : doc === "terms" ? <Terms /> : <Report />}</main>
    </div>
  );
}

function Privacy() {
  return (
    <article className={s.doc}>
      <Kicker>プライバシー</Kicker>
      <h1>Privacy</h1>
      <p className={s.lead}>
        Mizuhiki is built so that we cannot read what people send you. Here is exactly what we can and cannot see.
      </p>
      <h2>What we cannot see</h2>
      <ul>
        <li>
          The contents of messages, files, payment notes, form answers, invoices, room messages, product content,
          capsules and pass copies. They are sealed in the sender&rsquo;s browser to your post-quantum key before they
          reach us.
        </li>
        <li>Your 24-word recovery phrase and your keys. They exist only on your devices.</li>
        <li>Your spare-key pieces and offline reader key. Contacts hold pieces sealed to their own keys.</li>
      </ul>
      <h2>What we can see</h2>
      <ul>
        <li>Your public page, which anyone can see.</li>
        <li>
          That a sealed item arrived for you, when, how big it is, and what kind it is. Not who sent it, unless the
          sender chose to sign.
        </li>
        <li>Who is in a room, who holds a pass or guards a capsule, and who your recovery contacts are.</li>
        <li>Counts of page views and block taps per day, without IP addresses or cookies.</li>
        <li>Requests to our server briefly, to stop abuse (rate limits keyed to an account or a network address).</li>
      </ul>
      <h2>What is public on QoreChain</h2>
      <p>
        Your names, your public keys, payments to you and their amounts, proof anchors, room key changes and capsule
        states are recorded on QoreChain. Anyone can read them, and nobody, including us, can remove them.
      </p>
      <h2>Notifications</h2>
      <p>
        If you turn them on, a notification says only what kind of thing happened. It is encrypted to your browser and
        passes through your browser maker&rsquo;s push service. We do not offer email notifications.
      </p>
      <h2>Deleting</h2>
      <p>Settings › Data › Delete my page removes everything we store for you. What is on QoreChain stays.</p>
      <h2>The limit we cannot remove</h2>
      <p>
        Mizuhiki runs in your browser. If our server were taken over and served changed code, that code could misbehave.
        We publish each release, load no third-party scripts, and say this plainly so you can decide.
      </p>
      <LockLine>Mizuhiki runs on QoreChain testnet. Test tokens have no value.</LockLine>
    </article>
  );
}

function Terms() {
  return (
    <article className={s.doc}>
      <Kicker>きやく</Kicker>
      <h1>Terms of use</h1>
      <p className={s.lead}>Short and plain. By using Mizuhiki you agree to these.</p>
      <h2>Your keys are yours</h2>
      <p>
        Only you hold your recovery phrase. We cannot reset it or open your items for you. Keep your spare-key sheet
        safe, and set up recovery contacts if you want a way back.
      </p>
      <h2>Testnet</h2>
      <p>
        Mizuhiki runs on QoreChain testnet. Test tokens such as fUSD and test QOR have no value, and the network may be
        reset by its operators.
      </p>
      <h2>What you may not do</h2>
      <ul>
        <li>Pretend to be someone else, or use a name to mislead.</li>
        <li>Use your page for scams, threats, harassment or anything illegal where you or your visitors are.</li>
        <li>Try to break the service, overload it, or get around its limits.</li>
      </ul>
      <h2>What we may do</h2>
      <p>
        We may take down a public page that breaks these terms. We cannot open sealed items, so we judge only what is
        public. Names and records on QoreChain are outside our control.
      </p>
      <h2>No warranty</h2>
      <p>
        Mizuhiki is provided as it is, while it is being built. We do our best to keep it working and your data sealed,
        but we cannot promise it will always be available.
      </p>
    </article>
  );
}

function Report() {
  const [who, setWho] = useState("");
  const [sent, setSent] = useState(false);
  const name = normalizeNameInput(who);
  return (
    <article className={s.doc}>
      <Kicker>つうほう</Kicker>
      <h1>Report a page</h1>
      <p className={s.lead}>
        Tell us about a page that impersonates someone, scams people or is abusive. Every public page also has
        &ldquo;Report this page&rdquo; at its foot.
      </p>
      {sent ? (
        <p className={s.done}>Thank you. We will look at @{name}.</p>
      ) : (
        <>
          <TextField
            label="The page's @name"
            prefix="@"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          {/* The whole form shows from the start; Send stays off until a name and a reason are given. */}
          <ReportBody name={name.length >= 3 ? name : ""} onDone={() => setSent(true)} />
        </>
      )}
    </article>
  );
}
