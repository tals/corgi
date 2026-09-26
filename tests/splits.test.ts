import { Viewers } from "./viewers";
import { layout_tree } from "./runtime";
import { registerCase } from "./support";

type Cell = [string, boolean];
function border_cells(data: string) {
  const cells = new Map<string, Cell>();
  let x = 0,
    y = 0,
    highlighted = false,
    i = 0;
  while (i < data.length) {
    if (data[i] === "\x1b") {
      const match = /^\x1b\[([0-9;:?]*)([@-~])/.exec(data.slice(i));
      if (!match) {
        i += 2;
        continue;
      }
      const [, args, kind] = match;
      if (kind === "H" || kind === "f") {
        const parts = args.split(";").map((v) => Number(v || 1));
        y = parts[0] - 1;
        x = (parts.length > 1 ? parts[1] : 1) - 1;
      } else if (kind === "m") {
        if (args.includes("38;2;161;194;178")) highlighted = true;
        else if (
          args === "" ||
          args.split(";").includes("0") ||
          args.includes("38;")
        )
          highlighted = false;
      }
      i += match[0].length;
      continue;
    }
    if ("─│┌┐└┘├┤┬┴┼".includes(data[i]))
      cells.set(`${x},${y}`, [data[i], highlighted]);
    if (data[i] >= " ") x++;
    i++;
  }
  return cells;
}
const cell = (cells: Map<string, Cell>, x: number, y: number) =>
  cells.get(`${x},${y}`)!;

class Splits extends Viewers {
  async split(pane: number, axis: string) {
    return (
      await this.command("pane.split", {
        cwd: this.temp.name,
        command: "sleep 60",
        target: pane,
        direction: axis,
      })
    ).pane;
  }
  async tree() {
    return layout_tree((await this.session()).workspaces[0]).split;
  }

  async test_lines_and_continuous_drag() {
    const left = await this.new();
    const right = await this.split(left, "right");
    await this.split(right, "down");
    const a = await this.newViewer(),
      b = await this.newViewer();
    await a.focus(left);
    this.assertIn("\x1b[3;64H│", a.state.data);
    this.assertIn("├", a.state.data);
    this.assertIn("─", a.state.data);
    await a.input("\x1b[<0;64;5M");
    await a.input("\x1b[<32;70;5M");
    const first = (await this.tree()).ratio;
    this.assertGreater(first, 500);
    await b.input("\x1b[<0;80;5m");
    await a.input("\x1b[<32;76;5M");
    this.assertGreater((await this.tree()).ratio, first);
    await a.input("\x1b[<0;80;5m");
    const released = (await this.tree()).ratio;
    this.assertIn("\x1b[3;80H│", a.state.data);
    await a.input("\x1b[<32;85;5M");
    this.assertEqual((await this.tree()).ratio, released);
    await a.input("\x1b[<0;90;15M");
    await a.input("\x1b[<32;90;20M");
    this.assertGreater((await this.tree()).second.split.ratio, 500);
    await a.input("\x1b[<0;90;20m");
    await a.action("zoom");
    this.assertNotIn("├", a.state.data);
    this.assertNotIn("\x1b[3;80H│", a.state.data);
  }

  async test_focus_outline_includes_outer_edges_and_corners() {
    const left = await this.new(),
      right = await this.split(left, "right");
    const a = await this.newViewer();
    await a.focus(left);
    let cells = border_cells(a.state.data);
    for (const [x, y] of [
      [28, 1],
      [40, 1],
      [40, 28],
      [28, 10],
      [63, 10],
      [63, 1],
      [63, 28],
    ])
      this.assertTrue(cell(cells, x, y)[1], [x, y]);
    this.assertEqual(cell(cells, 28, 1)[0], "┌");
    this.assertEqual(cell(cells, 28, 28)[0], "└");
    this.assertEqual(cell(cells, 63, 1)[0], "┬");
    this.assertFalse(cell(cells, 90, 1)[1]);
    this.assertFalse(cell(cells, 99, 10)[1]);
    this.assertEqual((await this.geometry())[left], [34, 26]);
    this.assertEqual((await this.geometry())[right], [35, 26]);
    await a.focus(right);
    cells = border_cells(a.state.data);
    for (const [x, y] of [
      [99, 1],
      [90, 1],
      [90, 28],
      [99, 10],
      [63, 10],
    ])
      this.assertTrue(cell(cells, x, y)[1], [x, y]);
    this.assertFalse(cell(cells, 28, 10)[1]);
    const ratio = (await this.tree()).ratio;
    await a.input("\x1b[<0;90;2M\x1b[<32;80;5M\x1b[<0;80;5m");
    this.assertEqual((await this.tree()).ratio, ratio);
    await a.action("zoom");
    this.assertEqual((await this.geometry())[right], [72, 28]);
    this.assertEqual(border_cells(a.state.data).get("99,1"), undefined);
  }

  async test_stacked_and_nested_focus_outline() {
    const top = await this.new(),
      bottom = await this.split(top, "down");
    const a = await this.newViewer();
    await a.focus(bottom);
    let cells = border_cells(a.state.data);
    for (const [x, y] of [
      [28, 20],
      [99, 20],
      [50, 28],
      [50, 14],
    ])
      this.assertTrue(cell(cells, x, y)[1], [x, y]);
    this.assertFalse(cell(cells, 50, 1)[1]);
    this.assertFalse(cell(cells, 28, 5)[1]);
    const right = await this.split(bottom, "right");
    await a.poll();
    await a.focus(right);
    cells = border_cells(a.state.data);
    for (const [x, y] of [
      [99, 20],
      [90, 28],
      [90, 14],
      [63, 20],
      [63, 14],
    ])
      this.assertTrue(cell(cells, x, y)[1], [x, y]);
    this.assertFalse(cell(cells, 40, 28)[1]);
    this.assertFalse(cell(cells, 28, 20)[1]);
  }

  async test_resize_and_external_layout_change_cancel_drag() {
    const pane = await this.new();
    await this.split(pane, "right");
    const a = await this.newViewer();
    await a.input("\x1b[<0;64;5M");
    await a.request({ op: "size", cols: 120, rows: 30 });
    await a.input("\x1b[<32;80;5M\x1b[<0;80;5m");
    this.assertEqual((await this.tree()).ratio, 500);
    await a.input("\x1b[<0;74;5M");
    await this.split(pane, "down");
    await a.poll();
    await a.input("\x1b[<32;90;5M\x1b[<0;90;5m");
    this.assertEqual((await this.tree()).ratio, 500);
  }
}
registerCase("Splits", Splits, { inherited: false });
