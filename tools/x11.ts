/**
 * The X calls a capture needs, through Xlib: find Ghostty's window, read its
 * bounds and focus it; move the pointer and press buttons with XTEST, as a
 * mouse would; and read the cursor's name with XFixes.
 */
import { CString, dlopen, JSCallback, ptr, read, type Pointer } from "bun:ffi";

export interface Window {
  id: bigint;
  x: number;
  y: number;
  width: number;
  height: number;
}

const IsViewable = 2,
  RevertToParent = 2,
  CurrentTime = 0n;

function load() {
  const x11 = dlopen("libX11.so.6", {
    XOpenDisplay: { args: ["ptr"], returns: "ptr" },
    XCloseDisplay: { args: ["ptr"], returns: "i32" },
    XDefaultRootWindow: { args: ["ptr"], returns: "u64" },
    XQueryTree: { args: ["ptr", "u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    XGetWindowAttributes: { args: ["ptr", "u64", "ptr"], returns: "i32" },
    XSetInputFocus: { args: ["ptr", "u64", "i32", "u64"], returns: "i32" },
    XFlush: { args: ["ptr"], returns: "i32" },
    XSync: { args: ["ptr", "i32"], returns: "i32" },
    XFree: { args: ["ptr"], returns: "i32" },
    XSetErrorHandler: { args: ["ptr"], returns: "ptr" },
  });
  const xtst = dlopen("libXtst.so.6", {
    XTestFakeMotionEvent: { args: ["ptr", "i32", "i32", "i32", "u64"], returns: "i32" },
    XTestFakeButtonEvent: { args: ["ptr", "u32", "i32", "u64"], returns: "i32" },
  });
  const xfixes = dlopen("libXfixes.so.3", { XFixesGetCursorImage: { args: ["ptr"], returns: "ptr" } });
  // Xlib's default handler exits the process, say when a window goes away between calls.
  const ignore = new JSCallback(() => 0, { args: ["ptr", "ptr"], returns: "i32" });
  x11.symbols.XSetErrorHandler(ignore.ptr);
  return { ...x11.symbols, ...xtst.symbols, ...xfixes.symbols, ignore };
}

let lib: ReturnType<typeof load> | null = null;

/** A connection to an X display, such as a capture's Xvfb. */
export class Display {
  private x = (lib ??= load());
  private dpy: Pointer;
  constructor(readonly name: string) {
    const dpy = this.x.XOpenDisplay(ptr(Buffer.from(`:${name}\0`))) as Pointer | null;
    if (!dpy) throw Error(`cannot open X display :${name}`);
    this.dpy = dpy;
  }

  close(): void {
    this.x.XCloseDisplay(this.dpy);
  }

  /** The largest mapped top-level window, such as the only Ghostty on a capture's display. */
  topWindow(): Window | null {
    const [root, parent, list] = [new BigUint64Array(1), new BigUint64Array(1), new BigUint64Array(1)];
    const count = new Uint32Array(1);
    const top = this.x.XDefaultRootWindow(this.dpy);
    if (!this.x.XQueryTree(this.dpy, top, ptr(root), ptr(parent), ptr(list), ptr(count))) return null;
    const children = Number(list[0]) as Pointer;
    // XWindowAttributes on LP64: x, y, width and height first; map_state at 92, override_redirect at 120.
    const attributes = new Uint8Array(256),
      view = new DataView(attributes.buffer);
    let best: Window | null = null;
    for (let i = 0; i < count[0]; i++) {
      const id = read.u64(children, i * 8);
      if (!this.x.XGetWindowAttributes(this.dpy, id, ptr(attributes))) continue;
      if (view.getInt32(92, true) !== IsViewable || view.getInt32(120, true)) continue;
      const [left, top, width, height] = [0, 4, 8, 12].map(at => view.getInt32(at, true));
      if (!best || width * height > best.width * best.height) best = { id, x: left, y: top, width, height };
    }
    if (children) this.x.XFree(children);
    return best;
  }

  /** Gives a window keyboard focus, so Ghostty draws itself focused. */
  focus(id: bigint): void {
    this.x.XSetInputFocus(this.dpy, id, RevertToParent, CurrentTime);
    this.x.XSync(this.dpy, 0);
  }

  /** Moves the pointer to a point on the screen; the window under it sees the motion. */
  move(x: number, y: number): void {
    this.x.XTestFakeMotionEvent(this.dpy, -1, Math.round(x), Math.round(y), 0n);
    this.x.XFlush(this.dpy);
  }

  /** Presses or lets go of a button: 1 left, 2 middle, 3 right, 4 and 5 the wheel. */
  button(button: number, press: boolean): void {
    this.x.XTestFakeButtonEvent(this.dpy, button, press ? 1 : 0, 0n);
    this.x.XFlush(this.dpy);
  }

  /** The cursor's name, such as default, text or pointer, or null when it has none. */
  cursor(): string | null {
    const image = this.x.XFixesGetCursorImage(this.dpy) as Pointer | null;
    if (!image) return null;
    // XFixesCursorImage on LP64: the name's pointer is its last field, at 40.
    const name = read.ptr(image, 40) as Pointer | null;
    const text = name ? new CString(name).toString() : null;
    this.x.XFree(image);
    return text || null;
  }
}
