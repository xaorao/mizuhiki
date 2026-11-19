/**
 * Forms (spec 5.9): drafts sealed to the owner, published definitions signed
 * by the owner (checked against the chain here and again by respondents),
 * content-blind counters for results, and the per-form rules the drop service
 * enforces when an answer arrives (published, open, before the close date,
 * under the response limit, not flooding).
 */
import type { FastifyPluginCallback } from "fastify";
import { and, count, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { FormDefSchema, isQuestion, normalizeNameInput, verifyRecord, type FormDef, type Signed } from "@mizuhiki/core";
import { blobs, counters, envelopes, forms, names } from "@mizuhiki/db";
import type { Ctx } from "../server";
import type { Db } from "@mizuhiki/db";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf } from "../lib/chainreads";
import { fail } from "../lib/http";

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const HASH = /^[0-9a-f]{64}$/;
const today = () => new Date().toISOString().slice(0, 10);

async function bump(db: Db, owner: string, kind: string, subject: string, by = 1): Promise<void> {
  await db
    .insert(counters)
    .values({ owner, day: today(), kind, subject, count: by })
    .onConflictDoUpdate({
      target: [counters.owner, counters.day, counters.kind, counters.subject],
      set: { count: sql`${counters.count} + ${by}` },
    });
}

/** Why an answer to this form cannot be accepted right now, or null. Used by the drop service. */
export async function formRefusal(db: Db, owner: string, ref: string | undefined): Promise<string | null> {
  const m = /^form:([A-Za-z0-9_-]{1,40})$/.exec(ref ?? "");
  if (!m?.[1]) return "This answer does not name its form. Nothing was stored.";
  const [f] = await db
    .select()
    .from(forms)
    .where(and(eq(forms.id, m[1]), eq(forms.owner, owner)));
  const rec = f?.record as Signed<FormDef> | null | undefined;
  if (!f || !rec || f.archived) return "This form is not published. Nothing was stored.";
  const s = rec.body.settings;
  if (s.closed) return "This form is closed. Nothing was stored.";
  if (s.closeAt && Date.now() > Date.parse(s.closeAt))
    return "This form closed on its closing date. Nothing was stored.";
  const refStr = `form:${m[1]}`;
  if (s.limit !== undefined) {
    const [n] = await db
      .select({ n: count() })
      .from(envelopes)
      .where(and(eq(envelopes.owner, owner), eq(envelopes.ref, refStr)));
    if ((n?.n ?? 0) >= s.limit) return "This form has all the answers it takes. Nothing was stored.";
  }
  // Content-blind flood guard per form: at most 30 answers a minute.
  const [recent] = await db
    .select({ n: count() })
    .from(envelopes)
    .where(and(eq(envelopes.ref, refStr), gte(envelopes.createdAt, new Date(Date.now() - 60_000))));
  if ((recent?.n ?? 0) >= 30)
    return "This form is receiving too many answers right now. Try again in a minute. Nothing was stored.";
  return null;
}

/** Whether the owner wants a nudge for answers to this form (settings.notify). */
export async function formNotifies(db: Db, owner: string, ref: string | undefined): Promise<boolean> {
  const m = /^form:([A-Za-z0-9_-]{1,40})$/.exec(ref ?? "");
  if (!m?.[1]) return true;
  const [f] = await db
    .select({ record: forms.record })
    .from(forms)
    .where(and(eq(forms.id, m[1]), eq(forms.owner, owner)));
  return (f?.record as Signed<FormDef> | null | undefined)?.body.settings.notify ?? true;
}

const SigSchema = z.object({ kind: z.literal("form"), signer: z.string(), body: z.unknown(), signature: z.unknown() });

