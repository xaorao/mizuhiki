"use client";
/**
 * Sign-up and identity (spec 5.2). Linktree's onboarding order without the plan
 * and trial screens: name, goal, template, blocks, profile; then the key (shown
 * once, retyped, wrapped by a device passphrase), the real on-chain setup, and
 * a calm "Your page is live".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ChoiceCard,
  CopyValue,
  Icon,
  Kicker,
  LockLine,
  Musubi,
  Oops,
  PhoneFrame,
  Stepper,
  TextArea,
  TextField,
  Wordmark,
  burstFrom,
  useMusubi,
  useToast,
  type StepItem,
} from "@mizuhiki/ui";
import {
  deriveAccount,
  newPhrase,
  nameProblem,
  normalizeNameInput,
  passphraseProblem,
  phraseWords,
  pickCheckPositions,
} from "@mizuhiki/core";
import { DENOMS, NETWORK, explorerTx, fromBaseUnits, isChainError } from "@mizuhiki/chain";
import { useAccount } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { idb } from "@/lib/idb";
import { passkeysPossible } from "@/lib/passkey";
import { buildSpareKeySheet, downloadBytes } from "@/lib/sparekey";
import { SITE_HOST, pageUrl } from "@/lib/site";
import { PageView } from "@/page/PageView";
import { AvatarCrop } from "./AvatarCrop";
import {
  GOAL_PICKS,
  PICKS,
  TEMPLATES,
  emptyDraft,
  firstManifest,
  type Draft,
  type Goal,
  type BlockPick,
} from "./model";
import { MIN_SETUP_UQOR, SETUP_STEPS, runSetup, type SetupStep } from "./setup";
import { draftFromManifest, saveDraft } from "@/editor/state";
import s from "./onboarding.module.css";
import { failureText } from "@/lib/failure";

type Step = "name" | "goal" | "template" | "blocks" | "profile" | "phrase" | "check" | "passphrase" | "ready" | "done";
const ORDER: Step[] = [
  "name",
  "goal",
  "template",
  "blocks",
  "profile",
  "phrase",
  "check",
  "passphrase",
  "ready",
  "done",
];
const DRAFT_KEY = "onboarding-draft";
const SKIPPABLE: Step[] = ["template", "blocks", "profile"];

interface Availability {
  name: string;
  available: boolean;
  message: string;
  suggestions?: string[];
}

/** `next`: where "Done" goes instead of the dashboard (an invite link the person came from). */
export function Onboarding({ initialName, next: after }: { initialName: string; next?: string | undefined }) {
  const router = useRouter();
  const toast = useToast();
  const acct = useAccount();
  const [step, setStep] = useState<Step>("name");
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(normalizeNameInput(initialName)));
  const [phrase, setPhrase] = useState("");
  const loaded = useRef(false);

  // Restore the public choices (never the phrase) after a reload.
  useEffect(() => {
    void idb
      .get<Draft>(DRAFT_KEY)
      .then((d) => {
        if (d && !initialName) setDraft(d);
        else if (d && initialName) setDraft({ ...d, name: normalizeNameInput(initialName) });
      })
      .catch(() => undefined)
      .finally(() => {
        loaded.current = true;
      });
  }, [initialName]);
  useEffect(() => {
    if (loaded.current) void idb.set(DRAFT_KEY, draft).catch(() => undefined);
  }, [draft]);

  // An account that is already set up on this device skips straight to the ready step.
  useEffect(() => {
    if (acct.status === "unlocked" && (step === "name" || step === "goal") && acct.vault && phrase === "") {
      setStep("ready");
    }
  }, [acct.status, acct.vault, step, phrase]);

  const go = useCallback((next: Step) => {
    setStep(next);
    window.history.pushState({ mzStep: next }, "");
    window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    const pop = (e: PopStateEvent) => {
      const st = (e.state as { mzStep?: Step } | null)?.mzStep;
      // Never go back into the phrase screens once the vault exists.
      if (st && !(acct.vault && ORDER.indexOf(st) < ORDER.indexOf("ready"))) setStep(st);
    };
    addEventListener("popstate", pop);
    window.history.replaceState({ mzStep: "name" }, "");
    return () => removeEventListener("popstate", pop);
  }, [acct.vault]);

  const next = () => {
    const i = ORDER.indexOf(step);
    const n = ORDER[i + 1];
    if (n) go(n);
  };
  const back = () => window.history.back();
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const progress = (ORDER.indexOf(step) + 1) / ORDER.length;
  // Musubi reacts to the step: covers its eyes while the secret words are on screen.
  const face = step === "phrase" || step === "check" ? "cover" : step === "done" ? "happy" : "normal";
  const mm = useMusubi(face);
  const { set: setFace, react } = mm;
  useEffect(() => setFace(face), [face, setFace]);
  const picks = draft.picks.length;
  useEffect(() => {
    if (picks > 0) react("wink", 900);
  }, [picks, react]);

  const manifest = useMemo(() => firstManifest(draft, acct.account?.owner.address ?? "qor1"), [draft, acct.account]);
  const pending = draft.picks
    .filter((p) => p === "form" || p === "shop" || p === "room" || p === "pass")
    .map((p) => ({ key: p, title: draft.fields[p]?.trim() || (PICKS.find((x) => x.id === p)?.title ?? p) }));

  return (
    <div className={s.shell}>
      <header className={s.bar}>
        {step !== "name" && step !== "ready" && step !== "done" ? (
          <button type="button" className={s.back} onClick={back} aria-label="Back">
            <Icon name="back" />
          </button>
        ) : (
          <span className={s.backSpacer} />
        )}
        <div
          className={s.progress}
          role="progressbar"
          aria-label="Sign-up progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
        >
          <i style={{ width: `${progress * 100}%` }} />
        </div>
        <Wordmark size={18} href="/" />
      </header>
      <div className={s.grid}>
        <main className={s.main}>
          {step === "name" && <NameStep value={draft.name} onChange={(name) => set({ name })} onNext={next} />}
          {step === "goal" && (
            <GoalStep
              value={draft.goal}
              onChange={(goal) => set({ goal, picks: draft.picks.length ? draft.picks : GOAL_PICKS[goal] })}
              onNext={next}
            />
          )}
          {step === "template" && (
            <TemplateStep value={draft.template} onChange={(template) => set({ template })} onNext={next} />
          )}
          {step === "blocks" && <BlocksStep draft={draft} set={set} onNext={next} />}
          {step === "profile" && <ProfileStep draft={draft} set={set} onNext={next} />}
          {step === "phrase" && (
            <PhraseStep
              phrase={phrase}
              make={() => setPhrase(newPhrase())}
              name={draft.name}
              onNext={next}
              onSheet={async () => {
                const bytes = await buildSpareKeySheet({
                  name: draft.name,
                  pageUrl: pageUrl(draft.name),
                  address: acct.account?.owner.address ?? addressOf(phrase),
                  evm: acct.account?.owner.evm ?? evmOf(phrase),
                  phrase,
                  createdAt: new Date(),
                });
                downloadBytes(bytes, `mizuhiki-spare-key-${draft.name}.pdf`);
                toast.show("Spare-key sheet saved. Print it or keep it offline.");
              }}
            />
          )}
          {step === "check" && <CheckStep phrase={phrase} onNext={next} onBack={back} />}
          {step === "passphrase" && (
            <PassphraseStep
              onSubmit={async (pass) => {
                await acct.create(phrase, pass);
                setPhrase("");
                window.history.replaceState({ mzStep: "ready" }, "");
                setStep("ready");
              }}
            />
          )}
          {step === "ready" && (
            <ReadyStep
              draft={draft}
              onRename={(name) => set({ name })}
              onDone={() => {
                void idb.del(DRAFT_KEY);
                go("done");
              }}
            />
          )}
          {step === "done" && (
            <DoneStep
              name={draft.name}
              onOpen={() => router.push(after ?? "/app")}
              openLabel={after?.startsWith("/join/") ? "Back to the invite" : "Open dashboard"}
            />
          )}
          {SKIPPABLE.includes(step) ? (
            <button type="button" className={s.skip} onClick={next}>
              Skip
            </button>
          ) : null}
        </main>
        <aside className={s.preview} aria-label="Preview of your page">
          <p className={s.previewLabel}>
            <Icon name="eye" size={14} />
            <span>Live preview · {draft.name ? `@${draft.name}` : "your page"}</span>
          </p>
          <PhoneFrame width={320}>
            <PageView
              manifest={{
                ...manifest,
                name: draft.name || "yourname",
                displayName: draft.displayName || draft.name || "Your name",
              }}
              compact
              pending={pending}
            />
          </PhoneFrame>
          <span className={s.previewMm}>
            <Musubi face={mm.face} hopKey={mm.hopKey} size={110} bob />
          </span>
        </aside>
      </div>
    </div>
  );
}

