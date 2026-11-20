/**
 * Every PDF the app makes, loaded on demand. The PDF library and its fonts are about 400 KB; reached through
 * these wrappers they download when someone asks for a PDF, not with every page that has the button.
 */
type Fn<M, K extends keyof M> = M[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
type SpareKey = typeof import("./sparekey");
type Invoice = typeof import("../invoices/pdf");
type Results = typeof import("../forms/results/pdf");
type BuyerKey = typeof import("../shop/buyer/buyerKeySheet");

export const buildSpareKeySheet: Fn<SpareKey, "buildSpareKeySheet"> = async (...a) =>
  (await import("./sparekey")).buildSpareKeySheet(...a);
export const invoicePdf: Fn<Invoice, "invoicePdf"> = async (...a) => (await import("../invoices/pdf")).invoicePdf(...a);
export const resultsPdf: Fn<Results, "resultsPdf"> = async (...a) =>
  (await import("../forms/results/pdf")).resultsPdf(...a);
export const buildBuyerKeySheet: Fn<BuyerKey, "buildBuyerKeySheet"> = async (...a) =>
  (await import("../shop/buyer/buyerKeySheet")).buildBuyerKeySheet(...a);
