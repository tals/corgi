import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Viewers } from "./viewers";
import { screen_text, type Viewer } from "./runtime";
import { registerCase, shellJoin, writeExecutable } from "./support";

const cols = 120,
  rows = 50;
/** What the last OSC 52 effect in the viewer's last reply copied, if any. */
function copied(state: any): string | null {
  let text: string | null = null;
  for (const effect of state.effects) {
    const data: string | undefined = effect.write_terminal;
    if (data?.includes("\x1b]52;c;"))
      text = Buffer.from(data.split("52;c;", 2)[1].split("\x07", 1)[0], "base64").toString();
  }
  return text;
}
/** The text drawn selected, rows run together: cells from column `left` whose
 * colors are those of the plain cell at `plain`, swapped. */
function highlighted(data: string, left: number, plain: { x: number; y: number }): string {
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ char: " ", fg: "", bg: "" })));
  let x = 0,
    y = 0,
    i = 0,
    fg = "",
    bg = "",
    saved = [0, 0];
  while (i < data.length) {
    if (data.startsWith("\x1b7", i) || data.startsWith("\x1b8", i)) {
      if (data[i + 1] === "7") saved = [x, y];
      else [x, y] = saved;
      i += 2;
      continue;
    }
    if (data.startsWith("\x1b]", i)) {
      i += /^\x1b\].*?(?:\x07|\x1b\\)/s.exec(data.slice(i))![0].length;
      continue;
    }
    if (data[i] === "\x1b") {
      const [match, args, kind] = /^\x1b\[([0-9;:?]*)([@-~])/.exec(data.slice(i))!;
      if (kind === "H" || kind === "f") {
        const values = args.split(";").map(v => Number(v || 1));
        y = values[0] - 1;
        x = (values[1] ?? 1) - 1;
      } else if (kind === "m") {
        const params = args.split(";");
        if (params[0] === "" || params[0] === "0") fg = bg = "";
        for (let k = 0; k < params.length; k++) {
          if (params[k + 1] !== "2" || (params[k] !== "38" && params[k] !== "48")) continue;
          const color = params.slice(k + 2, k + 5).join(";");
          if (params[k] === "38") fg = color;
          else bg = color;
          k += 4;
        }
      }
      i += match.length;
      continue;
    }
    const char = String.fromCodePoint(data.codePointAt(i)!);
    if (char === "\r") x = 0;
    else if (char === "\n") y++;
    else if (char >= " ") {
      const width = /\p{Mark}/u.test(char) ? 0 : Bun.stringWidth(char);
      if (x >= 0 && x < cols && y >= 0 && y < rows) grid[y][x] = { char, fg, bg };
      // A wide character's second cell adds no text.
      if (width === 2 && x + 1 < cols && y >= 0 && y < rows) grid[y][x + 1] = { char: "", fg, bg };
      x += width;
    }
    i += char.length;
  }
  const ref = grid[plain.y][plain.x];
  return grid
    .flatMap(row => row.slice(left).filter(cell => cell.fg === ref.bg && cell.bg === ref.fg))
    .map(cell => cell.char)
    .join("");
}
/** `count` presses and releases on one screen cell within the double-click
 * window, since the viewer's clock only moves when advanced. */
function clicks(viewer: Viewer, x: number, y: number, count: number, button = 0) {
  const at = `${button};${x + 1};${y + 1}`;
  return viewer.input(`\x1b[<${at}M\x1b[<${at}m`.repeat(count));
}
function doubleClick(viewer: Viewer, x: number, y: number, button = 0) {
  return clicks(viewer, x, y, 2, button);
}

