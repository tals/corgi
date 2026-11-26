/**
 * Points scripts/ghostty-host at a published ghostty-host build: its version,
 * and each platform's checksum from that version's SHA256SUMS. Run it after
 * publishing a build from github.com/tals/ghostty's corgi branch, and commit
 * the result:
 *
 *   bun scripts/pin_ghostty_host.ts VERSION
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const script = join(import.meta.dir, "ghostty-host");
const version = process.argv[2];
if (!version || !/^[\w.+-]+$/.test(version)) {
  console.error("usage: bun scripts/pin_ghostty_host.ts VERSION");
  process.exit(2);
}
const base = `https://corgi.computer/ghostty-host/${version}`;
const listing = await fetch(`${base}/SHA256SUMS`, { cache: "no-store" });
if (!listing.ok) throw Error(`${base}/SHA256SUMS: HTTP ${listing.status}`);
const sums = new Map<string, string>();
for (const line of (await listing.text()).split("\n")) {
  const match = /^([0-9a-f]{64}) {2}ghostty-host-(.+)\.tar\.gz$/.exec(line.trim());
  if (match?.[2].startsWith(`${version}-`)) sums.set(match[2].slice(version.length + 1), match[1]);
}

let text = readFileSync(script, "utf8").replace(/^version=.*$/m, `version=${version}`);
// Every platform the script pins needs a build in this version.
for (const [, target] of text.matchAll(/^ {4}([a-z]+-[a-z0-9_]+)\) sum=/gm)) {
  const sum = sums.get(target);
  if (!sum) throw Error(`${version} has no ${target} build`);
  const archive = await fetch(`${base}/ghostty-host-${version}-${target}.tar.gz`, { method: "HEAD" });
  if (!archive.ok) throw Error(`${version}'s ${target} build: HTTP ${archive.status}`);
  text = text.replace(new RegExp(`^( {4}${target}\\) sum=)[0-9a-f]*`, "m"), `$1${sum}`);
  console.log(`${target}  ${sum}`);
}
writeFileSync(script, text);
console.log(`scripts/ghostty-host now pins ${version}`);
