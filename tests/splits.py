"""Split lines and drag capture through real viewer/daemon exchanges."""
import re, unittest
from viewers import Viewers, Viewer

def border_cells(data):
    cells={};x=y=0;highlighted=False;i=0
    while i<len(data):
        if data[i]=='\x1b':
            m=re.match(r'\x1b\[([0-9;:?]*)([@-~])',data[i:])
            if not m:
                i+=2;continue
            args,kind=m.groups()
            if kind in ('H','f'):
                parts=[int(v or 1) for v in args.split(';')]
                y=parts[0]-1;x=(parts[1] if len(parts)>1 else 1)-1
            elif kind=='m':
                if '38;2;161;194;178' in args:highlighted=True
                elif args=='' or '0' in args.split(';') or '38;' in args:highlighted=False
            i+=len(m.group());continue
        if data[i] in '─│┌┐└┘├┤┬┴┼':cells[x,y]=(data[i],highlighted)
        if data[i]>=' ':x+=1
        i+=1
    return cells

class Splits(Viewers):
    def split(self, pane, axis):
        return self.rpc(op='pane.split', protocol=1, pane=pane, axis=axis,
                        cwd=self.temp.name, command='sleep 60')['pane']

    def tree(self):
        return self.session()['workspaces'][0]['tabs'][0]['layout']['split']

    def test_lines_and_continuous_drag(self):
        left = self.new()
        right = self.split(left, 'right')
        self.split(right, 'down')
        a, b = Viewer(self), Viewer(self)
        a.focus(left)
        self.assertIn('\x1b[3;64H│', a.state['data'])
        self.assertIn('├', a.state['data'])
        self.assertIn('─', a.state['data'])
        a.input('\x1b[<0;64;5M')
        a.input('\x1b[<32;70;5M')
        first = self.tree()['ratio']
        self.assertGreater(first, 500)
        b.input('\x1b[<0;80;5m')
        a.input('\x1b[<32;76;5M')
        self.assertGreater(self.tree()['ratio'], first)
        a.input('\x1b[<0;80;5m')
        released = self.tree()['ratio']
        self.assertIn('\x1b[3;80H│', a.state['data'])
        a.input('\x1b[<32;85;5M')
        self.assertEqual(self.tree()['ratio'], released)
        # Horizontal divider in the right subtree remains independently draggable.
        a.input('\x1b[<0;90;15M')
        a.input('\x1b[<32;90;20M')
        self.assertGreater(self.tree()['second']['split']['ratio'], 500)
        a.input('\x1b[<0;90;20m')
        a.action('zoom')
        self.assertNotIn('├', a.state['data'])
        self.assertNotIn('\x1b[3;80H│', a.state['data'])

    def test_focus_outline_includes_outer_edges_and_corners(self):
        left=self.new()
        right=self.split(left,'right')
        a=Viewer(self)
        a.focus(left)
        cells=border_cells(a.state['data'])
        for point in [(28,1),(40,1),(40,28),(28,10),(63,10),(63,1),(63,28)]:
            self.assertTrue(cells[point][1],point)
        self.assertEqual(cells[28,1][0],'┌')
        self.assertEqual(cells[28,28][0],'└')
        self.assertEqual(cells[63,1][0],'┬')
        self.assertFalse(cells[90,1][1])
        self.assertFalse(cells[99,10][1])
        self.assertEqual(self.geometry()[left],(34,26))
        self.assertEqual(self.geometry()[right],(35,26))
        a.focus(right)
        cells=border_cells(a.state['data'])
        for point in [(99,1),(90,1),(90,28),(99,10),(63,10)]:
            self.assertTrue(cells[point][1],point)
        self.assertFalse(cells[28,10][1])
        # Outer frame cells are not draggable split separators.
        ratio=self.tree()['ratio']
        a.input('\x1b[<0;90;2M\x1b[<32;80;5M\x1b[<0;80;5m')
        self.assertEqual(self.tree()['ratio'],ratio)
        a.action('zoom')
        self.assertEqual(self.geometry()[right],(72,28))
        self.assertEqual(border_cells(a.state['data']).get((99,1)),None)

    def test_stacked_and_nested_focus_outline(self):
        top=self.new()
        bottom=self.split(top,'down')
        a=Viewer(self)
        a.focus(bottom)
        cells=border_cells(a.state['data'])
        for point in [(28,20),(99,20),(50,28),(50,14)]:
            self.assertTrue(cells[point][1],point)
        self.assertFalse(cells[50,1][1])
        self.assertFalse(cells[28,5][1])
        right=self.split(bottom,'right')
        a.poll();a.focus(right)
        cells=border_cells(a.state['data'])
        for point in [(99,20),(90,28),(90,14),(63,20),(63,14)]:
            self.assertTrue(cells[point][1],point)
        self.assertFalse(cells[40,28][1])
        self.assertFalse(cells[28,20][1])

    def test_resize_and_external_layout_change_cancel_drag(self):
        pane = self.new()
        self.split(pane, 'right')
        a = Viewer(self)
        a.input('\x1b[<0;64;5M')
        a.request(op='size', cols=120, rows=30)
        a.input('\x1b[<32;80;5M\x1b[<0;80;5m')
        self.assertEqual(self.tree()['ratio'], 500)
        a.input('\x1b[<0;74;5M')
        self.split(pane, 'down')
        a.poll()
        a.input('\x1b[<32;90;5M\x1b[<0;90;5m')
        self.assertEqual(self.tree()['ratio'], 500)

if __name__ == '__main__': unittest.main()
