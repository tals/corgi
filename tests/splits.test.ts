import { Viewers } from "./viewers";
import { layout_tree } from "./runtime";
import { registerCase } from "./support";

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
    await a.input("\x1b[<0;90;16M");
    await a.input("\x1b[<32;90;21M");
    this.assertGreater((await this.tree()).second.split.ratio, 500);
    await a.input("\x1b[<0;90;21m");
    await a.action("zoom");
    this.assertNotIn("├", a.state.data);
    this.assertNotIn("\x1b[3;80H│", a.state.data);
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
