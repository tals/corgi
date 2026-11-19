//! The release lines an installation follows, as `corgi update --channel`
//! chooses and the publisher advances.

export const all = ["stable", "test"] as const;
export type Channel = (typeof all)[number];
export const parse = (name: string): Channel | null => all.find(c => c === name) ?? null;