// Address previews for the spare-key sheet before the vault exists (derived on this device).
const addressOf = (p: string) => (p ? deriveAccount(p).address.bech32 : "");
const evmOf = (p: string) => (p ? deriveAccount(p).address.hex : "");

function Head({ jp, title, sub }: { jp: string; title: ReactNode; sub?: ReactNode }) {
  return (
    <div className={s.head}>
      <Kicker>{jp}</Kicker>
      <h1 className={s.title}>{title}</h1>
      {sub ? <p className={s.sub}>{sub}</p> : null}
    </div>
  );
}

function NameStep({ value, onChange, onNext }: { value: string; onChange: (v: string) => void; onNext: () => void }) {
  const [state, setState] = useState<{
    loading: boolean;
    result?: Availability | undefined;
    error?: string | undefined;
  }>({ loading: false });
  const local = value ? nameProblem(value) : undefined;
  // A string, so the check below runs when the name changes, not on every render.
  const localProblem = local?.problem;
  useEffect(() => {
    if (!value || localProblem) {
      setState({ loading: false });
      return;
    }
    const ctl = new AbortController();
    setState({ loading: true });
    const t = setTimeout(() => {
      api
        .get<Availability>(`/names/${encodeURIComponent(value)}`, { signal: ctl.signal })
        .then((r) => setState({ loading: false, result: r }))
        .catch((e: unknown) => {
          if (!ctl.signal.aborted)
            setState({
              loading: false,
              error: failureText(e, "Could not check that name right now."),
            });
        });
    }, 300);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [value, localProblem]);
  const ok = !local && state.result?.available === true && state.result.name === value;
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onNext();
      }}
    >
      <Head jp="ようこそ" title="Choose your page name" sub="This is your link. You can change it later." />
      <TextField
        label="Page name"
        prefix={`${SITE_HOST}/@`}
        value={value}
        onChange={(e) => onChange(normalizeNameInput(e.target.value))}
        autoFocus
        autoComplete="off"
        spellCheck={false}
        maxLength={30}
        error={
          value && local ? local.message : state.result && !state.result.available ? state.result.message : state.error
        }
        ok={ok ? "It's available" : undefined}
        hint={
          state.loading ? "Checking QoreChain…" : "3 to 30 lowercase letters, numbers, dots, dashes or underscores."
        }
      />
      {state.result && !state.result.available && state.result.suggestions?.length ? (
        <div className={s.suggest}>
          <span>Try:</span>
          {state.result.suggestions.map((n) => (
            <button key={n} type="button" onClick={() => onChange(n)}>
              @{n}
            </button>
          ))}
        </div>
      ) : null}
      <p className={s.fine}>We never ask for your email or a password. There are no marketing messages to agree to.</p>
      <Button type="submit" variant="cord" size="lg" full disabled={!ok}>
        Continue
      </Button>
    </form>
  );
}

