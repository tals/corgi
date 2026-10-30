import type { InferenceModel } from "../providers/adapter";
import type { Info } from "../usage/account";
import { Model } from "../providers/model";
import * as prices from "../usage/prices";

function label(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 160);
}
/** Native catalogs report availability, not prices; known rates are estimates. */
export function options(
  entries: readonly {
    id: string;
    name: string;
    efforts?: InferenceModel["efforts"];
    default_effort?: InferenceModel["default_effort"];
  }[],
  info: Info,
): InferenceModel[] {
  if (info.signed_in !== true) return [];
  const seen = new Set<string>();
  return entries.flatMap(entry => {
    if (!entry.id || /[\s\x00-\x1f\x7f]/.test(entry.id) || Buffer.byteLength(entry.id) > 512 || seen.has(entry.id))
      return [];
    seen.add(entry.id);
    const price = prices.lookup(entry.id),
      name = label(entry.name);
    return [
      {
        id: entry.id,
        ...(entry.default_effort ? { default_effort: entry.default_effort } : {}),
        ...(entry.efforts?.length ? { efforts: entry.efforts } : {}),
        name: name || Model.resolve(entry.id).label(),
        user: label(info.account.text()),
        plan: label(info.plan.text()),
        subscription: info.limits !== "metered",
        input_cost: price ? Number(price.input) / 1000 : null,
        output_cost: price ? Number(price.output) / 1000 : null,
      },
    ];
  });
}
