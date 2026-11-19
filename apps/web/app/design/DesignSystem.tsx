"use client";
import { useState, type ReactNode } from "react";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";
import { Purpose, sealItem, openItem, utf8, fromUtf8 } from "@mizuhiki/core";
import {
  Avatar,
  Button,
  ButtonLink,
  ChoiceCard,
  Chip,
  CopyValue,
  EmptyState,
  Hanko,
  ICON_NAMES,
  Icon,
  IconButton,
  Kicker,
  Knot,
  LockLine,
  MUSUBI_FACES,
  Musubi,
  OfflineBanner,
  Oops,
  Panel,
  PhoneFrame,
  ProgressRing,
  Readers,
  Receipt,
  Row,
  SealDone,
  SealFailed,
  SealMoment,
  Segmented,
  Sheet,
  Skeleton,
  StatTile,
  StatusChip,
  Stepper,
  Switch,
  Tabs,
  TextArea,
  TextField,
  ToggleRow,
  TypeChip,
  Wordmark,
  useMusubi,
  useToast,
  type SealStep,
} from "@mizuhiki/ui";
import s from "./design.module.css";

function Section({ id, title, jp, children }: { id: string; title: string; jp: string; children: ReactNode }) {
  return (
    <section id={id} className={s.section} aria-labelledby={`${id}-h`}>
      <Kicker>{jp}</Kicker>
      <h2 id={`${id}-h`}>{title}</h2>
      <div className={s.sectionBody}>{children}</div>
    </section>
  );
}

const SWATCHES = [
  "cream",
  "paper",
  "white",
  "ink",
  "ink-muted",
  "ink-subtle",
  "cord",
  "cord-deep",
  "cord-text",
  "sakura",
  "sora",
  "matcha",
  "butter",
  "kinari",
  "fuji",
  "peach",
  "ok",
  "wait",
  "danger",
  "info",
];

type SealPhase = "idle" | "sealing" | "done" | "failed";