const GOALS: {
  id: Goal;
  title: string;
  detail: string;
  icon: "sparkle" | "bag" | "heart" | "users";
  tone: "sakura" | "sora" | "matcha" | "fuji";
}[] = [
  {
    id: "creator",
    title: "Creator",
    detail: "Get paid, sell files, take private messages",
    icon: "sparkle",
    tone: "sakura",
  },
  { id: "business", title: "Business", detail: "Invoices, forms and client files, sealed", icon: "bag", tone: "sora" },
  {
    id: "personal",
    title: "Personal",
    detail: "A private drop box and capsules for family",
    icon: "heart",
    tone: "matcha",
  },
  { id: "team", title: "Team", detail: "Rooms and forms shared by a few people", icon: "users", tone: "fuji" },
];

function GoalStep({
  value,
  onChange,
  onNext,
}: {
  value: Goal | undefined;
  onChange: (g: Goal) => void;
  onNext: () => void;
}) {
  return (
    <div className={s.form}>
      <Head
        jp="もくてき"
        title="What is your page for?"
        sub="This picks your starter blocks. You can change everything later."
      />
      <div className={s.cards} role="radiogroup" aria-label="Goal">
        {GOALS.map((g) => (
          <ChoiceCard
            key={g.id}
            selected={value === g.id}
            onSelect={() => onChange(g.id)}
            title={g.title}
            detail={g.detail}
            icon={<Icon name={g.icon} />}
            tone={g.tone}
          />
        ))}
      </div>
      <Button variant="cord" size="lg" full disabled={!value} onClick={onNext}>
        Continue
      </Button>
    </div>
  );
}

