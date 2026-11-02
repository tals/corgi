import "./language";
import * as moonlander from "../src/moonlander/moonlander";
import * as scene from "../src/moonlander/scene";
import * as faces from "../src/moonlander/faces";
import * as hull from "../src/moonlander/hull";

const css = getComputedStyle(document.documentElement);
const C = Object.fromEntries(["bg", "surface", "selected", "line", "faint", "muted", "text", "strong", "accent", "warm", "hot"].map(n => [n, css.getPropertyValue("--"+n).trim()]));
const FONT = css.getPropertyValue("--mono").trim();
const canvas = document.getElementById("game"), ctx = canvas.getContext("2d");
const touch = matchMedia("(pointer: coarse)").matches;
const room = () => innerHeight - (touch ? 100 : 0);
const clamp = moonlander.clamp;
let EM = {w:0.6,h:1.32,ascent:1.02}, engine, atlas = null, image = null, atlasKey = "", atlasGeneration = 0;
// ?hull= and ?levels= pick the hull as tools/moonlander.ts's switches do.
const query = new URLSearchParams(location.search);
const HULL = hull.parseStyle(query.get("hull") ?? "") ?? "image", LEVELS = query.get("levels") === "4" ? 4 : 16;
// The hull image's tiles, drawn when the ship first takes each tilt.
const hullTiles = new Map();
function hullTile(index) {
  const {cw,ch,dpr} = view, key = `${cw*dpr}/${ch*dpr}/${engine.world.K}/${index}`;
  if (!hullTiles.has(key)) {
    const sprite = hull.sprite(engine,Math.round(cw*dpr),Math.round(ch*dpr),index), tile = document.createElement("canvas");
    tile.width = sprite.w; tile.height = sprite.h;
    const c = tile.getContext("2d"), img = c.createImageData(sprite.w,sprite.h), rgb = [1,3,5].map(i => parseInt(C.text.slice(i,i+2),16));
    // Quantized to the alpha levels a terminal would get.
    sprite.alpha.forEach((a,i) => { img.data.set([...rgb,Math.round(Math.round(a/255*(LEVELS-1))/(LEVELS-1)*255)],i*4); });
    c.putImageData(img,0,0);
    hullTiles.set(key,{sprite,tile});
  }
  return hullTiles.get(key);
}
const view = {cw:0,ch:0,dpr:1,lw:1,ascent:0,ox:0,oy:0,font:"",bold:"",ds:1};
const widths = new Map();
function measure() {
  ctx.font = `100px ${FONT}`;
  const m = ctx.measureText("█");
  EM = {w:ctx.measureText("M").width/100,h:(m.fontBoundingBoxAscent+m.fontBoundingBoxDescent)/100,ascent:m.fontBoundingBoxAscent/100};
}
function grid() {
  const px = Math.min(room()/(46*EM.h),innerWidth/(72*EM.w));
  return {cols:clamp(Math.floor(innerWidth/(px*EM.w)),72,200),rows:Math.max(30,Math.floor(room()/(px*EM.h)))};
}
function fit() {
  const {cols,rows} = engine.world, dpr = Math.min(devicePixelRatio||1,2);
  const px = Math.min(innerWidth/(cols*EM.w),room()/(rows*EM.h));
  const cw = Math.max(1,Math.floor(px*EM.w*dpr))/dpr, ch = Math.max(1,Math.floor(px*EM.h*dpr))/dpr, size = cw/EM.w;
  Object.assign(view,{cw,ch,dpr,ascent:size*EM.ascent,font:`${size}px ${FONT}`,bold:`700 ${size}px ${FONT}`,lw:Math.max(1,Math.round(cw*0.11*dpr))/dpr});
  view.ox = Math.round((innerWidth-cols*cw)*dpr/2)/dpr;
  view.oy = Math.round((room()-rows*ch)*dpr/2)/dpr;
  view.ds = Math.max(1,Math.round(Math.min(cw/2,ch/4)*0.5*dpr))/dpr;
  canvas.width = Math.round(innerWidth*dpr); canvas.height = Math.round(innerHeight*dpr); widths.clear();
  void prepareAtlas();
}
async function prepareAtlas() {
  const {cw,ch,dpr} = view, key = `${cw}/${ch}/${dpr}/${FONT}`;
  if (key === atlasKey) return;
  atlasKey = key;
  const generation = ++atlasGeneration, next = faces.layout(cw*dpr,ch*dpr);
  const tiles = rasterize(next);
  const color = [1,3,5].map(i => parseInt(C.strong.slice(i,i+2),16));
  const png = await faces.encode(next,faces.pack(next,tiles),color,4);
  // Display the decoded indexed PNG, including its quantized alpha levels.
  const decoded = await createImageBitmap(new Blob([png],{type:"image/png"}));
  if (generation !== atlasGeneration) {decoded.close();return;}
  image?.close(); atlas = next; image = decoded;
}
function rasterize(spec) {
  const tile = document.createElement("canvas"); tile.width = tile.height = spec.side;
  const c = tile.getContext("2d"), out = new Uint8Array(spec.tiles.reduce((n,t) => n+t.count,0)*spec.side**2);
  const size = spec.cw/EM.w, ascent = size*EM.ascent;
  c.font = `${size}px ${FONT}`; c.textAlign = "center"; c.textBaseline = "alphabetic"; c.fillStyle = C.strong;
  let offset = 0;
  for (const item of spec.tiles) for (let turn = 0; turn < item.count; turn++) {
    c.setTransform(1,0,0,1,0,0); c.clearRect(0,0,spec.side,spec.side);
    c.translate(spec.side/2,spec.side/2); c.rotate(item.count === 1 ? 0 : (turn*faces.step-90)*Math.PI/180);
    c.save();
    const width = c.measureText(item.glyph).width;
    if (width > spec.cw*1.04) c.scale(spec.cw/width,1);
    c.fillText(item.glyph,0,ascent-spec.ch/2); c.restore();
    const rgba = c.getImageData(0,0,spec.side,spec.side).data;
    for (let i = 3; i < rgba.length; i += 4) out[offset++] = rgba[i];
  }
  return out;
}
// Box drawing and block elements are drawn as sprites, as Ghostty draws
// them, so they join across cells whatever the font has.
const ARMS = { "─": "lr", "│": "ud", "┌": "rd", "┐": "ld", "└": "ru", "┘": "lu", "├": "udr", "┤": "udl", "┬": "lrd", "┴": "lru", "┼": "udlr", "╴": "l", "╵": "u", "╶": "r", "╷": "d" };
const ARCS = { "╭": "rd", "╮": "ld", "╯": "lu", "╰": "ru" };
const DASHES = { "╌": "h2", "┄": "h3", "┈": "h4", "╎": "v2", "┆": "v3", "┊": "v4" };
const SHADES = { "░": 0.25, "▒": 0.5, "▓": 0.75 };
const BLOCKS = {
  "█": [[0, 0, 1, 1]], "▀": [[0, 0, 1, 0.5]], "▌": [[0, 0, 0.5, 1]], "▐": [[0.5, 0, 1, 1]],
  "▖": [[0, 0.5, 0.5, 1]], "▗": [[0.5, 0.5, 1, 1]], "▘": [[0, 0, 0.5, 0.5]], "▝": [[0.5, 0, 1, 0.5]],
  "▚": [[0, 0, 0.5, 0.5], [0.5, 0.5, 1, 1]], "▞": [[0.5, 0, 1, 0.5], [0, 0.5, 0.5, 1]],
};
const EIGHTHS = "▁▂▃▄▅▆▇█";
[...EIGHTHS].slice(0, 7).forEach((g, i) => (BLOCKS[g] = [[0, 1 - (i + 1) / 8, 1, 1]]));
// Thin lines at each eighth of a cell, as the pads slide when the camera pans.
BLOCKS["▔"] = [[0, 0, 1, 1 / 8]];
for (let i = 1; i < 7; i++) BLOCKS[String.fromCodePoint(0x1fb76 + i - 1)] = [[0, i / 8, 1, (i + 1) / 8]];
const DIAGS = { "╱": [[0, 1, 1, 0]], "╲": [[0, 0, 1, 1]] };
// An octant: two pixels across and four down, bit 0 top left. Since Unicode
// 16 every one of the 256 patterns is a character, and kitty and Ghostty draw
// them themselves, like box drawing.

