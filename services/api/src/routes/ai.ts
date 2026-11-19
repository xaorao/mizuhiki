/**
 * "Write my bio" (spec 5.2 step 5): an AI draft of the PUBLIC bio only. The
 * request carries what the owner typed for their public profile and nothing
 * sealed. Runs only when the server has Anthropic credentials (ANTHROPIC_API_KEY);
 * otherwise /ai/status says it is off and the app hides the button.
 */
import Anthropic from "@anthropic-ai/sdk";
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

export function aiEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
}

export const aiRoutes =
  (_ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    app.get("/ai/status", () => ({ bio: aiEnabled() }));

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