function TemplateStep({
  value,
  onChange,
  onNext,
}: {
  value: string | undefined;
  onChange: (t: string) => void;
  onNext: () => void;
}) {
  return (
    <div className={s.form}>
      <Head
        jp="デザイン"
        title="BlockPick a look"
        sub="BlockPick the style that feels right. You can add your content later."
      />
      <div className={s.templates} role="radiogroup" aria-label="Template">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={value === t.id}
            className={s.tpl}
            onClick={() => onChange(t.id)}
          >
            <span
              className={`${s.tplPhone ?? ""} seigaiha`}
              style={{ ["--a" as string]: t.theme.wallpaper.a, ["--b" as string]: t.theme.wallpaper.b }}
            >
              <span className={s.tplRow} />
              <span className={`${s.tplRow ?? ""} ${s.tplRowCord ?? ""}`} />
              <span className={s.tplRow} />
            </span>
            <b>{t.title}</b>
            <small>{t.trade}</small>
          </button>
        ))}
      </div>
      <Button variant="cord" size="lg" full disabled={!value} onClick={onNext}>
        Continue
      </Button>
    </div>
  );
}

function BlocksStep({ draft, set, onNext }: { draft: Draft; set: (p: Partial<Draft>) => void; onNext: () => void }) {
  const toggle = (p: BlockPick) => {
    const has = draft.picks.includes(p);
    if (!has && draft.picks.length >= 5) return;
    set({ picks: has ? draft.picks.filter((x) => x !== p) : [...draft.picks, p] });
  };
  return (
    <div className={s.form}>
      <Head
        jp="ブロック"
        title="What should your page do?"
        sub="BlockPick up to five to get started. You can update them at any time."
      />
      <div className={s.picks} role="group" aria-label="Blocks">
        {PICKS.map((p) => {
          const on = draft.picks.includes(p.id);
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={on}
              className={s.pick}
              onClick={() => toggle(p.id)}
              disabled={!on && draft.picks.length >= 5}
            >
              <span className={`${s.pickIcon ?? ""} ${s[`tone_${p.tone}`] ?? ""}`}>
                <Icon name={p.icon} size={24} />
              </span>
              <b>{p.title}</b>
              <small>{p.detail}</small>
              {on ? (
                <span className={s.pickTick}>
                  <Icon name="check" size={14} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <p className={s.fine}>{draft.picks.length} of 5 picked. Messages are always on, so people can reach you.</p>
      {draft.picks
        .map((id) => PICKS.find((x) => x.id === id))
        .filter((p) => p?.field)
        .map((p) =>
          p?.field?.options ? (
            <div key={p.id} className={s.smart}>
              <span className={s.smartLabel}>
                {p.title}: {p.field.label}
              </span>
              <div className={s.optRow}>
                {p.field.options.map((o) => (
                  <button
                    key={o}
                    type="button"
                    aria-pressed={(draft.fields[p.id] ?? p.field?.options?.[0]) === o}
                    onClick={() => set({ fields: { ...draft.fields, [p.id]: o } })}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          ) : p?.field ? (
            <TextField
              key={p.id}
              label={`${p.title}: ${p.field.label}`}
              placeholder={p.field.placeholder}
              value={draft.fields[p.id] ?? ""}
              maxLength={80}
              onChange={(e) => set({ fields: { ...draft.fields, [p.id]: e.target.value } })}
            />
          ) : null,
        )}
      <Button variant="cord" size="lg" full onClick={onNext}>
        Continue
      </Button>
    </div>
  );
}

function ProfileStep({ draft, set, onNext }: { draft: Draft; set: (p: Partial<Draft>) => void; onNext: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const pendingBlob = useRef<Blob | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void idb.get<Blob>("onboarding-avatar").then((b) => {
      if (b) {
        pendingBlob.current = b;
        setPreview(URL.createObjectURL(b));
      }
    });
  }, []);
  return (
    <div className={s.form}>
      <Head
        jp="プロフィール"
        title="Add your photo, name and bio"
        sub="This is public. It appears at the top of your page."
      />
      {file ? (
        <AvatarCrop
          file={file}
          onCancel={() => setFile(null)}
          onDone={(b) => {
            pendingBlob.current = b;
            void idb.set("onboarding-avatar", b);
            setPreview(URL.createObjectURL(b));
            setFile(null);
          }}
        />
      ) : (
        <div className={s.avatarRow}>
          <button
            type="button"
            className={s.avatarPick}
            onClick={() => input.current?.click()}
            aria-label={preview ? "Change photo" : "Add a photo"}
          >
            {preview ? <img src={preview} alt="" /> : <Icon name="image" size={30} />}
            <span className={s.avatarPlus}>
              <Icon name="plus" size={16} />
            </span>
          </button>
          <div>
            <b>{preview ? "Looking good" : "Add a profile photo"}</b>
            <p className={s.fine}>PNG, JPEG or WebP. You can place and zoom it next.</p>
            {preview ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  pendingBlob.current = null;
                  setPreview(null);
                  void idb.del("onboarding-avatar");
                }}
              >
                Remove photo
              </Button>
            ) : null}
          </div>
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
              e.target.value = "";
            }}
          />
        </div>
      )}
      <TextField
        label="Display name"
        value={draft.displayName}
        onChange={(e) => set({ displayName: e.target.value })}
        maxLength={60}
        placeholder="Aria Kapoor"
      />
      <TextArea
        label="Bio"
        value={draft.bio}
        onChange={(e) => set({ bio: e.target.value })}
        maxLength={160}
        counter
        placeholder="A line or two about what you do"
      />
      <BioHelper draft={draft} onBio={(bio) => set({ bio })} />
      <Button variant="cord" size="lg" full onClick={onNext}>
        Continue
      </Button>
    </div>
  );
}

/** "Need inspiration? Write a few words and let AI do the rest." Shown only when the server has it switched on. */
function BioHelper({ draft, onBio }: { draft: Draft; onBio: (b: string) => void }) {
  const toast = useToast();
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get<{ bio: boolean }>("/ai/status")
      .then((r) => setOn(r.bio))
      .catch(() => setOn(false));
  }, []);
  if (!on) return null;
  return (
    <div className={s.bioHelp}>
      <span className={s.fine}>
        Need inspiration? Write a few words and let AI do the rest. Your bio is public, so nothing private is sent.
      </span>
      <Button
        size="sm"
        variant="line"
        icon="sparkle"
        busy={busy}
        onClick={() => {
          setBusy(true);
          api
            .post<{ bio: string }>("/ai/bio", {
              displayName: draft.displayName,
              goal: draft.goal ?? "creator",
              offers: draft.picks.map((p) => PICKS.find((x) => x.id === p)?.title ?? p),
              draft: draft.bio,
            })
            .then((r) => onBio(r.bio))
            .catch((e: unknown) => toast.show(failureText(e, "The helper did not answer."), { tone: "error" }))
            .finally(() => setBusy(false));
        }}
      >
        {draft.bio ? "Rewrite my bio" : "Write my bio"}
      </Button>
    </div>
  );
}

