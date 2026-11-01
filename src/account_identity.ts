/** Public account metadata. IDs are opaque and never contain credentials. */
export interface Identity {
  id: string;
  name: string;
  directory: string | null;
}

export function read(value: unknown): Identity | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id || v.id.length > 4096 || /[\x00-\x1f\x7f]/.test(v.id)) return null;
  if (typeof v.name !== "string" || v.name.length > 160 || /[\x00-\x1f\x7f]/.test(v.name)) return null;
  if (v.directory !== null && (typeof v.directory !== "string" || !v.directory.startsWith("/"))) return null;
  return { id: v.id, name: v.name, directory: v.directory };
}
