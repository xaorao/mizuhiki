"use client";
/**
 * New room (Telegram + WhatsApp creation, adapted): pick a kind of room, pick
 * members (search by @name or paste an address; chips on top), name and
 * photo, the starting rules, then seal. The first room key is sealed to every
 * member here and the room is recorded on QoreChain.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Button,
  ChoiceCard,
  Icon,
  IconButton,
  LockLine,
  Segmented,
  Stepper,
  TextArea,
  TextField,
  ToggleRow,
  useToast,
  type StepItem,
} from "@mizuhiki/ui";
import { ROOM_TEMPLATES, ROOM_TYPES, type RoomType } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { createRoom, lookupPerson, STEP_LABEL, withToken, type Step } from "./engine";
import { PersonAvatar, useNames } from "./people";
import { durationLabel } from "./derive";
import s from "./rooms.module.css";
import { failureText } from "@/lib/failure";

type Phase = "kind" | "members" | "details" | "sealing" | "failed";
const AUTO_DELETE = [0, 86_400, 604_800, 2_592_000] as const;
const ICON: Record<RoomType, "invoice" | "coin" | "users" | "heart"> = {
  deal: "invoice",
  payroll: "coin",
  team: "users",
  family: "heart",
};

export function CreateRoom() {
  const router = useRouter();
  const toast = useToast();
  const { account, token } = useAccount();
  const [phase, setPhase] = useState<Phase>("kind");
  const [type, setType] = useState<RoomType>("team");
  const [members, setMembers] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ address: string; name: string | null } | null | "none" | "busy">(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [approval, setApproval] = useState(ROOM_TEMPLATES.team.approval);
  const [history, setHistory] = useState<"share" | "hide">(ROOM_TEMPLATES.team.history);
  const [autoDelete, setAutoDelete] = useState(0);
  const [restrict, setRestrict] = useState(false);
  const [step, setStep] = useState<Step>("keys");
  const [error, setError] = useState<string | null>(null);
  const names = useNames(members);
  const fileRef = useRef<HTMLInputElement>(null);
  const me = account?.owner.address;

  useEffect(() => {
    const t = ROOM_TEMPLATES[type];
    setApproval(t.approval);
    setHistory(t.history);
  }, [type]);

  useEffect(() => {
    if (!photo) return;
    const url = URL.createObjectURL(photo);
    setPhotoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [photo]);

  // Search as the person types: @name from the registry, or a pasted address.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setFound(null);
      return;
    }
    setFound("busy");
    const t = setTimeout(() => {
      void lookupPerson(q)
        .then((r) => setFound(r ?? "none"))
        .catch(() => setFound("none"));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const add = (address: string) => {
    if (address === me) {
      toast.show("You are in the room already, as its owner.");
      return;
    }
    setMembers((m) => (m.includes(address) ? m : [...m, address]));
    setQuery("");
    setFound(null);
  };

  const stepIndex = phase === "kind" ? 0 : phase === "members" ? 1 : 2;
  const sealSteps = useMemo((): StepItem[] => {
    const order = Object.keys(STEP_LABEL) as Step[];
    return order.map((k) => ({
      title: STEP_LABEL[k],
      state: order.indexOf(k) < order.indexOf(step) ? "done" : k === step ? "running" : "waiting",
    }));
  }, [step]);

  const seal = async () => {
    if (!account) return;
    setPhase("sealing");
    setError(null);
    try {
      const id = await createRoom(
        withToken(account, await token()),
        {
          name,
          description,
          type,
          members,
          approval,
          historyDefault: history,
          autoDeleteSeconds: autoDelete,
          restrictSaving: restrict,
          photo: photo ?? undefined,
        },
        setStep,
      );
      router.push(`/app/rooms/${id}?new=1`);
    } catch (e) {
      setError(failureText(e, "Something went wrong."));
      setPhase("failed");
    }
  };

  return (
    <div className={s.create}>
      <header className={s.createHead}>
        <IconButton
          icon="back"
          label="Back to rooms"
          onClick={() =>
            phase === "kind" || phase === "sealing"
              ? router.push("/app/rooms")
              : setPhase(phase === "details" || phase === "failed" ? "members" : "kind")
          }
        />
        <div>
          <p className={s.kicker}>あたらしいへや · New room</p>
          <h1>
            {phase === "kind"
              ? "What is this room for?"
              : phase === "members"
                ? "Who would you like to add?"
                : phase === "sealing"
                  ? "Sealing your room"
                  : phase === "failed"
                    ? "The room was not made"
                    : "Name your room"}
          </h1>
        </div>
      </header>
      {phase !== "sealing" && phase !== "failed" ? (
        <ol className={s.dots} aria-label={`Step ${stepIndex + 1} of 3`}>
          {["Kind", "People", "Details"].map((t, i) => (
            <li key={t} data-state={i < stepIndex ? "done" : i === stepIndex ? "now" : "todo"}>
              {t}
            </li>
          ))}
        </ol>
      ) : null}

      {phase === "kind" ? (
        <div className={s.pane}>
          <div className={s.kinds} role="radiogroup" aria-label="Kind of room">
            {ROOM_TYPES.map((t) => (
              <ChoiceCard
                key={t}
                selected={type === t}
                onSelect={() => setType(t)}
                icon={<Icon name={ICON[t]} size={22} />}
                title={ROOM_TEMPLATES[t].label}
                detail={ROOM_TEMPLATES[t].blurb}
              />
            ))}
          </div>
          <p className={s.note}>You can change every rule later in Room info.</p>
          <div className={s.actions}>
            <Button variant="cord" iconRight="arrow" onClick={() => setPhase("members")}>
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "members" ? (
        <div className={s.pane}>
          {members.length ? (
            <ul className={s.chips} aria-label="Chosen people">
              {members.map((a) => (
                <li key={a} className={s.chip}>
                  <PersonAvatar address={a} names={names} size={28} />
                  <span>{names[a] ? `@${names[a]}` : `${a.slice(0, 10)}…`}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${names[a] ?? a}`}
                    onClick={() => setMembers((m) => m.filter((x) => x !== a))}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <TextField
            label="Add people"
            placeholder="@name or qor1… address"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            prefix={<Icon name="search" size={18} />}
            hint="Everyone needs a Mizuhiki account, so the room key can be sealed to them."
            autoComplete="off"
            spellCheck={false}
          />
          <div className={s.found} aria-live="polite">
            {found === "busy" ? (
              <p className={s.muted}>Looking on QoreChain…</p>
            ) : found === "none" ? (
              <p className={s.muted}>No account with that name or address.</p>
            ) : found ? (
              <button type="button" className={s.foundRow} onClick={() => add(found.address)}>
                <PersonAvatar address={found.address} names={{ [found.address]: found.name }} size={40} />
                <span>
                  <b>{found.name ? `@${found.name}` : "No name yet"}</b>
                  <small>{found.address}</small>
                </span>
                <Icon name={members.includes(found.address) ? "check" : "plus"} size={20} />
              </button>
            ) : null}
          </div>
          <p className={s.note}>You can also skip this and invite people with a link after the room is made.</p>
          <div className={s.actions}>
            <Button variant="cord" iconRight="arrow" onClick={() => setPhase("details")}>
              {members.length ? `Next · ${members.length + 1} people` : "Skip for now"}
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "details" ? (
        <div className={s.pane}>
          <div className={s.nameRow}>
            <button
              type="button"
              className={s.photoPick}
              onClick={() => fileRef.current?.click()}
              aria-label={photo ? "Change room photo" : "Add room photo"}
            >
              {photoUrl ? <img src={photoUrl} alt="" /> : <Icon name="image" size={26} />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f && f.size > 5 * 1024 * 1024) toast.show("Pick a photo under 5 MB.", { tone: "error" });
                else if (f) setPhoto(f);
                e.target.value = "";
              }}
            />
            <TextField
              label="Room name"
              placeholder={`${ROOM_TEMPLATES[type].label} room`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              counter
            />
          </div>
          <TextArea
            label="Description (optional)"
            placeholder="What the room is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            rows={2}
            hint="Only members and people you invite can read it."
          />

          <div className={s.rules}>
            <ToggleRow
              title="Approve new members"
              detail="The room key is sealed to someone only after an admin approves them."
              checked={approval}
              onChange={setApproval}
            />
            <div className={s.ruleRow}>
              <span>
                <b>New members see</b>
                <small>Used when invites join on their own. You still choose for each person you approve.</small>
              </span>
              <Segmented<"share" | "hide">
                label="New members see"
                value={history}
                onChange={setHistory}
                options={[
                  { value: "hide", label: "Only new messages" },
                  { value: "share", label: "Past messages too" },
                ]}
              />
            </div>
            <div className={s.ruleRow}>
              <span>
                <b>Auto-delete</b>
                <small>
                  Automatically delete new messages after a while. It removes the sealed copy from storage, not copies a
                  member already opened.
                </small>
              </span>
              <Segmented
                label="Auto-delete"
                value={String(autoDelete)}
                onChange={(v) => setAutoDelete(Number(v))}
                options={AUTO_DELETE.map((x) => ({ value: String(x), label: x === 0 ? "Off" : durationLabel(x) }))}
              />
            </div>
            <ToggleRow
              title="Ask members not to save"
              detail="A request, not a lock: anyone who can read a message can still screenshot it."
              checked={restrict}
              onChange={setRestrict}
            />
          </div>
          <LockLine>
            Everything said in this room is sealed to its members on their devices. QoreChain records only that the room
            exists and who is in it, as a hash.
          </LockLine>
          <div className={s.actions}>
            <Button variant="cord" icon="lock" onClick={() => void seal()} disabled={!name.trim()}>
              Seal and create room
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "sealing" ? (
        <div className={s.pane} aria-live="polite">
          <Stepper steps={sealSteps} />
          <p className={s.note}>This takes a few seconds: the room is recorded on QoreChain.</p>
        </div>
      ) : null}

      {phase === "failed" ? (
        <div className={s.pane} role="alert">
          <p className={s.failText}>{error}</p>
          <p className={s.note}>
            Nothing readable left your device. If the room was recorded on QoreChain before the failure, it stays empty
            and unused.
          </p>
          <div className={s.actions}>
            <Button variant="line" onClick={() => setPhase("details")}>
              Back
            </Button>
            <Button variant="cord" icon="undo" onClick={() => void seal()}>
              Try again
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