function PhraseStep({
  phrase,
  make,
  name,
  onNext,
  onSheet,
}: {
  phrase: string;
  make: () => void;
  name: string;
  onNext: () => void;
  onSheet: () => Promise<void>;
}) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!phrase) make();
  }, [phrase, make]);
  const words = phrase ? phraseWords(phrase) : [];
  return (
    <div className={s.form}>
      <Head
        jp="かぎ"
        title="Create your key"
        sub="This phrase is the only key to your sealed items. We cannot recover it."
      />
      <div className={s.warn} role="note">
        <Icon name="alert" />
        <span>
          Without it, no one can open your sealed items, including you. It is shown <b>once</b>, here, on this device.
        </span>
      </div>
      <ol className={s.words} aria-label="Your 24 recovery words">
        {words.map((w, i) => (
          <li key={i}>
            <span>{i + 1}</span>
            <b className="mono">{w}</b>
          </li>
        ))}
      </ol>
      <div className={s.actions}>
        <Button
          variant="cord"
          icon="download"
          busy={busy}
          onClick={() => {
            setBusy(true);
            onSheet()
              .then(() => setSaved(true))
              .catch(() => toast.show("Could not build the sheet. Copy the words instead.", { tone: "error" }))
              .finally(() => setBusy(false));
          }}
        >
          Save my spare-key sheet
        </Button>
        <Button
          variant="line"
          icon="copy"
          onClick={() => {
            navigator.clipboard.writeText(phrase).then(
              () => {
                setSaved(true);
                toast.show("Copied. Paste it somewhere offline, then clear your clipboard.");
              },
              () => toast.show("Copy is not allowed here. Write the words down instead.", { tone: "error" }),
            );
          }}
        >
          Copy
        </Button>
      </div>
      <p className={s.fine}>
        Give a copy to someone you trust, or add it to your will. The sheet has your page, your address, these words and
        room for notes for @{name}.
      </p>
      <label className={s.confirm}>
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I saved my 24 words
        somewhere safe
      </label>
      <Button variant="cord" size="lg" full disabled={!saved} onClick={onNext}>
        I saved it
      </Button>
    </div>
  );
}

