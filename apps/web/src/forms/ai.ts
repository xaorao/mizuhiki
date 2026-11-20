/** "Describe your form": an AI draft of the questions only (questions are public; answers never go there). */
import type { FormBlock, FormDef, QuestionKind } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { blankBlock, newForm, newId } from "./model";
import { failureText } from "@/lib/failure";

interface Draft {
  title: string;
  description: string;
  questions: { kind: QuestionKind; title: string; required: boolean; choices: string[] }[];
}

export async function draftFromDescription(
  account: Account,
  name: string,
  description: string,
  token: string,
): Promise<FormDef> {
  let d: Draft;
  try {
    d = await api.post<Draft>("/ai/form", { description }, { token });
  } catch (e) {
    throw new Error(failureText(e, "The helper did not answer. Nothing was created."), {
      cause: e,
    });
  }
  const def = newForm(account, name, d.title || "Untitled form");
  def.description = d.description;
  def.blocks = d.questions.map((q): FormBlock => {
    const b = blankBlock(q.kind) as Extract<FormBlock, { title: string }> & { required?: boolean };
    const withChoices =
      "choices" in b && q.choices.length >= 1
        ? { choices: q.choices.map((label) => ({ id: `c${newId(5)}`, label: label.slice(0, 200) })) }
        : {};
    return {
      ...b,
      title: q.title.slice(0, 500),
      ...("required" in b ? { required: q.required } : {}),
      ...withChoices,
    };
  });
  return def;
}