export function DesignSystem() {
  const toast = useToast();
  const mm = useMusubi("normal");
  const [sheet, setSheet] = useState(false);
  const [sw, setSw] = useState(true);
  const [seg, setSeg] = useState<"links" | "shop">("links");
  const [tab, setTab] = useState<"all" | "unread" | "archived">("all");
  const [goal, setGoal] = useState("creator");
  const [name, setName] = useState("aria");
  const [bio, setBio] = useState(
    "Brand designer in Pune. Contracts, invoices and client files come through here, sealed.",
  );
  const [phase, setPhase] = useState<SealPhase>("idle");
  const [steps, setSteps] = useState<SealStep[]>([]);
  const [progress, setProgress] = useState(0);
  const [hash, setHash] = useState("");
  const [themeContrast, setThemeContrast] = useState(false);

  const nameError =
    name.length > 0 && name.length < 3
      ? "Usernames must be 3 characters or longer"
      : /[^a-z0-9._-]/.test(name)
        ? "Use lowercase letters, numbers, dots, dashes or underscores"
        : undefined;

  async function runSeal(fail: boolean) {
    setPhase("sealing");
    const labels = [
      "Making a reader key on this device",
      "Sealing with ML-KEM-1024",
      "Checking it opens for its reader",
    ];
    const st: SealStep[] = labels.map((label) => ({ label, state: "waiting" }));
    const set = (i: number, state: SealStep["state"]) => {
      st[i] = { label: labels[i] ?? "", state };
      setSteps([...st]);
      setProgress((i + (state === "done" ? 1 : 0.5)) / labels.length);
    };
    const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    set(0, "running");
    await tick();
    const reader = generateSealKeys();
    set(0, "done");
    set(1, "running");
    await tick();
    const sealed = sealItem({
      purpose: Purpose.message,
      readers: [recipientOf(reader)],
      plaintext: utf8("Hi Aria, contract attached."),
    });
    set(1, "done");
    set(2, "running");
    await tick();
    if (fail) {
      set(2, "failed");
      setPhase("failed");
      return;
    }
    const back = fromUtf8(openItem({ purpose: Purpose.message, envelope: sealed.envelope, keys: reader }));
    if (back !== "Hi Aria, contract attached.") {
      set(2, "failed");
      setPhase("failed");
      return;
    }
    set(2, "done");
    setHash(sealed.hash);
    setPhase("done");
  }

  return (
    <div className={s.page} data-theme={themeContrast ? "contrast" : undefined}>
      <header className={s.top}>
        <Wordmark size={26} href="/" />
        <span className={s.topTitle}>Design system</span>
        <ToggleRow title="High-contrast theme" checked={themeContrast} onChange={setThemeContrast} />
      </header>
      <nav className={s.toc} aria-label="Sections">
        {[
          "colour",
          "type",
          "mascot",
          "buttons",
          "fields",
          "rows",
          "chips",
          "panels",
          "states",
          "sheet",
          "seal",
          "stepper",
          "icons",
        ].map((x) => (
          <a key={x} href={`#${x}`}>
            {x}
          </a>
        ))}
      </nav>
      <main className={s.main}>
        <Section id="colour" title="Colour" jp="いろ">
          <div className={s.swatches}>
            {SWATCHES.map((c) => (
              <div key={c} className={s.swatch}>
                <span style={{ background: `var(--${c})` }} />
                <code>--{c}</code>
              </div>
            ))}
          </div>
        </Section>

        <Section id="type" title="Type" jp="もじ">
          <p className="h-hero">One link for everything private.</p>
          <p className="h-section">Build your page</p>
          <p className="h-page">My page</p>
          <p className="h-card">Sealed for Aria</p>
          <p className="body-lg">
            Everything sent to a page is sealed on the sender&apos;s device. Mizuhiki cannot read it.
          </p>
          <p className="body">Addresses, payment amounts and timing are public on chain. Contents are not.</p>
          <p className="body-sm">Readers: you and @mila (accountant)</p>
          <p className="label">Label · 14 px round</p>
          <p className="jp-kicker" lang="ja">
            ひとつのリンクで、ぜんぶ秘密に
          </p>
          <p className="mono">7f3a 91c0 22be 0d14 · qor1szl40n4ty089rg9wcg0tgrhmeeyjeywjgr4y6c</p>
        </Section>

        <Section id="mascot" title="Musubi and the knot" jp="むすび">
          <div className={s.faces}>
            {MUSUBI_FACES.map((f) => (
              <figure key={f}>
                <Musubi face={f} size={120} />
                <figcaption>{f}</figcaption>
              </figure>
            ))}
          </div>
          <div className={s.row}>
            <button type="button" className={s.plain} onClick={() => mm.react("happy")} aria-label="Make Musubi happy">
              <Musubi face={mm.face} hopKey={mm.hopKey} watch bob size={150} />
            </button>
            <div className={s.stack}>
              <p className="body">Musubi watches the pointer, bobs, and reacts. Press it.</p>
              <div className={s.row}>
                <Button size="sm" onClick={() => mm.react("happy")}>
                  Happy
                </Button>
                <Button size="sm" onClick={() => mm.react("wink", 900)}>
                  Wink
                </Button>
                <Button size="sm" onClick={() => mm.react("worried")}>
                  Worried
                </Button>
                <Button size="sm" onClick={() => mm.react("sleepy", 2000, false)}>
                  Sleepy
                </Button>
              </div>
            </div>
            <Knot size={96} />
            <Knot size={96} tie tied />
            <Hanko>秘密</Hanko>
            <Hanko rotate={-6}>封</Hanko>
            <Wordmark size={32} />
          </div>
        </Section>

        <Section id="buttons" title="Buttons" jp="ボタン">
          <div className={s.row}>
            <Button variant="cord" icon="lock" size="lg">
              Seal and send
            </Button>
            <Button variant="line">Copy receipt</Button>
            <Button variant="quiet" icon="eye">
              View
            </Button>
            <Button variant="ink">Sign up free</Button>
            <Button variant="ghost">Skip</Button>
            <Button variant="danger" icon="trash">
              Delete forever
            </Button>
            <Button variant="cord" busy>
              Sealing
            </Button>
            <Button variant="line" disabled>
              Disabled
            </Button>
            <ButtonLink variant="cord" size="xl" href="#seal" iconRight="arrow">
              Claim your page
            </ButtonLink>
            <IconButton icon="share" label="Share page" />
            <IconButton icon="qr" label="Show QR code" variant="line" />
          </div>
        </Section>

        <Section id="fields" title="Fields and controls" jp="にゅうりょく">
          <div className={s.grid2}>
            <TextField
              label="Your page name"
              prefix="mizuhiki.me/@"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              error={nameError}
              ok={!nameError && name.length >= 3 ? "It's available" : undefined}
              hint="You can change it later."
              autoComplete="off"
            />
            <TextArea
              label="Bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              maxLength={160}
              counter
              hint="Public. Shown under your name."
            />
            <ToggleRow title="Sign it as me" detail="Off: Aria sees it as anonymous" checked={sw} onChange={setSw} />
            <div className={s.row}>
              <Switch checked={sw} onChange={setSw} label="Show this block" />
              <Switch checked={!sw} onChange={(v) => setSw(!v)} label="Small switch" size="sm" />
              <Segmented
                label="Page sections"
                value={seg}
                onChange={setSeg}
                options={[
                  { value: "links", label: "Links" },
                  { value: "shop", label: "Shop" },
                ]}
              />
            </div>
            <div className={s.stack} role="radiogroup" aria-label="Goal">
              <ChoiceCard
                selected={goal === "creator"}
                onSelect={() => setGoal("creator")}
                title="Creator"
                detail="Sell, get paid, take files"
                icon={<Icon name="sparkle" />}
                tone="sakura"
              />
              <ChoiceCard
                selected={goal === "business"}
                onSelect={() => setGoal("business")}
                title="Business"
                detail="Invoices, forms, client rooms"
                icon={<Icon name="bag" />}
                tone="sora"
              />
              <ChoiceCard
                selected={goal === "personal"}
                onSelect={() => setGoal("personal")}
                title="Personal"
                detail="Family capsules and a spare key"
                icon={<Icon name="heart" />}
                tone="matcha"
              />
            </div>
            <Tabs
              label="Inbox filter"
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "all", label: "All" },
                { value: "unread", label: "Unread", badge: 4 },
                { value: "archived", label: "Archived" },
              ]}
            />
          </div>
        </Section>

        <Section id="rows" title="Rows and the public page" jp="ページ">
          <div className={s.grid2}>
            <div className={s.stack}>
              <Row
                icon="coin"
                title="Pay Aria"
                detail="Any amount, with a note only she can read"
                tone="matcha"
                onClick={() => toast.show("Opens the pay sheet")}
              />
              <Row
                icon="mail"
                title="Send a private message or file"
                detail="Sealed on your device before it leaves"
                feature
                onClick={() => setSheet(true)}
              />
              <Row
                icon="pen"
                title="Apply for a design contract"
                detail="Form · takes about 2 minutes"
                tone="sora"
                onClick={() => toast.show("Opens the form")}
              />
              <Row
                icon="bag"
                title="Brand kit templates"
                detail="3 products · from $29"
                tone="butter"
                onClick={() => toast.show("Opens the shop")}
              />
              <Row
                icon="users"
                title="Join the client room"
                detail="By invitation · Aria approves each person"
                tone="fuji"
                onClick={() => toast.show("Opens the room request")}
              />
            </div>
            <PhoneFrame width={320}>
              <div
                className={`${s.cover ?? ""} seigaiha`}
                style={{ ["--a" as string]: "var(--sakura-wave)", ["--b" as string]: "var(--sakura-wave-2)" }}
              />
              <div className={s.pp}>
                <Avatar name="Aria Kapoor" lock size={96} />
                <h3>Aria Kapoor</h3>
                <p className="mono">@aria</p>
                <Chip icon="shield">Anything you send is sealed to Aria</Chip>
                <div className={s.stack} style={{ width: "100%", marginTop: 12 }}>
                  <Row icon="coin" title="Pay Aria" tone="matcha" onClick={() => undefined} />
                  <Row icon="mail" title="Send a private message" feature onClick={() => undefined} />
                </div>
              </div>
            </PhoneFrame>
          </div>
        </Section>

        <Section id="chips" title="Chips, status and readers" jp="ラベル">
          <div className={s.row}>
            <Chip icon="lock">Opens on this device only</Chip>
            <Chip tone="sora">Form</Chip>
            <TypeChip tone="matcha">Payment</TypeChip>
            <TypeChip>Message</TypeChip>
            <TypeChip tone="butter">Capsule</TypeChip>
            <StatusChip status="ok">Paid</StatusChip>
            <StatusChip status="wait">Due in 5 days</StatusChip>
            <StatusChip status="danger">Overdue</StatusChip>
            <StatusChip status="info">Sent</StatusChip>
            <StatusChip status="neutral">Draft</StatusChip>
          </div>
          <Readers readers={[{ label: "you" }, { label: "@mila", detail: "(accountant)" }]} />
          <Readers readers={[]} hidden />
          <LockLine>The note is sealed to Aria. The amount is public on chain.</LockLine>
          <CopyValue
            value="qor1szl40n4ty089rg9wcg0tgrhmeeyjeywjgr4y6c"
            label="address"
            onCopied={(ok) =>
              toast.show(ok ? "Address copied" : "Copy is not allowed here", { tone: ok ? "ok" : "error" })
            }
          />
        </Section>

        <Section id="panels" title="Panels and stats" jp="ダッシュボード">
          <div className={s.stats}>
            <StatTile label="Page visits · 7 days" value={1284} detail="+18% on last week" tone="sakura" />
            <StatTile label="Sealed items received" value={37} detail="12 files, 25 messages" tone="sora" />
            <StatTile
              label="Paid to you"
              value={1940}
              format={(n) => "$" + Math.round(n).toLocaleString("en-US")}
              detail="9 payments"
              tone="matcha"
            />
            <StatTile label="Form answers" value={14} detail="3 not opened" tone="butter" />
          </div>
          <div className={s.grid2}>
            <Panel
              title="Blocks on your page"
              kicker="ブロック"
              action={
                <Button size="sm" variant="cord" icon="plus">
                  Add
                </Button>
              }
            >
              <Skeleton avatar lines={2} />
              <Skeleton avatar lines={2} />
            </Panel>
            <Panel title="Setup checklist">
              <div className={s.row}>
                <ProgressRing done={4} total={6} />
                <div>
                  <b>4 of 6 complete</b>
                  <p className="body-sm">Next: save your spare-key sheet</p>
                </div>
              </div>
            </Panel>
          </div>
        </Section>

        <Section id="states" title="Empty, error and offline" jp="じょうたい">
          <div className={s.grid2}>
            <Panel title="Inbox">
              <EmptyState
                title="All caught up"
                jp="おつかれさま"
                action={
                  <Button variant="cord" icon="share">
                    Share your page
                  </Button>
                }
              >
                New sealed items will land here.
              </EmptyState>
            </Panel>
            <div className={s.stack}>
              <Oops title="Nothing to seal yet">Write a note or add a file. Nothing has left your device.</Oops>
              <Oops
                title="Not sent"
                action={
                  <Button size="sm" variant="cord">
                    Retry
                  </Button>
                }
              >
                Nothing left your device. QoreChain did not answer; check your connection.
              </Oops>
              <OfflineBanner queued={2} />
            </div>
          </div>
        </Section>

        <Section id="sheet" title="Sheet and toast" jp="シート">
          <div className={s.row}>
            <Button variant="cord" onClick={() => setSheet(true)}>
              Open a sheet
            </Button>
            <Button
              onClick={() =>
                toast.show("Link added", { action: { label: "Share", onClick: () => toast.show("Share sheet") } })
              }
            >
              Toast with action
            </Button>
            <Button
              onClick={() =>
                toast.show("Archived", { action: { label: "Undo", onClick: () => toast.show("Restored") } })
              }
            >
              Undo toast
            </Button>
            <Button onClick={() => toast.show("Copy is not allowed here", { tone: "error" })}>Error toast</Button>
          </div>
          <Sheet open={sheet} onClose={() => setSheet(false)} title="Send Aria something private">
            <div className={s.stack}>
              <Readers readers={[{ label: "Aria Kapoor @aria" }]} />
              <TextArea label="Message" hideLabel placeholder="Write something only Aria can read" />
              <LockLine>Sealed on this device before it is sent.</LockLine>
              <Button variant="cord" icon="lock" full size="lg" onClick={() => setSheet(false)}>
                Seal and send
              </Button>
            </div>
          </Sheet>
        </Section>

        <Section id="seal" title="The seal moment and the receipt" jp="ふういん">
          <p className="body">
            This runs real QoreSeal in your browser: a reader key is made, a message is sealed with ML-KEM-1024, then
            opened again to check it.
          </p>
          <div className={s.sealBox}>
            {phase === "idle" ? (
              <div className={s.row}>
                <Button variant="cord" icon="lock" size="lg" onClick={() => void runSeal(false)}>
                  Seal a test message
                </Button>
                <Button onClick={() => void runSeal(true)}>Show a failure</Button>
              </div>
            ) : phase === "sealing" ? (
              <SealMoment steps={steps} progress={progress} />
            ) : phase === "done" ? (
              <SealDone
                headline="Stored for Aria, sealed."
                onDone={() => setPhase("idle")}
                onCopy={() => toast.show("Receipt copied")}
                receipt={
                  <Receipt
                    title="Sealed for Aria"
                    when={new Date().toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    lines={[
                      { term: "What", value: "Private message" },
                      { term: "Readers", value: "Aria Kapoor @aria" },
                      { term: "Sender", value: "Anonymous" },
                      { term: "On chain", value: "Nothing" },
                    ]}
                    hash={hash}
                  />
                }
              />
            ) : (
              <SealFailed
                title="Not sent. Nothing left your device."
                detail="The check after sealing did not pass, so nothing was uploaded."
                onClose={() => setPhase("idle")}
                onRetry={() => void runSeal(false)}
              />
            )}
          </div>
        </Section>

        <Section id="stepper" title="Stepper" jp="ステップ">
          <Stepper
            steps={[
              { title: "Get test QOR", detail: "100 QOR from the faucet covers years of use", state: "done" },
              {
                title: "Register your post-quantum signing key",
                detail: "One time, about 0.03 test QOR",
                state: "done",
              },
              {
                title: "Publish your sealing key",
                state: "running",
                body: <p className="body-sm">Waiting for QoreChain to confirm…</p>,
              },
              { title: "Sign your recipient card", state: "waiting" },
              { title: "Claim @aria", state: "waiting" },
            ]}
          />
        </Section>

        <Section id="icons" title="Icons" jp="アイコン">
          <div className={s.icons}>
            {ICON_NAMES.map((n) => (
              <span key={n} title={n}>
                <Icon name={n} size={24} />
                <small>{n}</small>
              </span>
            ))}
          </div>
        </Section>
      </main>
    </div>
  );
}