const bitsOf = (g) => +g.slice(3);
const octRects = (g) => [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => bitsOf(g) & (1 << i)).map((i) => [(i % 2) / 2, Math.floor(i / 2) / 4, (i % 2) / 2 + 0.5, Math.floor(i / 2) / 4 + 0.25]);
function sprite(c, g, x, y) {
  const arms = g === "━" ? "lr" : ARMS[g], arc = ARCS[g], dash = DASHES[g], shade = SHADES[g], diag = DIAGS[g];
  const rects = BLOCKS[g] ?? (g.startsWith("oct") ? octRects(g) : null);
  if (!arms && !arc && !dash && !shade && !rects && !diag) return false;
  // Axis-aligned cells snap to device pixels; the tilted ship can't.
  const { cw, ch, lw } = view, t = c.getTransform(), tilted = t.b || t.c;
  const sx = (v) => (tilted ? v : (Math.round(v * t.a + t.e) - t.e) / t.a);
  const sy = (v) => (tilted ? v : (Math.round(v * t.d + t.f) - t.f) / t.d);
  const x0 = sx(x), x1 = sx(x + cw), y0 = sy(y), y1 = sy(y + ch), lx = sx(x + cw / 2 - lw / 2), ly = sy(y + ch / 2 - lw / 2);
  if (rects) for (const [a, b, e, f] of rects) c.fillRect(sx(x + a * cw), sy(y + b * ch), sx(x + e * cw) - sx(x + a * cw), sy(y + f * ch) - sy(y + b * ch));
  else if (shade) (c.globalAlpha = shade), c.fillRect(x0, y0, x1 - x0, y1 - y0), (c.globalAlpha = 1);
  else if (arms) {
    if (arms.includes("l")) c.fillRect(x0, ly, lx + lw - x0, lw);
    if (arms.includes("r")) c.fillRect(lx, ly, x1 - lx, lw);
    if (arms.includes("u")) c.fillRect(lx, y0, lw, ly + lw - y0);
    if (arms.includes("d")) c.fillRect(lx, ly, lw, y1 - ly);
  } else if (dash)
    for (let i = 0, n = +dash[1]; i < n; i++) {
      if (dash[0] === "h") c.fillRect(sx(x + (cw * (i + 0.2)) / n), ly, (cw * 0.6) / n, lw);
      else c.fillRect(lx, sy(y + (ch * (i + 0.2)) / n), lw, (ch * 0.6) / n);
    }
  else {
    const cx = lx + lw / 2, cy = ly + lw / 2;
    c.strokeStyle = c.fillStyle;
    c.lineWidth = lw;
    c.lineCap = "butt";
    c.beginPath();
    if (arc) {
      const ex = arc[0] === "r" ? x1 : x0, ey = arc[1] === "d" ? y1 : y0;
      c.moveTo(ex, cy);
      c.arcTo(cx, cy, cx, ey, cw / 2);
      c.lineTo(cx, ey);
    } else for (const [a, b, e, f] of diag) c.moveTo(x + a * cw, y + b * ch), c.lineTo(x + e * cw, y + f * ch);
    c.stroke();
  }
  return true;
}