function CheckStep({ phrase, onNext, onBack }: { phrase: string; onNext: () => void; onBack: () => void }) {
  const words = phraseWords(phrase);
  const [positions] = useState(() => pickCheckPositions(3));
  const [vals, setVals] = useState<string[]>(["", "", ""]);
  const [tried, setTried] = useState(false);
  const wrong = positions.map((p, i) => (vals[i] ?? "").trim().toLowerCase() !== words[p]);
  const allOk = wrong.every((w) => !w);
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (allOk) onNext();
      }}
    >
      <Head
        jp="かくにん"
        title="Check your words"
        sub="Type these three words from your phrase, so we know you have it."
      />
      {positions.map((p, i) => (
        <TextField
          key={p}
          label={`Word ${p + 1}`}
          value={vals[i] ?? ""}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          onPaste={(e) => {
            if (e.clipboardData.getData("text").trim().split(/\s+/).length > 1) {
              e.preventDefault();
              setTried(true);
            }
          }}
          onChange={(e) => setVals((v) => v.map((x, j) => (j === i ? e.target.value : x)))}
          error={tried && wrong[i] ? `That is not word ${p + 1}. Check your sheet.` : undefined}
          autoFocus={i === 0}
        />
      ))}
      <Button type="submit" variant="cord" size="lg" full>
        Check
      </Button>
      <Button variant="ghost" full onClick={onBack}>
        Show my words again
      </Button>
    </form>
  );
}

function PassphraseStep({ onSubmit }: { onSubmit: (pass: string) => Promise<void> }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = a ? passphraseProblem(a) : undefined;
  const mismatch = b.length > 0 && a !== b;
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || mismatch || !a) return;
        setBusy(true);
        setErr(null);
        onSubmit(a)
          .catch((x: unknown) => setErr((x as Error).message))
          .finally(() => setBusy(false));
      }}
    >
      <Head
        jp="ロック"
        title="Lock this device"
        sub="A passphrase locks your key in this browser. You type it to open Mizuhiki here."
      />
      <TextField
        label="Device passphrase"
        type="password"
        value={a}
        onChange={(e) => setA(e.target.value)}
        autoComplete="new-password"
        error={problem}
        hint="At least 10 characters. A short sentence works well."
        autoFocus
      />
      <TextField
        label="Type it again"
        type="password"
        value={b}
        onChange={(e) => setB(e.target.value)}
        autoComplete="new-password"
        error={mismatch ? "These do not match yet." : undefined}
      />
      <LockLine>The passphrase never leaves this device. If you forget it, your 24 words open Mizuhiki again.</LockLine>
      {err ? <Oops title="The key was not saved">{err} Nothing left your device.</Oops> : null}
      <Button type="submit" variant="cord" size="lg" full busy={busy} disabled={!a || !!problem || a !== b}>
        Lock and continue
      </Button>
    </form>
  );
}

