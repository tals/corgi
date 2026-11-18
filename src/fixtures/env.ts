/** Sets `values` in the environment, an undefined one by removing it, and
 * restores every name it set as it was once disposed. */
export function scopedEnv(values: Record<string, string | undefined>): Disposable {
  const saved = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  assign(values);
  return { [Symbol.dispose]: () => assign(saved) };
}
function assign(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}