class Selection extends Viewers {
  /** A shell pane showing `lines` (for its width) below a marker on its top
   * row, in a cols × rows viewer, and where the pane's first cell is on screen. */
  async shown(lines: (width: number) => string[]) {
    const pane = await this.new("exec /bin/sh");
    const viewer = await this.newViewer(cols, rows);
    await viewer.focus(pane);
    // Sized for this viewer, not the daemon's default.
    await this.until(async () => (await this.geometry())[pane]?.[1] > 30);
    const [width] = (await this.geometry())[pane];
    const file = join(this.temp.name, `lines-${pane}.txt`);
    writeFileSync(file, ["MARKER_TOP", ...lines(width)].join("\n"));
    await this.command("pane.input", { target: pane, data: `printf '\\033[H\\033[2J'; cat ${file}; echo\n` });
    let screen: string[] = [];
    await this.until(async () => {
      screen = screen_text((await viewer.poll()).data, cols, rows);
      return screen.some(row => row.includes("MARKER_TOP")) && screen.some(row => row.includes("MARKER_END"));
    });
    const top = screen.findIndex(row => row.includes("MARKER_TOP"));
    return { pane, viewer, width, origin: { x: screen[top].indexOf("MARKER_TOP"), y: top } };
  }

  async test_double_click_copies_the_word_under_the_pointer() {
    // Each line, where on it to double-click, and what that copies.
    const cases: [string, string, string][] = [
      ["open src/pane/terminal.ts now", "pane", "src/pane/terminal.ts"],
      ["commit 2ff6e18 landed", "2ff6e18", "2ff6e18"],
      ["see terminal.ts:42 here", "42", "terminal.ts:42"],
      ["error at terminal.ts:42:7", "terminal", "terminal.ts:42:7"],
      ["listening on localhost:8080", "8080", "localhost:8080"],
      ["edit src/a.ts.", "a.ts", "src/a.ts"],
      ["foo... then", "foo", "foo"],
      ["it is ok!", "ok", "ok"],
      ["but why?", "why", "why"],
      ['call ("src/b.ts") now', "b.ts", "src/b.ts"],
      ["range [x/y] here", "x/y", "x/y"],
      ["pipe a|b here", "a|", "a"],
      ["env $HOME set", "HOME", "HOME"],
      ["semi x;y end", "x;", "x"],
      ["list a,b end", "a,", "a"],
      ["tag <tag> end", "tag>", "tag"],
      ["run `cmd` now", "cmd", "cmd"],
      ["ident my_var-name2 ok", "var", "my_var-name2"],
      ["wide 日本/ファイル.ts ok", "ファ", "日本/ファイル.ts"],
      ["quote 'single.txt' ok", "single", "single.txt"],
      ["hash 0123456789abcdef0123456789abcdef01234567 ok", "89ab", "0123456789abcdef0123456789abcdef01234567"],
      ["path ./build/out.o, next", "build", "./build/out.o"],
      ["url https://example.com/a/b?q=1 ok", "example", "https://example.com/a/b?q=1"],
      ["hardend", "end", "hardend"],
      ["nextline", "next", "nextline"],
    ];
    const { viewer, width, origin } = await this.shown(width => [
      ...cases.map(([line]) => line),
      "wrap".padEnd(width - 6) + "wrapped/long/token.ts",
      "MARKER_END",
    ]);
    const plain = { x: origin.x, y: origin.y };
    for (const [row, [line, at, expected]] of cases.entries()) {
      const x = origin.x + Bun.stringWidth(line.slice(0, line.indexOf(at)));
      const state = await doubleClick(viewer, x, origin.y + 1 + row);
      this.assertEqual(copied(state), expected, line);
      this.assertEqual(highlighted(state.data, origin.x, plain), expected, line);
      this.assertIn("Copied to clipboard", state.data);
    }
    // Either half of a token soft-wrapped across two rows copies all of it.
    const wrapped = origin.y + 1 + cases.length;
    for (const [x, y] of [
      [origin.x + width - 3, wrapped],
      [origin.x + 3, wrapped + 1],
    ]) {
      const state = await doubleClick(viewer, x, y);
      this.assertEqual(copied(state), "wrapped/long/token.ts");
      this.assertEqual(highlighted(state.data, origin.x, plain), "wrapped/long/token.ts");
    }
  }