function ReadyStep({
  draft,
  onDone,
  onRename,
}: {
  draft: Draft;
  onDone: () => void;
  onRename: (name: string) => void;
}) {
  const acct = useAccount();
  const [states, setStates] = useState<Record<SetupStep, StepItem["state"]>>(
    () => Object.fromEntries(SETUP_STEPS.map((x) => [x.id, "waiting"])) as Record<SetupStep, StepItem["state"]>,
  );
  const [info, setInfo] = useState<Partial<Record<SetupStep, { tx?: string | undefined; note?: string | undefined }>>>(
    {},
  );
  const [balance, setBalance] = useState<bigint | null>(null);
  const [error, setError] = useState<{ title: string; detail: string; tx?: string | undefined } | null>(null);
  const [taken, setTaken] = useState(false);
  const [newName, setNewName] = useState("");
  const [run, setRun] = useState(0);
  const [needUnlock, setNeedUnlock] = useState(false);
  // The effect below depends only on the account address and the retry counter;
  // everything else is read through refs, so a re-render never restarts a run.
  const acctRef = useRef(acct);
  acctRef.current = acct;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const address = acct.account?.owner.address;

  useEffect(() => {
    if (acct.status === "locked") setNeedUnlock(true);
  }, [acct.status]);

  useEffect(() => {
    const a = acctRef.current.account;
    if (!a || !address) return;
    const ctl = new AbortController();
    setError(null);
    void (async () => {
      try {
        const manifest = firstManifest(draftRef.current, a.owner.address);
        const blob = await idb.get<Blob>("onboarding-avatar").catch(() => undefined);
        const result = await runSetup(a, manifest, {
          beforePublish: async (m) => {
            if (!blob) return m;
            const token = await acctRef.current.token();
            const avatar = await api.put<{ hash: string; type: "image/png" | "image/jpeg" | "image/webp" }>(
              "/media",
              new Uint8Array(await blob.arrayBuffer()),
              { token },
            );
            return { ...m, avatar };
          },
          token: () => acctRef.current.token(),
          signal: ctl.signal,
          onWaitingForFunds: (b) => {
            setBalance(b);
            return !ctl.signal.aborted;
          },
          onStep: (st, state, i) => {
            setStates((x) => ({ ...x, [st]: state }));
            if (i) setInfo((x) => ({ ...x, [st]: i }));
          },
        });
        // Unfinished picks (forms, shop, rooms, passes) carry into the editor's sealed draft.
        if (result.published && !ctl.signal.aborted) {
          const d = draftRef.current;
          const pending = d.picks
            .filter(
              (p): p is "form" | "shop" | "room" | "pass" =>
                p === "form" || p === "shop" || p === "room" || p === "pass",
            )
            .map((kind) => ({
              key: kind,
              kind,
              title: d.fields[kind]?.trim() || (PICKS.find((x) => x.id === kind)?.title ?? kind),
            }));
          await saveDraft(a, await acctRef.current.token(), draftFromManifest(result.published, pending)).catch(
            () => undefined,
          );
        }
        if (!ctl.signal.aborted) doneRef.current();
      } catch (e) {
        if ((e as Error).name === "AbortError" || ctl.signal.aborted) return;
        setStates((x) => {
          const runningStep = (Object.keys(x) as SetupStep[]).find((k) => x[k] === "running");
          return runningStep ? { ...x, [runningStep]: "failed" } : x;
        });
        if (isChainError(e) && e.detail === "NameTaken") {
          setTaken(true);
          setError(null);
        } else if (isChainError(e))
          setError({
            title: e.message,
            detail:
              e.moved === "no"
                ? "Nothing changed on chain."
                : e.moved === "unknown"
                  ? "It may still go through; we check again when you retry."
                  : "Only the network fee was spent.",
            tx: e.txHash,
          });
        else if (e instanceof ApiFailure)
          setError({ title: e.message, detail: "Your keys on chain are safe. Retry to finish." });
        else
          setError({
            title: "Setup stopped.",
            detail: failureText(e, "Setup stopped before this step finished. Try again."),
          });
      }
    })();
    return () => ctl.abort();
  }, [address, run]);

  if (needUnlock && acct.status !== "unlocked") return <UnlockInline onUnlocked={() => setNeedUnlock(false)} />;

  const items: StepItem[] = SETUP_STEPS.map((x) => {
    const i = info[x.id];
    const detail = (
      <>
        {x.detail}
        {i?.tx ? (
          <>
            {" "}
            <a href={explorerTx(i.tx)} target="_blank" rel="noopener noreferrer" className={s.tx}>
              View transaction
            </a>
          </>
        ) : null}
        {i?.note ? ` (${i.note})` : null}
      </>
    );
    return {
      title: x.title,
      detail,
      state: states[x.id],
      ...(x.id === "fund" && states.fund === "running" && acct.account
        ? {
            body: (
              <div className={s.fund}>
                <p>
                  Setup spends about 0.12 test QOR in network fees; this step waits for <b>0.2</b> so there is room to
                  spare. The QoreChain faucet gives 100 test QOR once a day: sign in to the QoreChain dashboard (free),
                  paste this address and choose Request Tokens.
                </p>
                <CopyValue value={acct.account.owner.address} label="address" />
                <div className={s.actions}>
                  <a className={s.faucet} href={NETWORK.faucet} target="_blank" rel="noopener noreferrer">
                    Open the faucet
                    <Icon name="share" size={16} />
                  </a>
                </div>
                <p className={s.fine}>
                  {balance === null
                    ? "Checking the balance…"
                    : `Balance now: ${fromBaseUnits(balance, DENOMS.QOR.decimals)} test QOR.`}{" "}
                  This screen moves on by itself when it arrives (needs {fromBaseUnits(MIN_SETUP_UQOR, 6)}).
                </p>
              </div>
            ),
          }
        : {}),
    };
  });
  return (
    <div className={s.form}>
      <Head
        jp="じゅんび"
        title="Getting your account ready"
        sub="Each step is real and happens on QoreChain testnet. You can leave and come back; finished steps are not repeated."
      />
      <div className={s.stepper}>
        <Stepper steps={items} />
      </div>
      {taken ? (
        <div className={s.takenBox}>
          <Oops title={`@${draft.name} was just taken`}>
            Someone claimed it a moment ago. Nothing was charged except network fees. Pick another name and setup
            carries on.
          </Oops>
          <NameStep
            value={newName}
            onChange={setNewName}
            onNext={() => {
              onRename(newName);
              setTaken(false);
              setRun((r) => r + 1);
            }}
          />
        </div>
      ) : null}
      {error ? (
        <Oops
          title={error.title}
          action={
            <Button size="sm" variant="cord" onClick={() => setRun((r) => r + 1)}>
              Retry
            </Button>
          }
        >
          {error.detail}
          {error.tx ? ` Transaction ${error.tx}.` : ""}
        </Oops>
      ) : null}
    </div>
  );
}