// One cell's glyph, its top-left at (x, y); wide fallback glyphs squeeze into the cell.
function glyph(c, g, x, y, color) {
  c.fillStyle = color;
  if (sprite(c, g, x, y)) return;
  const key = c.font + g;
  let w = widths.get(key);
  if (w === undefined) widths.set(key, (w = c.measureText(g).width));
  if (w > view.cw * 1.04) {
    c.save();
    c.translate(x + view.cw / 2, y + view.ascent);
    c.scale(view.cw / w, 1);
    c.fillText(g, 0, 0);
    c.restore();
  } else c.fillText(g, x + view.cw / 2, y + view.ascent);
}

const BRAILLE = [1,8,2,16,4,32,64,128];
// A cell's color at its alpha over its background, as the terminal mixes it.
const blends = new Map();
function blend(cell) {
  if (cell.alpha >= 1) return C[cell.fg];
  const key = `${cell.fg}/${cell.bg}/${cell.alpha}`;
  if (!blends.has(key)) {
    const rgb = (hex) => [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)), fg = rgb(C[cell.fg]), bg = rgb(C[cell.bg]);
    blends.set(key,`rgb(${fg.map((v,i) => Math.round(bg[i]+(v-bg[i])*cell.alpha)).join(",")})`);
  }
  return blends.get(key);
}
function draw() {
  const {cw,ch,dpr,ox,oy} = view, L = engine.lander, tile = HULL === "image" && L ? hullTile(hull.tile(L.a)) : null;
  const style = tile ? "image" : HULL === "image" ? hull.fallback : HULL, screen = scene.render(engine,!!image,style);
  ctx.setTransform(dpr,0,0,dpr,0,0); ctx.fillStyle = C.bg; ctx.fillRect(0,0,innerWidth,innerHeight);
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  for (let row = 0; row < screen.rows; row++) for (let col = 0; col < screen.cols; col++) {
    const cell = screen.cells[row*screen.cols+col], x = ox+col*cw, y = oy+row*ch;
    if (cell.bg !== "bg") {ctx.fillStyle=C[cell.bg];ctx.fillRect(x,y,cw,ch);}
    if (cell.dots) {
      ctx.fillStyle = blend(cell);
      for (let b=0;b<8;b++) if (cell.dots&BRAILLE[b]) {
        const dx = x+(b%2+0.5)*cw/2-view.ds/2, dy = y+(Math.floor(b/2)+0.5)*ch/4-view.ds/2;
        ctx.fillRect(Math.round(dx*dpr)/dpr,Math.round(dy*dpr)/dpr,view.ds,view.ds);
      }
    } else if (cell.glyph !== " ") {ctx.font=cell.bold?view.bold:view.font;glyph(ctx,cell.glyph,x,y,blend(cell));}
  }
  if (tile) for (const p of hull.placements(engine,tile.sprite,Math.round(cw*dpr),Math.round(ch*dpr),screen.occludes))
    ctx.drawImage(tile.tile,p.sx,p.sy,p.w,p.h,ox+p.x/dpr,oy+p.y/dpr,p.w/dpr,p.h/dpr);
  if (image && atlas) for (const p of faces.placements(engine,atlas,screen.occludes,!tile,hull.drawn(style,L?.a ?? 0)))
    ctx.drawImage(image,p.sx,p.sy,p.w,p.h,ox+p.x/dpr,oy+p.y/dpr,p.w/dpr,p.h/dpr);
  if (touch) document.querySelector('[data-key="up"]').classList.toggle("down",engine.keys.up);
}
let last = 0;
function frame(now) {
  engine.tick(Math.min(0.1,(now-(last||now))/1000)); last=now;
  draw(); requestAnimationFrame(frame);
}
const KEY = {ArrowUp:"thrust",KeyW:"thrust",Space:"thrust",ArrowLeft:"left",KeyA:"left",ArrowRight:"right",KeyD:"right",ArrowDown:"cut",KeyS:"cut",Enter:"advance",KeyP:"pause",KeyR:"restart",KeyQ:"restart",Escape:"restart"};
addEventListener("keydown",e => {
  if (e.target instanceof Element && e.target.closest(".language-picker")) return;
  if (!engine || e.metaKey || e.ctrlKey || e.altKey) return;
  const input = KEY[e.code];
  if (!input) return;
  e.preventDefault();
  if (e.repeat && input !== "left" && input !== "right") return;
  engine.press(input);
});
const release = () => {if (engine?.game.state === "flying") {engine.keys.up=false;engine.game.paused=true;}};
addEventListener("blur",release);
document.addEventListener("visibilitychange",() => document.hidden && release());
canvas.addEventListener("pointerdown",() => {if (engine?.game.state !== "flying" || engine.game.paused) engine?.press("advance");});
if (touch) {
  document.getElementById("touch").classList.add("on");
  for (const button of document.querySelectorAll(".touch button")) {
    let repeat;
    const input = button.dataset.key === "up" ? "thrust" : button.dataset.key;
    button.addEventListener("pointerdown",e => {
      e.preventDefault();e.stopPropagation();button.setPointerCapture(e.pointerId);engine?.press(input);
      if (input !== "thrust") {button.classList.add("down");clearInterval(repeat);repeat=setInterval(() => engine?.press(input),90);}
    });
    for (const event of ["pointerup","pointercancel","lostpointercapture"]) button.addEventListener(event,() => {clearInterval(repeat);if(input!=="thrust") button.classList.remove("down");});
  }
}
addEventListener("resize",() => {if (!engine) return; if(engine.game.state === "title") engine.title(); else fit();});
const fonts = Promise.all([document.fonts.load(`16px ${FONT}`),document.fonts.load(`700 16px ${FONT}`)]);
Promise.race([fonts,new Promise(r => setTimeout(r,1500))]).finally(() => {
  measure();let best=0;
  try {best=Number(localStorage.getItem("corgi.moonlander.best"))||0;} catch {}
  engine=moonlander.create({size:grid,aspect:EM.h/EM.w,best,changed:()=>{if(engine) fit();},saveBest:score=>{try{localStorage.setItem("corgi.moonlander.best",String(score));}catch{}}});
  engine.title();requestAnimationFrame(frame);
});