  async test_double_click_on_nothing_copies_nothing() {
    const { viewer, origin } = await this.shown(() => ["...", 'foo ("x', "MARKER_END"]);
    const plain = { x: origin.x, y: origin.y };
    // A blank cell, a run of trimmed punctuation, and a space beside a
    // boundary character.
    for (const [x, y] of [
      [origin.x + 40, origin.y],
      [origin.x + 1, origin.y + 1],
      [origin.x + 3, origin.y + 2],
    ]) {
      const state = await doubleClick(viewer, x, y);
      this.assertIsNone(copied(state));
      this.assertEqual(highlighted(state.data, origin.x, plain), "");
      this.assertNotIn("Copied to clipboard", state.data);
    }
    // A boundary character selects its run, less the space before it.
    const state = await doubleClick(viewer, origin.x + 4, origin.y + 2);
    this.assertEqual(copied(state), '("');
  }

  async test_double_click_highlight_lasts_until_its_text_changes_or_the_user_acts() {
    const { pane, viewer, origin } = await this.shown(() => ["keep src/kept.ts here", "MARKER_END"]);
    const plain = { x: origin.x, y: origin.y };
    const pick = async () => {
      // Past the last pick's window, so it doesn't count as a triple-click.
      await viewer.advance(0.4);
      const state = await doubleClick(viewer, origin.x + 7, origin.y + 1);
      this.assertEqual(copied(state), "src/kept.ts");
      this.assertEqual(highlighted(state.data, origin.x, plain), "src/kept.ts");
    };
    const output = async (data: string, row: number, seen: string) => {
      await this.command("pane.input", { target: pane, data });
      await this.until(async () => screen_text((await viewer.poll()).data, cols, rows)[origin.y + row].includes(seen));
      return viewer.state.data;
    };
    // Output elsewhere keeps it and keeps flowing.
    await pick();
    const data = await output("echo UNRELATED\n", 4, "UNRELATED");
    this.assertEqual(highlighted(data, origin.x, plain), "src/kept.ts");
    // A key clears it.
    await viewer.input("x");
    this.assertEqual(highlighted(viewer.state.data, origin.x, plain), "");
    // So does a wheel scroll.
    await this.command("pane.input", { target: pane, data: "\x15" });
    await pick();
    await viewer.input(`\x1b[<64;${origin.x + 2};${origin.y + 3}M`);
    this.assertEqual(highlighted(viewer.state.data, origin.x, plain), "");
    await viewer.input(`\x1b[<65;${origin.x + 2};${origin.y + 3}M`);
    // And overwriting the selected text.
    await pick();
    const changed = await output("printf '\\033[2;6HXXX/kept.ts\\033[40;1H'\n", 1, "XXX/kept.ts");
    this.assertEqual(highlighted(changed, origin.x, plain), "");
  }

  async test_double_click_in_scrolled_back_history_copies_from_it() {
    const { pane, viewer, origin } = await this.shown(() => ["MARKER_END"]);
    await this.command("pane.input", {
      target: pane,
      data: "i=0; while [ $i -lt 120 ]; do echo history/token-$i.txt; i=$((i+1)); done\n",
    });
    await this.until(async () =>
      screen_text((await viewer.poll()).data, cols, rows).some(row => row.includes("history/token-119.txt")),
    );
    for (let i = 0; i < 10; i++) await viewer.input(`\x1b[<64;${origin.x + 2};${origin.y + 3}M`);
    const screen = screen_text(viewer.state.data, cols, rows);
    const y = screen.findIndex(row => row.slice(origin.x).startsWith("history/token-"));
    this.assertGreaterEqual(y, 0, "no history on screen");
    const token = screen[y].slice(origin.x).trim();
    this.assertNotIn(token, ["history/token-119.txt", "history/token-118.txt"]);
    const state = await doubleClick(viewer, origin.x + 9, y);
    this.assertEqual(copied(state), token);
  }

