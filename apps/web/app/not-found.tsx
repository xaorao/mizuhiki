import Link from "next/link";
import { Musubi } from "@mizuhiki/ui";
import s from "@/landing/notfound.module.css";

export default function NotFound() {
  return (
    <main className={s.wrap}>
      <Musubi face="worried" size={150} bob />
      <p className={s.jp} lang="ja">
        あれ？
      </p>
      <h1 className={s.title}>Nothing lives at this address.</h1>
      <p className={s.sub}>The link may be mistyped, or the page was moved or deleted. Nothing was sent anywhere.</p>
      <div className={s.row}>
        <Link className={s.cord} href="/">
          Go to Mizuhiki
        </Link>
        <Link className={s.line} href="/signup">
          Claim a page
        </Link>
      </div>
    </main>
  );
}