export const formRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    /** Save a draft (sealed to the owner) and, optionally, publish a signed definition. */
    app.put("/forms", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was saved.", "nothing-stored");
      const b = z
        .object({
          id: z.string().regex(ID),
          slug: z.string().regex(/^[a-z0-9-]{1,48}$/),
          draftEnvelope: z.string().regex(HASH),
          publish: SigSchema.optional(),
        })
        .safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The form was incomplete. Nothing was saved.", "nothing-stored");
      const [existing] = await db.select().from(forms).where(eq(forms.id, b.data.id));
      if (existing && existing.owner !== owner)
        return fail(reply, 409, "TAKEN", "That form id belongs to someone else. Nothing was saved.", "nothing-stored");
      const [slugOwner] = await db
        .select({ id: forms.id })
        .from(forms)
        .where(and(eq(forms.owner, owner), eq(forms.slug, b.data.slug)));
      if (slugOwner && slugOwner.id !== b.data.id)
        return fail(
          reply,
          409,
          "SLUG_TAKEN",
          `You already have a form at /f/${b.data.slug}. Pick another link. Nothing was saved.`,
          "nothing-stored",
        );
      const [blob] = await db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, b.data.draftEnvelope));
      if (!blob)
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "The sealed draft did not arrive. Nothing was saved.",
          "nothing-stored",
        );

      let record: Signed<FormDef> | undefined;
      if (b.data.publish) {
        const parsed = FormDefSchema.safeParse(b.data.publish.body);
        if (!parsed.success)
          return fail(
            reply,
            400,
            "BAD_FORM",
            "The form has a part that is not valid. Nothing was published.",
            "nothing-stored",
          );
        const def = parsed.data;
        if (b.data.publish.signer !== owner || def.owner !== owner || def.id !== b.data.id || def.slug !== b.data.slug)
          return fail(
            reply,
            400,
            "BAD_SIGNATURE",
            "This form is signed for another account or link. Nothing was published.",
            "nothing-stored",
          );
        if (def.version <= (existing?.version ?? 0))
          return fail(
            reply,
            409,
            "STALE",
            "A newer version is already published. Reload and try again.",
            "nothing-stored",
          );
        const owned = await db.select({ name: names.name }).from(names).where(eq(names.address, owner));
        if (!owned.some((n) => n.name === normalizeNameInput(def.name)))
          return fail(
            reply,
            400,
            "NOT_YOUR_NAME",
            `@${def.name} is not registered to your account. Nothing was published.`,
            "nothing-stored",
          );
        const key = await pqKeyOf(owner);
        try {
          if (!key.publicKey || !key.possessionProven) throw new Error("no key");
          verifyRecord(b.data.publish as unknown as Signed<FormDef>, {
            kind: "form",
            signer: owner,
            pqPublicKey: key.publicKey,
          });
        } catch {
          return fail(
            reply,
            400,
            "BAD_SIGNATURE",
            "The signature does not match your key on chain. Nothing was published.",
            "nothing-stored",
          );
        }
        record = { ...(b.data.publish as unknown as Signed<FormDef>), body: def };
      }

      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(blobs).set({ expiresAt: null }).where(eq(blobs.hash, b.data.draftEnvelope));
        await tx
          .insert(forms)
          .values({
            id: b.data.id,
            owner,
            slug: b.data.slug,
            draftEnvelope: b.data.draftEnvelope,
            ...(record ? { record, version: record.body.version, publishedAt: now } : {}),
          })
          .onConflictDoUpdate({
            target: forms.id,
            set: {
              slug: b.data.slug,
              draftEnvelope: b.data.draftEnvelope,
              updatedAt: now,
              ...(record ? { record, version: record.body.version, publishedAt: now } : {}),
            },
          });
      });
      return { ok: true, published: !!record, version: record?.body.version ?? existing?.version ?? 0 };
    });

    app.get("/owner/forms", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db.select().from(forms).where(eq(forms.owner, owner)).orderBy(desc(forms.updatedAt));
      const ids = rows.map((r) => r.id);
      const submitted = ids.length
        ? await db
            .select({ ref: envelopes.ref, n: count() })
            .from(envelopes)
            .where(
              and(
                eq(envelopes.owner, owner),
                inArray(
                  envelopes.ref,
                  ids.map((i) => `form:${i}`),
                ),
              ),
            )
            .groupBy(envelopes.ref)
        : [];
      return {
        forms: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          draftEnvelope: r.draftEnvelope,
          published: r.record
            ? {
                version: r.version,
                at: r.publishedAt?.toISOString() ?? null,
                title: (r.record as Signed<FormDef>).body.title,
                closed: (r.record as Signed<FormDef>).body.settings.closed,
              }
            : null,
          archived: r.archived,
          updatedAt: r.updatedAt.toISOString(),
          responses: submitted.find((x) => x.ref === `form:${r.id}`)?.n ?? 0,
        })),
      };
    });

    /** The owner's own published record (to change readers without touching unpublished edits). */
    app.get("/owner/forms/:id/record", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const [f] = await db.select().from(forms).where(and(eq(forms.id, id), eq(forms.owner, owner)));
      if (!f) return fail(reply, 404, "NOT_FOUND", "No such form.");
      return { record: f.record ?? null, version: f.version, slug: f.slug, draftEnvelope: f.draftEnvelope };
    });

    app.patch("/owner/forms/:id", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { id } = req.params as { id: string };
      const b = z.object({ archived: z.boolean() }).safeParse(req.body);
      if (!ID.test(id) || !b.success) return fail(reply, 400, "BAD_REQUEST", "Nothing changed.");
      const r = await db
        .update(forms)
        .set({ archived: b.data.archived, updatedAt: new Date() })
        .where(and(eq(forms.id, id), eq(forms.owner, owner)))
        .returning({ id: forms.id });
      if (!r.length) return fail(reply, 404, "NOT_FOUND", "That form is not yours.");
      return { ok: true };
    });

    /** Content-blind results: counters only. Answers are opened on the owner's device. */
    app.get("/owner/forms/:id/stats", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return fail(reply, 400, "BAD_REQUEST", "Not a form.");
      const rows = await db
        .select({ kind: counters.kind, subject: counters.subject, n: sql<number>`sum(${counters.count})::int` })
        .from(counters)
        .where(and(eq(counters.owner, owner), like(counters.subject, `f:${id}%`)))
        .groupBy(counters.kind, counters.subject);
      const get = (k: string) => rows.find((r) => r.kind === k && r.subject === `f:${id}`)?.n ?? 0;
      const reach: Record<string, number> = {};
      for (const r of rows.filter((x) => x.kind === "freach")) reach[r.subject.slice(`f:${id}:`.length)] = r.n;
      const responses = await db
        .select({ hash: envelopes.hash, at: envelopes.createdAt, readers: envelopes.readers })
        .from(envelopes)
        .where(and(eq(envelopes.owner, owner), eq(envelopes.ref, `form:${id}`)))
        .orderBy(desc(envelopes.createdAt));
      const submissions = get("fsubmit");
      return {
        views: get("fview"),
        starts: get("fstart"),
        submissions,
        secondsTotal: get("ftime"),
        reach,
        responses: responses.map((r) => ({ hash: r.hash, at: r.at.toISOString(), readers: r.readers })),
      };
    });

    /** What a respondent's browser needs: the signed definition. */
    /** A form's signed definition by id: the question labels for a reader opening answers (a pass holder). */
    app.get("/forms/id/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return fail(reply, 404, "NOT_FOUND", "No such form.");
      const [f] = await db.select({ record: forms.record }).from(forms).where(eq(forms.id, id));
      if (!f?.record) return fail(reply, 404, "NOT_FOUND", "No such form.");
      return { record: f.record };
    });

    app.get("/forms/:name/:slug", async (req, reply) => {
      const { name, slug } = req.params as { name: string; slug: string };
      const [n] = await db
        .select({ address: names.address })
        .from(names)
        .where(eq(names.name, normalizeNameInput(name)));
      if (!n) return fail(reply, 404, "NOT_FOUND", "This form isn't available.");
      const [f] = await db
        .select()
        .from(forms)
        .where(and(eq(forms.owner, n.address), eq(forms.slug, slug)));
      if (!f?.record || f.archived) return fail(reply, 404, "NOT_FOUND", "This form isn't available.");
      const rec = f.record as Signed<FormDef>;
      const refusal = await formRefusal(db, f.owner, `form:${f.id}`);
      return { record: rec, open: refusal === null, closedReason: refusal };
    });

    /** Respondent events: view, start, reach a question, submit (with seconds taken). No content. */
    app.post(
      "/forms/:id/event",
      { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        const b = z
          .object({
            kind: z.enum(["view", "start", "reach", "submit"]),
            q: z.string().regex(ID).optional(),
            seconds: z.number().int().min(0).max(86400).optional(),
          })
          .safeParse(req.body);
        if (!ID.test(id) || !b.success) return fail(reply, 400, "BAD_REQUEST", "Nothing was counted.");
        const [f] = await db.select({ owner: forms.owner, record: forms.record }).from(forms).where(eq(forms.id, id));
        if (!f?.record) return { ok: false };
        const def = (f.record as Signed<FormDef>).body;
        if (b.data.kind === "reach") {
          if (!b.data.q || !def.blocks.some((x) => x.id === b.data.q && isQuestion(x))) return { ok: false };
          await bump(db, f.owner, "freach", `f:${id}:${b.data.q}`);
        } else {
          await bump(db, f.owner, `f${b.data.kind}`, `f:${id}`);
          if (b.data.kind === "submit" && b.data.seconds) await bump(db, f.owner, "ftime", `f:${id}`, b.data.seconds);
        }
        return { ok: true };
      },
    );

    done();
  };
