/**
 * File requests from the owner's device (spec 5.7, ARCHITECTURE 8g): every
 * create, edit, close and reopen is a new version signed here with the
 * account's ML-DSA key; the API keeps it only if it matches the key on chain.
 * Uploads are opened on this device like any inbox item.
 */
import { FileRequestSchema, newId, signRecord, type FileRequest, type NamingRule } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { pageUrl } from "@/lib/site";
import type { RequestRow, UploadRow } from "./model";

export type Tokened = Account & { token: string };
const T = (a: Tokened) => ({ token: a.token });

export interface RequestInput {
  title: string;
  description: string;
  deadline: string | null;
  allowLate: boolean;
  naming: NamingRule;
}

async function save(a: Tokened, body: FileRequest): Promise<FileRequest> {
  const def = FileRequestSchema.parse(body);
  const record = signRecord({
    kind: "filerequest",
    body: def,
    signer: a.owner.address,
    classical: a.keys.classical,
    pq: a.keys.pq,
  });
  await api.put("/owner/file-requests", { record }, T(a));
  return def;
}

export function createRequest(a: Tokened, input: RequestInput): Promise<FileRequest> {
  return save(a, {
    v: 1,
    id: `freq_${newId(14)}`,
    owner: a.owner.address,
    title: input.title.trim(),
    description: input.description.trim(),
    deadline: input.deadline,
    allowLate: input.deadline ? input.allowLate : false,
    naming: input.naming,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    status: "open",
    version: 1,
    updatedAt: new Date().toISOString(),
  });
}

/** A new signed version: edited fields, or closed / reopened (Dropbox's Close request and Reactivate). */
export function updateRequest(
  a: Tokened,
  current: FileRequest,
  patch: Partial<RequestInput & { status: "open" | "closed" }>,
): Promise<FileRequest> {
  const next: FileRequest = {
    ...current,
    ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
    ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
    ...(patch.deadline !== undefined
      ? { deadline: patch.deadline, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      : {}),
    ...(patch.allowLate !== undefined ? { allowLate: patch.allowLate } : {}),
    ...(patch.naming !== undefined ? { naming: patch.naming } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    version: current.version + 1,
    updatedAt: new Date().toISOString(),
  };
  if (!next.deadline) next.allowLate = false;
  return save(a, next);
}

export const listRequests = (a: Tokened) => api.get<{ requests: RequestRow[] }>("/owner/file-requests", T(a));
export const getRequest = (a: Tokened, id: string) =>
  api.get<{ record: RequestRow["record"]; createdAt: string; uploads: UploadRow[] }>(
    `/owner/file-requests/${encodeURIComponent(id)}`,
    T(a),
  );
export const deleteRequest = (a: Tokened, id: string) =>
  api.del(`/owner/file-requests/${encodeURIComponent(id)}`, T(a));

export const requestLink = (name: string, id: string) => `${pageUrl(name)}/r/${id}`;