  async test_double_click_copies_while_a_spinner_redraws() {
    const fixture = join(this.temp.name, "spinner.ts");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
process.stdout.write("\\x1b[H\\x1b[2J\\x1b[3;1Hstatic spin/word.ts here\\r\\n");
let i = 0;
setInterval(() => {
  i++;
  process.stdout.write(\`\\x1b[?2026h\\x1b[1;1H\${frames[i % frames.length]} working \${i}\\x1b[?2026l\`);
}, 50);
`,
    );
    const pane = await this.new(shellJoin(["bun", fixture]));
    const viewer = await this.newViewer(cols, rows);
    await viewer.focus(pane);
    let screen: string[] = [];
    await this.until(async () => {
      screen = screen_text((await viewer.poll()).data, cols, rows);
      return screen.some(row => row.includes("static spin/word.ts"));
    });
    const y = screen.findIndex(row => row.includes("static spin/word.ts"));
    const x = screen[y].indexOf("spin/word.ts") + 5;
    const spinner = (data: string) => screen_text(data, cols, rows).find(row => row.includes(" working ")) ?? "";
    let frame = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      // Let the spinner redraw between attempts, past the double-click window.
      await this.until(async () => {
        const now = spinner((await viewer.poll()).data);
        if (now === frame) return false;
        frame = now;
        return true;
      });
      await viewer.advance(0.4);
      this.assertEqual(copied(await doubleClick(viewer, x, y)), "spin/word.ts", `attempt ${attempt}`);
    }
  }

  async test_triple_click_copies_the_line_under_the_pointer() {
    // Soft-wrapped across three rows.
    const long = (width: number) =>
      Array.from({ length: width }, (_, i) => `w${i}`)
        .join(" ")
        .slice(0, Math.floor(width * 2.5))
        .trimEnd();
    // Prose wrapped with a space in the last column.
    const prose = (width: number) => "lorem ".repeat(width).slice(0, width - 2) + "z after the wrap column";
    // Below the copy toast, which covers the top right.
    const { viewer, width, origin } = await this.shown(width => [
      ...Array(4).fill(""),
      "  single line here  ",
      long(width),
      prose(width),
      "MARKER_END",
    ]);
    const plain = { x: origin.x, y: origin.y };
    const top = origin.y + 5;
    const cases: [number, number, string][] = [
      [origin.x + 9, top, "single line here"],
      [origin.x + 2, top + 1, long(width)],
      [origin.x + 2, top + 2, long(width)],
      [origin.x + 2, top + 3, long(width)],
      [origin.x + 2, top + 4, prose(width)],
      [origin.x + 2, top + 5, prose(width)],
    ];
    for (const [x, y, expected] of cases) {
      await viewer.advance(0.4);
      const state = await clicks(viewer, x, y, 3);
      this.assertEqual(copied(state), expected, `row ${y - top}`);
      this.assertEqual(highlighted(state.data, origin.x, plain), expected, `row ${y - top}`);
      this.assertIn("Copied to clipboard", state.data);
    }
    // A fourth click in the series picks the line again.
    await viewer.advance(0.4);
    const state = await clicks(viewer, origin.x + 9, top, 4);
    this.assertEqual(copied(state), "single line here");
    this.assertEqual(highlighted(state.data, origin.x, plain), "single line here");
  }

  async test_triple_click_stops_at_the_prompt_mark() {
    const { viewer, origin } = await this.shown(() => ["\x1b]133;A\x07$ \x1b]133;B\x07ls -la", "MARKER_END"]);
    const plain = { x: origin.x, y: origin.y };
    // The command without its prompt, and the prompt on its own.
    for (const [x, expected] of [
      [origin.x + 2, "ls -la"],
      [origin.x, "$"],
    ] as const) {
      await viewer.advance(0.4);
      const state = await clicks(viewer, x, origin.y + 1, 3);
      this.assertEqual(copied(state), expected);
      this.assertEqual(highlighted(state.data, origin.x, plain), expected);
    }
  }

  async test_double_click_drag_extends_by_words() {
    const { viewer, origin } = await this.shown(() => ["alpha beta gamma delta", "MARKER_END"]);
    const plain = { x: origin.x, y: origin.y };
    const y = origin.y + 1;
    const at = (x: number) => `${origin.x + x + 1};${y + 1}`;
    // Double-click `beta`, then drag forward to mid `gamma` and backward to mid `alpha`.
    for (const [to, expected] of [
      [13, "beta gamma"],
      [2, "alpha beta"],
    ] as const) {
      await viewer.advance(0.4);
      await viewer.input(`\x1b[<0;${at(7)}M\x1b[<0;${at(7)}m\x1b[<0;${at(7)}M`);
      await viewer.input(`\x1b[<32;${at(to)}M`);
      const state = await viewer.input(`\x1b[<0;${at(to)}m`);
      this.assertEqual(copied(state), expected);
      this.assertEqual(highlighted(state.data, origin.x, plain), expected);
      this.assertIn("Copied to clipboard", state.data);
    }
  }

  async test_triple_click_drag_extends_by_lines() {
    const lines = ["first line one", "second line two", "third line three"];
    // Below the copy toast, which covers the top right.
    const { viewer, origin } = await this.shown(() => [...Array(4).fill(""), ...lines, "MARKER_END"]);
    const plain = { x: origin.x, y: origin.y };
    const top = origin.y + 5;
    const at = (x: number, y: number) => `${origin.x + x + 1};${y + 1}`;
    await viewer.input(`\x1b[<0;${at(3, top)}M\x1b[<0;${at(3, top)}m`.repeat(2) + `\x1b[<0;${at(3, top)}M`);
    await viewer.input(`\x1b[<32;${at(2, top + 2)}M`);
    const state = await viewer.input(`\x1b[<0;${at(2, top + 2)}m`);
    this.assertEqual(copied(state), lines.join("\n"));
    this.assertEqual(highlighted(state.data, origin.x, plain).replace(/ {2,}/g, " "), lines.join(" "));
  }

  async test_mouse_app_keeps_double_clicks_and_shift_picks() {
    const fixture = join(this.temp.name, "mouse.ts");
    const capture = join(this.temp.name, "mouse.bin");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
process.stdout.write('\\x1b[?1000h\\x1b[?1002h\\x1b[?1006hpick/me.ts and more');
const fd = openSync(process.argv[2], 'w');
process.stdin.on('data', chunk => writeSync(fd, chunk));
process.stdin.resume();
`,
    );
    const pane = await this.new(shellJoin(["bun", fixture, capture]));
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("pick/me.ts"),
    );
    const viewer = await this.newViewer();
    await viewer.focus(pane);
    // A plain double-click is the app's: both presses and releases reach it.
    const state = await doubleClick(viewer, 30, 1);
    this.assertIsNone(copied(state));
    const forwarded = "\x1b[<0;3;1M\x1b[<0;3;1m".repeat(2);
    await this.until(() => readFileSync(capture).includes(Buffer.from(forwarded)));
    this.assertNotIn("Copied to clipboard", viewer.state.data);
    // With Shift, a double-click picks the word and a triple-click the line.
    for (const [count, expected] of [
      [2, "pick/me.ts"],
      [3, "pick/me.ts and more"],
    ] as const) {
      await viewer.advance(0.4);
      this.assertEqual(copied(await clicks(viewer, 30, 1, count, 4)), expected);
    }
    // Nothing of the Shift clicks reached the app: the wheel comes right
    // after the plain double-click.
    await viewer.input("\x1b[<64;29;2M");
    await this.until(() => readFileSync(capture).includes(Buffer.from("\x1b[<64;1;1M")));
    this.assertEqual(readFileSync(capture).toString(), forwarded + "\x1b[<64;1;1M");
  }

  async test_agent_gets_mouse_and_shift_drag_selects() {
    const fixture = join(this.temp.name, "mouse.ts");
    const capture = join(this.temp.name, "mouse.bin");
    writeExecutable(
      fixture,
      `#!/usr/bin/env bun
import { openSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
spawnSync('stty', ['raw', '-echo'], { stdio: 'inherit' });
process.stdout.write('\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006hSELECT_ME');
const fd = openSync(process.argv[2], 'w');
process.stdin.on('data', chunk => writeSync(fd, chunk));
process.stdin.resume();
`,
    );
    const pane = await this.new(shellJoin(["bun", fixture, capture]));
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("SELECT_ME"),
    );
    await this.mark_agent(pane, "Mouse agent");
    const viewer = await this.newViewer();
    await viewer.focus(pane);
    // Hover, then a drag released over the sidebar, all reach the agent.
    await viewer.input("\x1b[<35;30;2M");
    await viewer.input("\x1b[<0;29;2M");
    await viewer.input("\x1b[<32;37;2M");
    await viewer.input("\x1b[<32;5;2M");
    await viewer.input("\x1b[<0;5;2m");
    const forwarded = "\x1b[<35;2;1M\x1b[<0;1;1M\x1b[<32;9;1M\x1b[<32;1;1M\x1b[<0;1;1m";
    await this.until(() => readFileSync(capture).includes(Buffer.from(forwarded)));
    this.assertNotIn("Copied to clipboard", viewer.state.data);
    // Shift-drag stays with corgi and copies.
    await viewer.input("\x1b[<4;29;2M");
    await viewer.input("\x1b[<36;37;2M");
    await viewer.input("\x1b[<4;37;2m");
    const effects = viewer.state.effects;
    this.assertTrue(effects.length, "shift drag did not copy");
    const encoded = effects[0].write_terminal.split("52;c;", 2)[1].split("\x07", 1)[0];
    this.assertEqual(Buffer.from(encoded, "base64").toString(), "SELECT_ME");
    this.assertIn("Copied to clipboard", viewer.state.data);
    await viewer.input("\x1b[<64;29;2M");
    await this.until(() => readFileSync(capture).includes(Buffer.from("\x1b[<64;1;1M")));
    this.assertEqual(readFileSync(capture).toString(), forwarded + "\x1b[<64;1;1M");
  }

  async test_program_copy_reaches_the_viewer_showing_it() {
    const pane = await this.new("exec /bin/sh");
    const viewer = await this.newViewer();
    await viewer.focus(pane);
    await this.command("pane.input", {
      data: "printf '\\033]52;c;%s\\007' Q09QSUVE\n",
      target: pane,
    });
    const copy = `\x1b]52;c;${Buffer.from("COPIED").toString("base64")}\x07`;
    await this.until(async () => (await viewer.poll()).effects.some((effect: any) => effect.write_terminal === copy));
    this.assertIn("Copied to clipboard", viewer.state.data);
  }

  async test_drag_freezes_text_and_release_copies_then_resumes() {
    const pane = await this.new("printf 'SELECT_ME\\n'; exec /bin/sh");
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("SELECT_ME"),
    );
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(pane);
    await b.focus(pane);
    await a.input("\x1b[<0;29;2M\x1b[<32;37;2M");
    const held = a.state.data;
    await this.command("pane.input", {
      data: "printf 'NEW_OUTPUT\\n'\n",
      target: pane,
    });
    await this.until(async () =>
      (await this.command("pane.read", { target: pane, view: "screen" })).text.includes("NEW_OUTPUT"),
    );
    this.assertEqual((await a.poll()).data, held);
    this.assertIn("NEW_OUTPUT", (await b.poll()).data);
    await a.input("\x1b[<0;1;3m");
    const effect = a.state.effects[0].write_terminal;
    const encoded = effect.split("52;c;", 2)[1].split("\x07", 1)[0];
    this.assertEqual(Buffer.from(encoded, "base64").toString(), "SELECT_ME");
    this.assertIn("Copied to clipboard", a.state.data);
    this.assertIn("NEW_OUTPUT", a.state.data);
    this.assertNotIn("Copied to clipboard", (await b.poll()).data);
    await a.advance(2.1);
    this.assertEqual((await a.poll()).data, (await b.poll()).data);
  }
}
registerCase("Selection", Selection, { inherited: false });
