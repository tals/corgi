import { Provider, byProvider, type ByProvider } from "../providers";
import type { Launch } from "./row";

/** Discovery and account state shared by the picker, CLI and prompt. */
export type Preview = {
  pending: boolean;
  installed: ByProvider<boolean>;
  configured: ByProvider<boolean>;
  options: ByProvider<{ pending: boolean | null; signed_in: boolean | null }>;
  accounts: readonly (Launch & { option?: { pending: boolean | null; signed_in: boolean | null } })[];
  on_demand?: ByProvider<boolean>;
};
export function available(preview: Preview, provider: Provider): boolean {
  return preview.installed[provider] || preview.on_demand?.[provider] === true;
}
/** A saved account or profile is usable only while its installation is present. */
export function saved(preview: Preview, launch: Launch): boolean {
  return (
    available(preview, launch.provider) &&
    (!launch.account || preview.accounts.some(a => a.provider === launch.provider && a.account === launch.account))
  );
}
/** Named accounts stay listed when signed out; their first discovery still settles first. */
export function account(preview: Preview, launch: Launch, added: readonly string[]): boolean {
  const option = preview.accounts.find(a => a.provider === launch.provider && a.account === launch.account);
  return (
    available(preview, launch.provider) &&
    (added.includes(`${launch.provider}:${launch.account}`) ||
      (!!option && (!(option.option?.pending ?? preview.pending) || option.option?.signed_in != null)))
  );
}
export function defaults(preview: Preview, added: readonly string[], profiles: readonly Launch[]): ByProvider<boolean> {
  const listed = byProvider(p => {
    const option = preview.options[p];
    return (
      available(preview, p) &&
      (added.includes(p) ||
        (option.signed_in !== false &&
          (option.signed_in === true || (preview.configured[p] && !(option.pending ?? preview.pending)))))
    );
  });
  if (
    preview.pending ||
    Provider.all.some(p => listed[p]) ||
    preview.accounts.some(a => saved(preview, a)) ||
    profiles.some(p => saved(preview, p))
  )
    return listed;
  return byProvider(p => listed[p] || (preview.installed[p] && !preview.on_demand?.[p]));
}
