export const enabled = false;
export function begin(): number {
  return 0;
}
export function count(_name: string): void {}
export function end(_name: string, _start: number, _bytes = 0): void {}
export function flush(): void {}
export function attach(_worker: unknown): void {}
export function detach(_worker: unknown): void {}
export function native(_request: object, _start: number, _bytes: number): void {}
