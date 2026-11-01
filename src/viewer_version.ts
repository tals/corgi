export const version = 3;
export function compatible(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as any).viewer_protocol === version;
}
export function require(value: unknown): void {
  if (!compatible(value)) throw new Error("IncompatibleViewerProtocol");
}
