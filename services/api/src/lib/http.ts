import type { FastifyReply } from "fastify";

/** Every error body says what happened to the caller's data first. */
export interface ApiError {
  code: string;
  message: string;
  dataState: "nothing-stored" | "nothing-changed" | "stored" | "unknown";
}

export function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  dataState: ApiError["dataState"] = "nothing-changed",
) {
  return reply.code(status).send({ error: { code, message, dataState } satisfies ApiError });
}

export const isAddress = (s: unknown): s is string => typeof s === "string" && /^qor1[02-9ac-hj-np-z]{38}$/.test(s);
export const isHash = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
