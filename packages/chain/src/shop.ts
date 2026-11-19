/**
 * Delivering a shop order (ARCHITECTURE 8b). Shared by the seller's own device
 * and the opt-in delivery helper. Trusts the server for nothing but a
 * transaction hash: the payment is read from QoreChain here, the order
 * reference is recomputed from the stored request (so a swapped recipient key
 * is caught), and the recipient's key is read from chain before anything is sealed.
 */
import type { SealRecipient } from "@qorechain/qoreseal";
import {
  CHAIN_ID,
  Purpose,
  balanceRef,
  deliveryPayload,
  orderRef,
  orderTotal,
  sealItem,
  type Discount,
  type OrderRequest,
  type ProductDef,
  type RecipientCard,
} from "@mizuhiki/core";
import { DENOMS } from "./config";
import { getTx } from "./rest";
import { resolveOwner } from "./recipients";
import { hexToBytes } from "viem";

export interface DeliverableOrder {
  ref: string;
  seller: string;
  request: OrderRequest;
  token: string;
  depositTx: string | null;
  balanceTx: string | null;
}

export class DeliveryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryRefused";
  }
}

/** The amount of `token` sent to `seller` with memo `mzk:ord:<ref>` in one transaction, and when, read from chain. */
export async function paidOnChain(txHash: string, seller: string, token: "QOR" | "fUSD", ref: string): Promise<{ sum: bigint; at: Date | null }> {
  const t = await getTx(txHash.toUpperCase());
  if (!t || t.code !== 0 || t.tx?.body?.memo?.trim() !== `mzk:ord:${ref}`) return { sum: 0n, at: null };
  const denom = DENOMS[token].denom;
  let sum = 0n;
  for (const m of (t.tx.body.messages ?? []) as { "@type"?: string; to_address?: string; amount?: { denom: string; amount: string }[] }[]) {
    if (m["@type"] !== "/cosmos.bank.v1beta1.MsgSend" || m.to_address !== seller) continue;
    for (const c of m.amount ?? []) if (c.denom === denom) sum += BigInt(c.amount);
  }
  return { sum, at: new Date(t.timestamp) };
}

/** How long an unpaid order may keep the price it was given (the server's hold). */
export const PRICE_HOLD_MS = 60 * 60_000;

export async function recipientOfOrder(req: OrderRequest, cardOf: (address: string) => Promise<RecipientCard>): Promise<SealRecipient> {
  if (req.recipient.kind === "account") return resolveOwner(req.recipient.address, await cardOf(req.recipient.address));
  return { mlkemPublicKey: hexToBytes(`0x${req.recipient.mlkem}`), x25519PublicKey: hexToBytes(`0x${req.recipient.x25519}`) };
}

/**
 * Check everything and seal the product keys to the buyer. Returns the
 * envelope to upload; throws DeliveryRefused with a plain reason otherwise.
 */
export async function prepareDelivery(args: {
  order: DeliverableOrder;
  /** The signed records the order names, already verified against the seller's key. */
  products: ProductDef[];
  /** Product keys this deliverer holds, by product id, with each product's content hash. */
  keys: Map<string, { key: Uint8Array; content: string | null }>;
  discount: Discount | null;
  cardOf: (address: string) => Promise<RecipientCard>;
  /**
   * The current signed records the deliverer knows (its own drafts, or the helper's product list).
   * An order priced with an older version is refused when it was paid more than the price hold after
   * the newer version was published: a server cannot sell at an old, lower price.
   */
  current?: ProductDef[];
}): Promise<{ envelope: Uint8Array }> {
  const { order } = args;
  if (orderRef(order.request) !== order.ref)
    throw new DeliveryRefused("This order's details do not match its reference. Nothing was sealed.");
  if (order.request.seller !== order.seller) throw new DeliveryRefused("This order is for another seller. Nothing was sealed.");
  const token = order.request.token;
  const total = orderTotal(order.request, args.products, args.discount);
  if (!order.depositTx) throw new DeliveryRefused("No payment for this order is known yet.");
  const deposit = await paidOnChain(order.depositTx, order.seller, token, order.ref);
  if (deposit.sum < total.dueNow) throw new DeliveryRefused("QoreChain does not show the full payment for this order. Nothing was sealed.");
  for (const p of args.products) {
    const now = args.current?.find((c) => c.id === p.id);
    if (now && now.version > p.version && deposit.at && deposit.at.getTime() > Date.parse(now.updatedAt) + PRICE_HOLD_MS)
      throw new DeliveryRefused(`This order was priced with an old version of “${p.title}” and paid long after it changed. Nothing was sealed.`);
  }
  if (total.dueLater > 0n) {
    if (!order.balanceTx) throw new DeliveryRefused("The rest of this commission has not been paid yet.");
    const rest = await paidOnChain(order.balanceTx, order.seller, token, balanceRef(order.ref));
    if (rest.sum < total.dueLater) throw new DeliveryRefused("QoreChain does not show the rest of this commission. Nothing was sealed.");
  }
  // Every product in the order, and every product inside a bundle.
  const wanted = new Set<string>();
  for (const line of order.request.lines) {
    wanted.add(line.productId);
    const p = args.products.find((x) => x.id === line.productId);
    for (const part of p?.bundle?.productIds ?? []) wanted.add(part);
  }
  const keys = [...wanted].map((id) => {
    const k = args.keys.get(id);
    if (!k) throw new DeliveryRefused("This device does not hold the key of every product in the order.");
    return { productId: id, key: k.key, content: k.content };
  });
  const recipient = await recipientOfOrder(order.request, args.cardOf);
  const sealed = sealItem({
    chainId: CHAIN_ID,
    purpose: Purpose.order(order.ref),
    readers: [recipient],
    plaintext: deliveryPayload(order.ref, keys),
    anonymous: true,
  });
  return { envelope: sealed.envelope };
}
