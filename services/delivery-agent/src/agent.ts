/**
 * The opt-in "Instant delivery" helper (spec 5.11, ARCHITECTURE 2.7 and 8b).
 *
 * It holds one account of its own. For products whose seller chose Instant
 * delivery, the product key is sealed to this account; when an order for such
 * a product is fully paid, the helper checks the payment on QoreChain itself,
 * recomputes the order reference, reads the buyer's key, and seals the product
 * keys to the buyer. It never sees anything the seller did not choose to give it.
 */
import { signSiwq } from "@qorechain/qoresign";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { DeliveryRefused, pqKeyViaEvm, prepareDelivery } from "@mizuhiki/chain";
import {
  ProductDefSchema,
  Purpose,
  deriveAccount,
  fromBase64Url,
  fromUtf8,
  openItem,
  verifyRecord,
  type AccountKeys,
  type Discount,
  type OrderRequest,
  type ProductDef,
  type RecipientCard,
  type Signed,
} from "@mizuhiki/core";

export interface AgentOrder {
  ref: string;
  seller: string;
  request: OrderRequest;
  records: Signed<ProductDef>[];
  token: string;
  depositTx: string | null;
  balanceTx: string | null;
}

export interface AgentConfig {
  api: string;
  phrase: string;
  log?: (line: string) => void;
}

export class DeliveryAgent {
  readonly keys: AccountKeys;
  private token: string | null = null;
  private readonly api: string;
  private readonly log: (line: string) => void;
  /** Orders this helper refused, with why, so the same refusal is not retried every pass. */
  private readonly refused = new Map<string, string>();

  constructor(cfg: AgentConfig) {
    this.keys = deriveAccount(cfg.phrase);
    this.api = cfg.api.replace(/\/$/, "");
    this.log = cfg.log ?? ((l) => console.log(l));
  }

  get address(): string {
    return this.keys.address.bech32;
  }

  private async call<T>(
    path: string,
    init: { method?: string; body?: unknown; bytes?: Uint8Array; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (init.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    let body: BodyInit | undefined;
    if (init.bytes) {
      headers["content-type"] = "application/octet-stream";
      body = new Blob([init.bytes as Uint8Array<ArrayBuffer>]);
    } else if (init.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const r = await fetch(`${this.api}${path}`, { method: init.method ?? "GET", headers, ...(body ? { body } : {}) });
    if (r.status === 401 && init.auth !== false && this.token) {
      this.token = null;
      await this.signIn();
      return this.call(path, init);
    }
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(j.error?.message ?? `${path} answered ${r.status}`);
    }
    return (await r.json()) as T;
  }

  private async bytes(path: string): Promise<Uint8Array> {
    const r = await fetch(`${this.api}${path}`);
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Sign In With QoreChain, with this helper's own keys. */
  async signIn(): Promise<void> {
    const ch = await this.call<{ message: string; nonce: string }>("/auth/challenge", {
      method: "POST",
      body: { address: this.address },
      auth: false,
    });
    const signature = signSiwq({ message: ch.message, classicalKey: this.keys.classical, pqKey: this.keys.pq });
    this.token = (
      await this.call<{ token: string }>("/auth/verify", {
        method: "POST",
        body: { nonce: ch.nonce, signature },
        auth: false,
      })
    ).token;
  }

  private readonly cardOf = async (address: string): Promise<RecipientCard> =>
    (await this.call<{ card: RecipientCard }>(`/cards/${address}`, { auth: false })).card;

  /** A product record checked against its seller's key on QoreChain. */
  private async verified(record: Signed<ProductDef>): Promise<ProductDef> {
    const pq = await pqKeyViaEvm(record.signer);
    if (!pq.registered || !pq.publicKey || !pq.possessionProven)
      throw new DeliveryRefused("The seller's key is not on QoreChain.");
    const def = ProductDefSchema.parse(
      verifyRecord(record, { kind: "product", signer: record.signer, pqPublicKey: pq.publicKey }),
    );
    if (def.owner !== record.signer) throw new DeliveryRefused("A product is signed by someone other than its seller.");
    return def;
  }

  private openAgentKey(
    productId: string,
    envelope: Uint8Array,
    seal: SealKeyPair,
  ): { key: Uint8Array; content: string | null } {
    const j = JSON.parse(
      fromUtf8(openItem({ purpose: Purpose.product(productId), envelope, keys: seal, context: "agent" })),
    ) as { key: string; content: string | null };
    return { key: fromBase64Url(j.key), content: j.content };
  }

  /** One pass: deliver every paid order this helper is allowed to. Returns refs delivered. */
  async pass(): Promise<string[]> {
    if (!this.token) await this.signIn();
    const r = await this.call<{
      orders: AgentOrder[];
      products: { id: string; record: Signed<ProductDef>; agentEnvelope: string | null }[];
    }>("/agent/orders");
    const keys = new Map<string, { key: Uint8Array; content: string | null }>();
    for (const p of r.products) {
      if (!p.agentEnvelope) continue;
      try {
        keys.set(p.id, this.openAgentKey(p.id, await this.bytes(`/blobs/${p.agentEnvelope}`), this.keys.seal));
      } catch {
        // Sealed to another helper key, or damaged: that product cannot be delivered from here.
      }
    }
    const done: string[] = [];
    for (const o of r.orders) {
      if (this.refused.has(o.ref)) continue;
      try {
        const products: ProductDef[] = [];
        for (const rec of o.records) {
          const def = await this.verified(rec);
          if (def.owner !== o.seller || def.delivery !== "instant" || def.agent !== this.address)
            throw new DeliveryRefused(`“${def.title}” is not set to Instant delivery by this helper.`);
          products.push(def);
        }
        let discount: Discount | null = null;
        if (o.request.discountCode) {
          // The helper cannot see the seller's codes; it asks the same public check the buyer's checkout used.
          discount = (
            await this.call<{ discount: Discount }>("/discounts/check", {
              method: "POST",
              body: { seller: o.seller, code: o.request.discountCode, token: o.request.token },
              auth: false,
            })
          ).discount;
        }
        // Each key goes out with the content of the record the buyer bought.
        const forOrder = new Map(
          [...keys].map(([id, k]) => [
            id,
            { key: k.key, content: products.find((p) => p.id === id)?.content ?? k.content },
          ]),
        );
        const { envelope } = await prepareDelivery({
          order: o,
          products,
          keys: forOrder,
          discount,
          cardOf: this.cardOf,
          current: r.products.map((p) => p.record.body),
        });
        const up = await this.call<{ hash: string }>("/blobs", { method: "PUT", bytes: envelope });
        await this.call(`/orders/${o.ref}/deliver`, { method: "POST", body: { envelope: up.hash } });
        done.push(o.ref);
        this.log(`delivered ${o.ref}`);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (e instanceof DeliveryRefused) this.refused.set(o.ref, why);
        this.log(`not delivered ${o.ref}: ${why}`);
      }
    }
    return done;
  }
}
