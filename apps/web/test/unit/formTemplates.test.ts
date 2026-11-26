import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@/forms/model";

describe("form templates", () => {
  it("ship real answer choices, never the blank 'Choice 1' placeholders", () => {
    for (const t of TEMPLATES)
      for (const [kind, title, extra] of t.blocks) {
        if (kind !== "choice" && kind !== "checkboxes" && kind !== "dropdown") continue;
        const labels = ((extra as { choices?: { label: string }[] } | undefined)?.choices ?? []).map((c) => c.label);
        expect(labels.length, `${t.title}: ${title}`).toBeGreaterThan(1);
        for (const l of labels) expect(l, `${t.title}: ${title}`).not.toMatch(/^Choice \d+$/);
      }
  });
});
