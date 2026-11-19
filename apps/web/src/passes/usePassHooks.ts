"use client";
/**
 * The parts of the product a pass touches, connected with the same code their
 * own screens use: the page (pass keys), rooms (a read-only member), forms (a
 * reader) and products (the product key).
 */
import { useCallback } from "react";
import { useOwner } from "@/owner/OwnerProvider";
import { changeMembers, nameOf, setRole, withToken } from "@/rooms/engine";
import { setFormReader } from "@/forms/model";
import { listMyProducts, openDraft } from "@/shop/engine";
import type { ConfirmHooks, Tokened } from "./engine";

export function usePassHooks(): () => Promise<{ t: Tokened; hooks: ConfirmHooks }> {
  const owner = useOwner();
  return useCallback(async () => {
    const token = await owner.token();
    const t: Tokened = { ...owner.account, token };
    const readerOf = async (address: string) => {
      const name = await nameOf(address).catch(() => null);
      return { address, name: name ? `@${name}`.slice(0, 40) : `${address.slice(0, 10)}…`, note: "Pass holder" };
    };
    const hooks: ConfirmHooks = {
      publishPassKeys: () => owner.publishPassKeys(),
      addRoomReader: async (roomId, holder) => {
        const r = withToken(owner.account, await owner.token());
        await changeMembers(r, roomId, { add: [{ address: holder, history: "share" }], reason: "pass" });
        // Read-only: no sending, files, adding people, info or pins.
        await setRole(r, roomId, holder, "member", []);
      },
      removeRoomReader: async (roomId, holder) => {
        await changeMembers(withToken(owner.account, await owner.token()), roomId, {
          remove: [{ address: holder, blocked: false }],
          reason: "pass revoked",
        });
      },
      setFormReader: async (formId, holder, on) => {
        await setFormReader(owner.account, await owner.token(), formId, await readerOf(holder), on);
      },
      productKey: async (productId) => {
        const a = { ...owner.account, token: await owner.token() };
        const p = (await listMyProducts(a)).find((x) => x.id === productId);
        if (!p) throw new Error("That product is no longer in your shop.");
        const content = p.status === "published" ? (p.record?.body.content ?? null) : null;
        if (!content) throw new Error("Publish the product with its content first, so there is something to read.");
        const d = await openDraft(owner.account, p);
        return { key: d.key, content };
      },
    };
    return { t, hooks };
  }, [owner]);
}