function UnlockInline({ onUnlocked }: { onUnlocked: () => void }) {
  const acct = useAccount();
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        acct
          .unlock(pass)
          .then(onUnlocked)
          .catch((x: unknown) => setErr((x as Error).message))
          .finally(() => setBusy(false));
      }}
    >
      <Head
        jp="おかえり"
        title="Unlock to finish setup"
        sub="Type your device passphrase. Finished steps will not be repeated."
      />
      <TextField
        label="Device passphrase"
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        error={err}
        autoFocus
        autoComplete="current-password"
      />
      <Button type="submit" variant="cord" size="lg" full busy={busy}>
        Unlock
      </Button>
    </form>
  );
}

function DoneStep({ name, onOpen, openLabel }: { name: string; onOpen: () => void; openLabel: string }) {
  const toast = useToast();
  const acct = useAccount();
  const mm = useRef<HTMLDivElement>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const url = pageUrl(name);
  useEffect(() => {
    burstFrom(mm.current);
  }, []);
  return (
    <div className={s.form}>
      <div ref={mm} className={s.doneMm}>
        <Musubi face="happy" size={140} />
      </div>
      <Head
        jp="できた！"
        title="Your page is live"
        sub="Anything sent through it is sealed to you on the sender's device."
      />
      <div className={s.urlBox}>
        <CopyValue
          value={url}
          label="page link"
          onCopied={(ok) => toast.show(ok ? "Link copied" : "Copy is not allowed here", { tone: ok ? "ok" : "error" })}
        />
      </div>
      <div className={s.actions}>
        <Button
          variant="line"
          icon="share"
          onClick={() => {
            // navigator.share is missing on most desktop browsers even though the DOM types always declare it.
            const nav: Partial<Pick<Navigator, "share">> & Pick<Navigator, "clipboard"> = navigator;
            if (nav.share) void nav.share({ title: `@${name} on Mizuhiki`, url }).catch(() => undefined);
            else void nav.clipboard.writeText(url).then(() => toast.show("Link copied"));
          }}
        >
          Share
        </Button>
        <Button variant="cord" iconRight="arrow" onClick={onOpen}>
          {openLabel}
        </Button>
      </div>
      {passkeysPossible() && !acct.vault?.wraps.some((w) => w.kind === "passkey") ? (
        <div className={s.passkey}>
          <b>Unlock faster next time</b>
          <p className={s.fine}>
            Add a passkey so Face ID, Touch ID or your device PIN unlocks Mizuhiki here. Your passphrase still works.
          </p>
          <Button
            size="sm"
            variant="line"
            icon="key"
            busy={passkeyBusy}
            onClick={() => {
              setPasskeyBusy(true);
              acct
                .addPasskey(name)
                .then(() => toast.show("Passkey added"))
                .catch(() => toast.show("No passkey was added. Your passphrase still works.", { tone: "error" }))
                .finally(() => setPasskeyBusy(false));
            }}
          >
            Add a passkey
          </Button>
        </div>
      ) : null}
    </div>
  );
}
