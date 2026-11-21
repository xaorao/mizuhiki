/** How each kind of received item is counted in words: [one, many]. Shared by My page and Insights. */
const KIND_WORDS: Record<string, [string, string]> = {
  message: ["message", "messages"],
  filedrop: ["file upload", "file uploads"],
  reply: ["reply", "replies"],
  paynote: ["payment note", "payment notes"],
  form: ["form answer", "form answers"],
  order: ["order", "orders"],
  invoice: ["invoice", "invoices"],
  request: ["request", "requests"],
};

export const kindWords = (k: string, n: number): string => {
  const w = KIND_WORDS[k];
  return `${n} ${w ? w[n === 1 ? 0 : 1] : k}`;
};

/** "455 messages, 120 payment notes, 3 more kinds": the largest kinds first, at most three named. */
export function kindsLine(byKind: Record<string, number>, max = 3): string {
  const rows = Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  const named = rows.slice(0, max).map(([k, n]) => kindWords(k, n));
  const rest = rows.slice(max).reduce((t, [, n]) => t + n, 0);
  return [...named, ...(rest ? [`${rest} other`] : [])].join(", ");
}
