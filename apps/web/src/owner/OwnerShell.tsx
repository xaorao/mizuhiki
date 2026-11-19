"use client";
/**
 * The owner app frame (Level 3 preview: pink side menu with pill items, the
 * setup checklist ring with Musubi peeking over it). Menu groups follow spec
 * 5.3; an area appears here once it is built, so no item leads nowhere.
 */
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button, Icon, Musubi, OfflineBanner, ProgressRing, Sheet, Wordmark, type IconName } from "@mizuhiki/ui";
import { useAccount } from "@/account/AccountProvider";
import { OwnerProvider, useOwner } from "./OwnerProvider";
import { checklistState } from "@/editor/checklist";
import { useOnline } from "@/lib/useOnline";
import s from "./owner.module.css";

const PHONE_TABS = ["/app", "/app/inbox", "/app/rooms", "/app/forms"];

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: number;
}
interface NavGroup {
  title?: string;
  items: NavItem[];
}

export function OwnerShell({ children }: { children: ReactNode }) {
  const acct = useAccount();
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (acct.status === "locked" || acct.status === "none" || acct.status === "elsewhere") {
      router.replace(`/login?next=${encodeURIComponent(path)}`);
    }
  }, [acct.status, path, router]);
  if (acct.status !== "unlocked" || !acct.account) {
    return (
      <div className={s.gate}>
        <Musubi face="sleepy" size={120} bob />
        <p>Opening your page…</p>
      </div>
    );
  }
  return (
    <OwnerProvider account={acct.account}>
      <Frame>{children}</Frame>
    </OwnerProvider>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const [more, setMore] = useState(false);
  const path = usePathname();
  const owner = useOwner();
  const acct = useAccount();
  const online = useOnline();
  const unread = Object.values(owner.stats?.items ?? {}).reduce((n, x) => n + x.unread, 0);
  const groups: NavGroup[] = [
    {
      title: "My page",
      items: [
        { href: "/app", label: "Blocks", icon: "home" },
        { href: "/app/design", label: "Design", icon: "palette" },
      ],
    },
    {
      title: "Received",
      items: [{ href: "/app/inbox", label: "Inbox", icon: "inbox" }],
    },
    {
      title: "Make",
      items: [
        { href: "/app/forms", label: "Forms", icon: "form" },
        { href: "/app/rooms", label: "Rooms", icon: "users" },
        { href: "/app/invoices", label: "Invoices", icon: "invoice" },
        { href: "/app/proof", label: "Proofs", icon: "check" },
      ],
    },
  ];
  const checklist = owner.draft ? checklistState(owner.draft, owner.stats) : null;
  const next = checklist?.items.find((i) => i.state === "todo");
  const active = (href: string) => (href === "/app" ? path === "/app" : path.startsWith(href));
  return (
    <div className={s.app}>
      <nav className={s.nav} aria-label="Owner sections">
        <div className={s.brand}>
          <Wordmark size={22} href="/app" />
        </div>
        {groups.map((g, i) => (
          <div key={i} className={s.group}>
            {g.title ? <h4>{g.title}</h4> : null}
            {g.items.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                className={s.navItem}
                aria-current={active(it.href) ? "page" : undefined}
              >
                <Icon name={it.icon} />
                <span>{it.label}</span>
                {it.href === "/app/inbox" && unread > 0 ? <span className={s.badge}>{unread}</span> : null}
              </Link>
            ))}
          </div>
        ))}
        {checklist ? (
          <Link href="/app#checklist" className={s.check}>
            <span className={s.checkMm}>
              <Musubi face={checklist.done === checklist.total ? "happy" : "normal"} size={64} />
            </span>
            <ProgressRing done={checklist.done} total={checklist.total} />
            <span>
              <b>Setup checklist</b>
              <small>{next ? `Next: ${next.title.toLowerCase()}` : "All done. おつかれさま"}</small>
            </span>
          </Link>
        ) : null}
        <Button variant="ghost" icon="lock" size="sm" onClick={acct.lock} className={s.lockBtn}>
          Lock now
        </Button>
      </nav>
      <div className={s.content}>
        {!online ? (
          <div className={s.offline}>
            <OfflineBanner />
          </div>
        ) : null}
        {children}
      </div>
      <nav className={s.tabbar} aria-label="Owner sections">
        {/* Phones: the four main places, then More (every section and Lock), so it never overflows. */}
        {groups
          .flatMap((g) => g.items)
          .filter((it) => PHONE_TABS.includes(it.href))
          .map((it) => (
            <Link key={it.href} href={it.href} className={s.tab} aria-current={active(it.href) ? "page" : undefined}>
              <Icon name={it.icon} />
              <span>{it.label}</span>
              {it.href === "/app/inbox" && unread > 0 ? <span className={s.tabBadge}>{unread}</span> : null}
            </Link>
          ))}
        <button
          type="button"
          className={s.tab}
          aria-current={
            groups.flatMap((g) => g.items).some((it) => !PHONE_TABS.includes(it.href) && active(it.href))
              ? "page"
              : undefined
          }
          onClick={() => setMore(true)}
        >
          <Icon name="menu" />
          <span>More</span>
        </button>
      </nav>
      <Sheet open={more} onClose={() => setMore(false)} title="Everything" history={false}>
        <nav className={s.moreNav} aria-label="All sections">
          {groups.map((g, i) => (
            <div key={i}>
              {g.title ? <h4>{g.title}</h4> : null}
              {g.items.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  className={s.moreItem}
                  aria-current={active(it.href) ? "page" : undefined}
                  onClick={() => setMore(false)}
                >
                  <Icon name={it.icon} />
                  {it.label}
                </Link>
              ))}
            </div>
          ))}
          <Button variant="line" icon="lock" full onClick={acct.lock}>
            Lock now
          </Button>
        </nav>
      </Sheet>
    </div>
  );
}
