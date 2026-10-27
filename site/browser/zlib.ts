/**
 * node:zlib on the landing page. The sidebar encodes Kitty images of
 * gliding rows and forks with it; the page draws neither, only the worktree
 * overview that imports the sidebar. package.json's "browser" field puts
 * this in place of node:zlib.
 */
export function deflateSync(_data: Uint8Array, _options?: { level?: number }): never {
  throw Error("Unsupported");
}
export function crc32(_data: Uint8Array): never {
  throw Error("Unsupported");
}
