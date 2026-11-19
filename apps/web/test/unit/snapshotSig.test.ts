import { describe, expect, it } from "vitest";
import { deriveAccount, newPhrase, signRecord } from "@mizuhiki/core";
import { SnapshotMetaSchema, snapshotSignedBy, type SnapshotMeta } from "../../src/forms/results/snapshotSig";

const owner = deriveAccount(newPhrase());
const other = deriveAccount(newPhrase());
const HASH = "ab".repeat(32);
const FORM = "fAbc123";

const meta = (signer = owner, body = { formId: FORM, envelope: HASH }): SnapshotMeta =>
  SnapshotMetaSchema.parse({
    owner: owner.address.bech32,
    ownerName: "aria",
    formId: FORM,
    title: "Client intake",
    sig: signRecord({
      kind: "snapshot",
      body,
      signer: signer.address.bech32,
      classical: signer.classical,
      pq: signer.pq,
    }),
    createdAt: new Date().toISOString(),
  });
const key = (k = owner, extra: Partial<{ registered: boolean; possessionProven: boolean }> = {}) => ({
  registered: true,
  possessionProven: true,
  publicKey: k.pq.publicKey,
  ...extra,
});

describe("snapshot signature check", () => {
  it("accepts the owner's signature over this copy and this form", () => {
    expect(snapshotSignedBy({ meta: meta(), hash: HASH, formId: FORM, key: key() })).toBe(true);
  });
  it("refuses another copy, another form, another key or an unproven key", () => {
    expect(snapshotSignedBy({ meta: meta(), hash: "cd".repeat(32), formId: FORM, key: key() })).toBe(false);
    expect(snapshotSignedBy({ meta: meta(), hash: HASH, formId: "fOther", key: key() })).toBe(false);
    expect(snapshotSignedBy({ meta: meta(), hash: HASH, formId: FORM, key: key(other) })).toBe(false);
    expect(
      snapshotSignedBy({ meta: meta(), hash: HASH, formId: FORM, key: key(owner, { possessionProven: false }) }),
    ).toBe(false);
    expect(snapshotSignedBy({ meta: meta(), hash: HASH, formId: FORM, key: key(owner, { registered: false }) })).toBe(
      false,
    );
  });
  it("refuses a signature by someone else, or over another form id", () => {
    expect(snapshotSignedBy({ meta: meta(other), hash: HASH, formId: FORM, key: key(other) })).toBe(false);
    const m = meta(owner, { formId: "fOther", envelope: HASH });
    expect(snapshotSignedBy({ meta: m, hash: HASH, formId: FORM, key: key() })).toBe(false);
    const tampered = { ...meta(), sig: { ...meta().sig, body: { formId: FORM, envelope: "cd".repeat(32) } } };
    expect(snapshotSignedBy({ meta: tampered, hash: "cd".repeat(32), formId: FORM, key: key() })).toBe(false);
  });
});
