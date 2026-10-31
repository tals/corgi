export interface Config {
  autoreload: boolean;
  enabled: Record<string, boolean>;
}
export interface Status {
  id: string;
  path: string;
  enabled: boolean;
  running: boolean;
  error: string | null;
}
export interface Info {
  directory: string;
  autoreload: boolean;
  watch_error: string | null;
  tricks: Status[];
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function config(value: unknown): Config {
  const raw = object(value);
  return {
    autoreload: raw.autoreload !== false,
    enabled: Object.fromEntries(
      Object.entries(object(raw.enabled)).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    ),
  };
}
export function info(value: unknown): Info {
  const raw = object(value);
  return {
    directory: typeof raw.directory === "string" ? raw.directory : "",
    autoreload: raw.autoreload !== false,
    watch_error: typeof raw.watch_error === "string" ? raw.watch_error : null,
    tricks: (Array.isArray(raw.tricks) ? raw.tricks : []).slice(0, 16).map(value => {
      const row = object(value);
      return {
        id: typeof row.id === "string" ? row.id : "",
        path: typeof row.path === "string" ? row.path : "",
        enabled: row.enabled !== false,
        running: row.running === true,
        error: typeof row.error === "string" ? row.error : null,
      };
    }),
  };
}
