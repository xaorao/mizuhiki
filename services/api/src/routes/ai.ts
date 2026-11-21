/**
 * "Write my bio" (spec 5.2 step 5): an AI draft of the PUBLIC bio only. The
 * request carries what the owner typed for their public profile and nothing
 * sealed. Runs only when the server has Anthropic credentials (ANTHROPIC_API_KEY);
 * otherwise /ai/status says it is off and the app hides the button.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { sessionAddress } from "../lib/auth";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Ctx } from "../server";
import { fail } from "../lib/http";

const MODEL = "claude-opus-5-5";
const Body = z.object({
  displayName: z.string().trim().max(60).default(""),
  goal: z.enum(["creator", "business", "personal", "team"]).default("creator"),
  offers: z.array(z.string().max(40)).max(8).default([]),
  draft: z.string().trim().max(400).default(""),
});

const SYSTEM = `You write the short public bio for someone's Mizuhiki page (a link page where people pay them and send them private messages and files).
Write one or two plain sentences in English, at most 150 characters in total. Use what the person told you; do not invent facts, awards, numbers or locations they did not give.
No emoji, no hashtags, no quotation marks, no exclamation marks. Reply with the bio text only.`;

const FORM_KINDS = [
  "short",
  "long",
  "choice",
  "checkboxes",
  "dropdown",
  "yesno",
  "rating",
  "scale",
  "number",
  "email",
  "phone",
  "link",
  "date",
  "file",
  "signature",
  "wallet",
] as const;
const FormDraft = z.object({
  title: z.string().max(200),
  description: z.string().max(400),
  questions: z
    .array(
      z.object({
        kind: z.enum(FORM_KINDS),
        title: z.string().max(300),
        required: z.boolean(),
        choices: z.array(z.string().max(120)).max(12),
      }),
    )
    .max(20),
});

const FORM_SYSTEM = `You draft the questions for a form on Mizuhiki, where answers are encrypted to the form owner.
Write 3 to 12 clear questions in plain, warm English, in a sensible order, using the best kind for each:
short, long, choice (pick one), checkboxes (pick several), dropdown (long lists), yesno, rating, scale, number, email, phone, link, date, file (uploads), signature, wallet (a QoreChain address).
Give choices only for choice, checkboxes and dropdown (2 to 8 each); leave choices empty otherwise.
Mark a question required only when the form cannot work without it. Never ask for passwords, recovery phrases or private keys.
The title is short; the description is one sentence telling respondents what the form is for.`;

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}

export const aiRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    app.get("/ai/status", () => ({ bio: aiEnabled(), form: aiEnabled() }));

    /**
     * "Describe your form" (spec 5.9): drafts the QUESTIONS only. Questions are
     * public by design; no answer, file or sealed item is ever sent here.
     * Signed-in owners only, bounded per hour.
     */
    app.post("/ai/form", { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } }, async (req, reply) => {
      if (!(await sessionAddress(ctx.db, req)))
        return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      if (!aiEnabled())
        return fail(
          reply,
          503,
          "AI_OFF",
          "The form helper is not switched on for this server. Start from a template instead.",
        );
      const b = z.object({ description: z.string().trim().min(10).max(600) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Describe the form in a sentence or two.");
      const client = new Anthropic();
      try {
        const msg = await client.beta.messages.parse({
          model: MODEL,
          max_tokens: 16000,
          output_config: { effort: "low", format: betaZodOutputFormat(FormDraft) },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: FORM_SYSTEM,
          messages: [{ role: "user", content: b.data.description }],
        });
        if (msg.stop_reason === "refusal")
          return await fail(
            reply,
            422,
            "AI_DECLINED",
            "The helper could not draft this one. Start from a template instead.",
          );
        const out = msg.parsed_output;
        if (!out || out.questions.length === 0)
          return await fail(reply, 502, "AI_EMPTY", "The helper returned no questions. Try describing it differently.");
        return out;
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError)
          return fail(reply, 429, "AI_BUSY", "The helper is busy. Try again in a minute.");
        if (e instanceof Anthropic.AuthenticationError)
          return fail(reply, 503, "AI_OFF", "The form helper is not switched on for this server.");
        if (e instanceof Anthropic.APIError)
          return fail(reply, 502, "AI_ERROR", "The helper did not answer. Nothing was created.");
        throw e;
      }
    });

    app.post("/ai/bio", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
      // No session needed: the bio step comes before the account's keys exist on chain.
      // Abuse is bounded by the per-IP rate limit and the short input and output.
      if (!aiEnabled())
        return fail(
          reply,
          503,
          "AI_OFF",
          "The bio helper is not switched on for this server. Write a line or two yourself.",
        );
      const b = Body.safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Nothing was sent.", "nothing-stored");
      const { displayName, goal, offers, draft } = b.data;
      const client = new Anthropic();
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 2000,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: SYSTEM,
          messages: [
            {
              role: "user",
              content: `Name: ${displayName || "(not given)"}\nPage is for: ${goal}\nThey offer: ${offers.join(", ") || "(not given)"}\nTheir own words: ${draft || "(none)"}`,
            },
          ],
        });
      } catch (e) {
        if (e instanceof Anthropic.RateLimitError)
          return fail(reply, 429, "AI_BUSY", "The helper is busy. Try again in a minute.");
        if (e instanceof Anthropic.AuthenticationError)
          return fail(reply, 503, "AI_OFF", "The bio helper is not switched on for this server.");
        if (e instanceof Anthropic.APIError)
          return fail(reply, 502, "AI_ERROR", "The helper did not answer. Your bio was not changed.");
        throw e;
      }
      if (msg.stop_reason === "refusal")
        return fail(reply, 422, "AI_DECLINED", "The helper could not write this one. Try your own words.");
      const text = msg.content
        .filter((c): c is Anthropic.Beta.BetaTextBlock => c.type === "text")
        .map((c) => c.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/^["']|["']$/g, "")
        .trim();
      if (!text) return fail(reply, 502, "AI_EMPTY", "The helper returned nothing. Try again or write your own.");
      return { bio: text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, "")}…` : text };
    });
    done();
  };
