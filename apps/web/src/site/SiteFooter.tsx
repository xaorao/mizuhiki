/** The small footer of Mizuhiki's own pages (legal, proof): where to go next, and nothing else. */
import Link from "next/link";
import s from "./site.module.css";

export function SiteFooter() {
  return (
    <footer className={s.foot}>
      <nav aria-label="Mizuhiki">
        <Link href="/">Home</Link>
        <Link href="/tour">Product tour</Link>
        <Link href="/onchain">Proof on QoreChain</Link>
        <Link href="/proof">Check a document</Link>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/report">Report a page</Link>
      </nav>
      <p lang="en">
        mizuhiki <span lang="ja">水引</span> · on the QoreChain test network
      </p>
    </footer>
  );
}
