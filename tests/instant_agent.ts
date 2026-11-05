import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeExecutable } from "./support";

/** Replay captured agent screens through a real PTY. No product prediction code is used. */
export function instantAgent(folder: string, redrawEmpty = false): { command: string; log: string } {
  const fixture = JSON.parse(readFileSync(new URL("../src/fixtures/instant-codex.json", import.meta.url), "utf8"));
  const edits = JSON.parse(readFileSync(new URL("../src/fixtures/instant-codex-edits.json", import.meta.url), "utf8"));
  const log = join(folder, "instant-input.log");
  const command = writeExecutable(
    join(folder, "codex"),
    `
import { writeFileSync } from 'node:fs';
const frames = ${JSON.stringify([...edits.cases, ...fixture.cases.map((f: { draft: string }) => ({ ...f, cursor: f.draft.length }))])};
let draft = 'h', cursor = 1, received = '', pending = '', redraw = 0;
process.stdin.setRawMode(true);
function draw() {
  let surface = frames.find(f => f.draft === draft && f.cursor === cursor)?.surface;
  if (!surface && draft.length < 37) {
    surface = structuredClone(frames[0].surface);
    const y = surface.cursor.y;
    surface.lines[y] = '\\x1b[0m› ' + draft.padEnd(38);
    surface.cursor.x = cursor + 2;
  }
  if (!surface) return;
  if (redraw) {
    surface = structuredClone(surface);
    surface.lines[0] = ('clear redraw ' + redraw).padEnd(40);
  }
  let output = '\\x1b[?2026h\\x1b[2J';
  for (let y=0;y<surface.lines.length;y++) output += '\\x1b['+(y+1)+';1H'+surface.lines[y];
  output += '\\x1b['+(surface.cursor.y+1)+';'+(surface.cursor.x+1)+'H\\x1b[?25h\\x1b[?2026l';
  process.stdout.write(output);
}
process.stdin.on('data', data => {
  let cleared = false;
  received += data.toString();
  pending += data.toString();
  while (pending) {
    if (pending[0] === '\\x1b') {
      const match = /^\\x1b(?:\\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(pending);
      if (!match) break;
      switch (match[0]) {
        case '\\x1b[D': case '\\x1bOD': cursor = Math.max(0, cursor - 1); break;
        case '\\x1b[C': case '\\x1bOC': cursor = Math.min(draft.length, cursor + 1); break;
        case '\\x1b[3~': draft = draft.slice(0,cursor) + draft.slice(cursor+1); break;
      }
      pending = pending.slice(match[0].length);
      continue;
    }
    const char = pending[0]; pending = pending.slice(1);
    if (char === '\\x03' || char === '\\x15') {
      draft = char === '\\x15' ? draft.slice(cursor) : ''; cursor = 0; cleared = true;
    }
    else if (char === '\\x7f' && cursor) { draft = draft.slice(0,cursor-1) + draft.slice(cursor); cursor--; }
    else if (char >= ' ' && char <= '~') { draft = draft.slice(0,cursor) + char + draft.slice(cursor); cursor++; }
  }
  writeFileSync(${JSON.stringify(log)}, received);
  draw();
  if (cleared && ${redrawEmpty}) setTimeout(() => {
    if (!draft) { redraw++; draw(); }
  }, 80);
});
process.on('SIGWINCH', draw);
draw();
`,
  );
  return { command, log };
}
