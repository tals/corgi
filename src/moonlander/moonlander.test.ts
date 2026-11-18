import { expect, test } from "bun:test";
import * as moonlander from "./moonlander";

function create(saveBest?: (score: number) => void) {
  let seed = 12345;
  const engine = moonlander.create({
    size: () => ({ cols: 100, rows: 40 }),
    aspect: 2.2,
    random: () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    },
    saveBest,
  });
  engine.title();
  return engine;
}

function approach(engine: moonlander.Engine) {
  engine.launch(1);
  const pad = engine.world.pads[0],
    lander = engine.lander!;
  Object.assign(lander, { x: (pad.x0 + pad.x1) / 2, y: pad.y - 10 * engine.world.K - 0.1, vx: 0, vy: 2, a: 0 });
  return { pad, lander };
}

test("terrain wraps and landing pads remain flat and inside the world", () => {
  const engine = create();
  for (const cols of [72, 80, 100, 200]) {
    const sized = moonlander.create({ size: () => ({ cols, rows: 24 }), aspect: 2.2 });
    for (const round of [1, 8, 20]) {
      sized.launch(round);
      const { world } = sized;
      expect(world.ground(-0.25)).toBeCloseTo(world.ground(world.W - 0.25));
      expect(world.ground(world.W + 0.25)).toBeCloseTo(world.ground(0.25));
      for (const pad of world.pads) {
        expect(pad.x0).toBeGreaterThanOrEqual(0);
        expect(pad.x1).toBeLessThan(world.W);
        for (let x = pad.x0; x <= pad.x1; x++) expect(world.ground(x)).toBe(pad.y);
      }
    }
  }
  expect(engine.game.state).toBe("title");
});

test("thrust burns fuel and overcomes gravity; a pause freezes the simulation", () => {
  const engine = create();
  engine.launch(1);
  const lander = engine.lander!,
    before = { ...lander };
  engine.keys.up = true;
  for (let i = 0; i < 5; i++) engine.tick(0.1);
  expect(lander.fuel).toBeCloseTo(before.fuel - 30);
  expect(lander.vy).toBeCloseTo(before.vy + (moonlander.G - moonlander.THRUST) * 0.5);
  engine.game.paused = true;
  const frozen = { ...lander },
    time = engine.game.t;
  engine.tick(0.1);
  engine.tilt(1);
  expect(lander).toEqual(frozen);
  expect(engine.game.t).toBe(time);
});

test("fixed steps give the same flight at different rendering cadences", () => {
  const a = create(),
    b = create();
  a.launch(1);
  b.launch(1);
  a.keys.up = b.keys.up = true;
  for (let i = 0; i < 60; i++) a.tick(1 / 120);
  for (let i = 0; i < 15; i++) b.tick(1 / 30);
  expect(a.lander).toEqual(b.lander);
  expect(a.game.t).toBe(b.game.t);
  expect(a.cameraY).toBe(b.cameraY);
});

test("the camera follows an ascending ship past the old ceiling and returns during descent", () => {
  for (const angle of [-Math.PI / 2, 0, Math.PI / 2]) {
    const engine = create();
    engine.launch(1);
    const L = engine.lander!,
      R = 4 * engine.world.K;
    expect(engine.cameraY).toBe(0);
    Object.assign(L, { vx: 0, vy: -40, a: angle });
    for (let i = 0; i < 30; i++) {
      engine.tick(0.1);
      expect(engine.game.state).toBe("flying");
      for (const cell of engine.shipCells(L).cells.values())
        for (let bit = 0; bit < 8; bit++)
          if (cell.bits & (1 << bit))
            expect((cell.row * 4 + Math.floor(bit / 2)) * engine.world.K - engine.cameraY).toBeGreaterThanOrEqual(
              3 * R,
            );
    }
    expect(L.y).toBeLessThan(-40);
    expect(L.vy).toBeLessThan(0);
    expect(engine.cameraY).toBeLessThan(0);
    for (let i = 0; i < 90 && engine.cameraY < 0; i++) engine.tick(0.1);
    expect(engine.cameraY).toBe(0);
    expect(engine.game.state).toBe("flying");
  }
});

test("new rounds and the title reset the camera", () => {
  const engine = create();
  for (const reset of [() => engine.launch(2), () => engine.title()]) {
    engine.launch(1);
    Object.assign(engine.lander!, { y: -100, vx: 0, vy: -1 });
    engine.tick(moonlander.STEP);
    expect(engine.cameraY).toBeLessThan(0);
    reset();
    expect(engine.cameraY).toBe(0);
  }
});

test("a soft landing awards pad and fuel points, saves the best, then advances a round", () => {
  const saved: number[] = [],
    engine = create(score => saved.push(score));
  const { pad } = approach(engine);
  engine.tick(0.1);
  expect(engine.game.state).toBe("landed");
  expect(engine.game.result?.soft).toBe(true);
  expect(engine.game.score).toBe(100 * pad.mult + 80);
  expect(saved).toEqual([engine.game.score]);
  const score = engine.game.score;
  engine.advance();
  expect(engine.game.state).toBe("landed");
  for (let i = 0; i < 200 && !engine.settled(); i++) engine.tick(0.1);
  expect(engine.settled()).toBe(true);
  expect(engine.corgi?.air).toBe(false);
  engine.advance();
  expect(engine.game.state).toBe("flying");
  expect(engine.game.round).toBe(2);
  expect(engine.game.score).toBe(score);
  expect(engine.lander?.fuelMax).toBe(750);
});

test("unsafe approaches crash into debris and recover to a fresh attempt", () => {
  for (const velocity of [{ vy: 20 }, { vx: 10 }, { a: 0.5 }]) {
    const engine = create();
    const { lander } = approach(engine);
    Object.assign(lander, velocity);
    engine.tick(0.1);
    expect(engine.game.state).toBe("crashed");
    expect(engine.lander).toBeNull();
    expect(engine.debris.length).toBeGreaterThan(0);
    expect(engine.corgi?.crashed).toBe(true);
    expect(engine.game.result?.why).toBeTruthy();
    for (let i = 0; i < 80; i++) engine.tick(0.1);
    expect(engine.corgi?.air).toBe(false);
    engine.advance();
    expect(engine.game.state).toBe("flying");
    expect(engine.game.score).toBe(0);
  }
});

test("terminal and browser share launch, thrust toggles, tilt steps and pause controls", () => {
  const engine = create();
  engine.press("thrust");
  expect(engine.game.state).toBe("flying");
  expect(engine.keys.up).toBe(false);
  engine.press("thrust");
  expect(engine.keys.up).toBe(true);
  engine.press("left");
  expect(engine.lander!.a).toBe(-0.12);
  engine.press("right");
  expect(engine.lander!.a).toBe(0);
  engine.press("cut");
  expect(engine.keys.up).toBe(false);
  engine.press("pause");
  expect(engine.game.paused).toBe(true);
  engine.press("thrust");
  expect(engine.game.paused).toBe(false);
  expect(engine.keys.up).toBe(false);
  engine.press("restart");
  expect(engine.game.state).toBe("title");
  expect(engine.keys.up).toBe(false);
});

test("a tilt either way draws the same outline mirrored", () => {
  const engine = create();
  engine.launch(1);
  for (let step = 0; step <= 13; step++) {
    const lit = engine.shipDots(step * 0.12).map(([x, y]) => x + "," + y),
      mirrored = engine.shipDots(-step * 0.12).map(([x, y]) => -1 - x + "," + y);
    expect(mirrored.sort()).toEqual(lit.sort());
  }
});

test("while panned, the camera keeps the ship's top within four rows below its follow line", () => {
  const engine = create();
  engine.launch(1);
  const L = engine.lander!,
    R = 4 * engine.world.K;
  Object.assign(L, { vx: 0, vy: -40, a: 0 });
  let up = 0,
    down = 0;
  for (let i = 0; i < 500 && engine.game.state === "flying"; i++) {
    const vy = L.vy;
    engine.tick(0.02);
    if (engine.cameraY >= 0) continue;
    const top = L.y - moonlander.SHIP.top - engine.cameraY;
    expect(top).toBeGreaterThanOrEqual(3.75 * R - 1e-6);
    expect(top).toBeLessThanOrEqual(7.75 * R + 1e-6);
    if (vy < 0) up++;
    else down++;
  }
  expect(up).toBeGreaterThan(10);
  expect(down).toBeGreaterThan(10);
});

function landOn(seed: number) {
  const engine = moonlander.create({
    size: () => ({ cols: 100, rows: 40 }),
    aspect: 2.2,
    random: () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    },
  });
  approach(engine);
  return engine;
}

test("after a landing the corgi digs a bone up off the pad, piles the dirt behind it and eats it", () => {
  let dug = 0,
    infront = 0,
    beside = 0;
  for (let seed = 1; seed <= 12; seed++) {
    let ship = 0;
    const engine = landOn(seed * 7919),
      { world } = engine,
      before = Float64Array.from(world.g);
    let bone: moonlander.Bone | null = null;
    for (let i = 0; i < 20 / moonlander.STEP; i++) {
      engine.tick(moonlander.STEP);
      bone = engine.bone ?? bone;
      const d = engine.corgi;
      if (!d?.pose || d.air) continue;
      // On its legs, never in the ground or over it.
      const length = [...d.pose].length,
        [from, to] = length < 7 ? [-2, 2] : d.facing > 0 ? [-2, 1] : [-1, 2],
        col = engine.cellOf(d.x);
      let floor = Infinity,
        heaped = Infinity;
      for (let o = from; o <= to; o++) {
        const c = moonlander.mod(col + o, world.cols);
        floor = Math.min(floor, engine.pile![c]);
        heaped = Math.min(
          heaped,
          Math.round(Math.min(...[0, 1, 2].map(i => world.g[2 * c + i])) / (4 * world.K) - 0.77),
        );
      }
      expect(d.row).toBe(floor);
      // Chewing, it sits on solid ground, level with the bone.
      if (d.pose === moonlander.POSE.chew && engine.bone && !engine.bone.held) {
        expect(engine.bone.row).toBe(d.row);
        for (let o = from; o <= to; o++) expect(engine.pile![moonlander.mod(col + o, world.cols)]).toBe(d.row);
      }
      // In front of the dirt it dug, not on it.
      if (heaped < floor) infront++;
      // Hardly ever in front of the ship while it digs and eats.
      const L = engine.lander!,
        span = [...d.pose].length,
        start = col + (d.facing > 0 ? -3 : 4 - span);
      // Never off the edge of the screen.
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + span).toBeLessThanOrEqual(world.cols);
      let cells = 0;
      for (let k = 0; k < span; k++) {
        const x = moonlander.mod(start + k, world.cols) * 2 + 1;
        if (Math.abs(moonlander.mod(x - L.x + world.W / 2, world.W) - world.W / 2) < moonlander.SHIP.body) cells++;
      }
      if (engine.bone) ship = Math.max(ship, cells);
    }
    expect(ship).toBeLessThanOrEqual(3);
    if (ship) beside++;
    // These moons have room to dig off the pads, though dirt may land on one.
    for (const pad of world.pads) for (let x = pad.x0; x <= pad.x1; x++) expect(world.g[x]).toBeLessThanOrEqual(pad.y);
    if (!bone) {
      expect(engine.corgi?.pose).toBe(moonlander.POSE.sit);
      continue;
    }
    dug++;
    expect(bone.eaten).toBe(3);
    expect(engine.bone).toBeNull();
    expect([moonlander.POSE.sit, moonlander.POSE.blink]).toContain(engine.corgi!.pose!);
    let carved = 0,
      piled = 0;
    for (let i = 0; i < world.W; i++) {
      const change = world.g[i] - before[i];
      if (change > 0) carved += change;
      else piled -= change;
    }
    // No pillar a row tall left standing where it dug, as under its head.
    for (let i = 1; i < world.W - 1; i++)
      if (world.g[i] !== before[i] || world.g[i - 1] !== before[i - 1] || world.g[i + 1] !== before[i + 1])
        expect(Math.min(world.g[i - 1], world.g[i + 1]) - world.g[i]).toBeLessThan(4 * world.K);
    // A row or so of it, all piled up behind.
    expect(carved).toBeGreaterThan(3 * 4 * world.K - 1e-6);
    expect(piled).toBeCloseTo(carved, 6);
  }
  expect(dug).toBeGreaterThanOrEqual(9);
  expect(infront).toBeGreaterThan(0);
  expect(beside).toBeLessThanOrEqual(2);
});

test("with autoland each flight starts over a pad and lands softly about a second in", () => {
  const engine = moonlander.create({ size: () => ({ cols: 100, rows: 40 }), aspect: 2.2, autoland: true });
  for (const round of [1, 2, 9]) {
    engine.launch(round);
    let t = 0;
    for (; engine.game.state === "flying" && t < 2; t += moonlander.STEP) engine.tick(moonlander.STEP);
    expect(engine.game.state).toBe("landed");
    expect(engine.game.result?.soft).toBe(true);
    expect(t).toBeGreaterThan(0.8);
    expect(t).toBeLessThan(1.2);
  }
});

test("advance and thrust cannot skip the wait for the corgi to eat its bone", () => {
  const patient = landOn(7919);
  patient.tick(0.1);
  expect(patient.game.state).toBe("landed");
  let dug = false;
  for (let i = 0; i < 20 / 0.1 && !patient.settled(); i++) {
    patient.press("advance");
    patient.press("thrust");
    expect(patient.settled()).toBe(false);
    expect(patient.game.state).toBe("landed");
    patient.tick(0.1);
    dug ||= patient.bone !== null;
  }
  expect(dug).toBe(true);
  expect(patient.settled()).toBe(true);
  expect(patient.bone).toBeNull();
  expect(patient.game.state).toBe("landed");
  patient.press("advance");
  expect(patient.game.state).toBe("flying");
  expect(patient.game.round).toBe(2);
});

/** A moon whose pads stand on mesas over a chasm too deep to climb out of:
 * the corgi can dig nowhere but into its own pad. */
function mesa() {
  const engine = moonlander.create({ size: () => ({ cols: 100, rows: 40 }), aspect: 2.2, random: () => 0.5 });
  engine.launch(1);
  const { world } = engine,
    pad = world.pads.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
  for (const p of world.pads) {
    p.y = world.H * 0.5;
    for (let i = p.x0; i <= p.x1; i++) world.g[i] = p.y;
  }
  for (let i = 0; i <= world.W; i++) if (!world.pads.some(p => i >= p.x0 && i <= p.x1)) world.g[i] = world.H - world.K;
  Object.assign(engine.lander!, { x: (pad.x0 + pad.x1) / 2, y: pad.y - 10 * world.K - 0.1, vx: 0, vy: 2, a: 0 });
  return { engine, pad };
}

test("with nowhere else to dig, the corgi digs into the end of its own pad", () => {
  const { engine, pad } = mesa(),
    { world } = engine;
  let dug = false;
  for (let i = 0; i < 25 / 0.05 && !(dug && !engine.bone); i++) {
    engine.tick(0.05);
    dug ||= engine.bone !== null;
  }
  expect(dug).toBe(true);
  expect(engine.bone).toBeNull();
  const holes = [];
  for (let x = pad.x0; x <= pad.x1; x++) if (world.g[x] > pad.y + 1e-9) holes.push(x);
  expect(holes.length).toBeGreaterThan(0);
  // At one end of it, and nowhere else.
  expect(Math.min(holes[0] - pad.x0, pad.x1 - holes.at(-1)!)).toBeLessThanOrEqual(4);
  for (const other of world.pads.filter(p => p !== pad))
    for (let x = other.x0; x <= other.x1; x++) expect(world.g[x]).toBe(other.y);
});

test("with a hill beside the pad, the corgi digs into it, the hillside slides in, and it never walks off the screen", () => {
  // A hill rising from the pad's left end, and ground falling away to the
  // right, toward the edge of the screen.
  const engine = moonlander.create({ size: () => ({ cols: 80, rows: 40 }), aspect: 2.2, random: () => 0.5 });
  engine.launch(1);
  const { world } = engine,
    R = 4 * world.K,
    pad = { x0: world.W - 70, x1: world.W - 36, y: 24 * R, mult: 3 };
  world.pads.splice(0, world.pads.length, pad);
  for (let i = 0; i <= world.W; i++)
    world.g[i] =
      i < pad.x0
        ? pad.y - Math.min(9 * R, (pad.x0 - i) * 0.35 * R)
        : i <= pad.x1
          ? pad.y
          : pad.y + Math.min(9 * R, (i - pad.x1) * 0.25 * R);
  const before = Float64Array.from(world.g);
  Object.assign(engine.lander!, { x: (pad.x0 + pad.x1) / 2, y: pad.y - 10 * world.K - 0.1, vx: 0, vy: 2, a: 0 });
  let dug = false,
    buried = false;
  for (let i = 0; i < 25 / 0.05 && !(dug && !engine.bone); i++) {
    engine.tick(0.05);
    const d = engine.corgi;
    if (d?.pose) {
      const span = [...d.pose].length,
        from = engine.cellOf(d.x) + (d.facing > 0 ? -3 : 4 - span);
      expect(from).toBeGreaterThanOrEqual(0);
      expect(from + span).toBeLessThanOrEqual(world.cols);
    }
    dug ||= engine.bone !== null;
    buried ||= !!engine.bone && engine.bone.shown.some(at => at !== null) && engine.bone.shown.some(at => at === null);
  }
  expect(engine.bone).toBeNull();
  // Into the hill, at the pad's left, its face slumped no steeper than dirt stands.
  let deepest = 0,
    steepest = 0;
  for (let i = 1; i < pad.x0; i++) {
    deepest = Math.max(deepest, world.g[i] - before[i]);
    if (world.g[i] > before[i] + 1e-6 && world.g[i - 1] > before[i - 1] + 1e-6)
      steepest = Math.max(steepest, world.g[i] - world.g[i - 1]);
  }
  expect(deepest).toBeGreaterThan(R);
  expect(steepest).toBeLessThanOrEqual(3.1 * world.K + 1e-6);
  for (let i = pad.x1 + 1; i < world.W; i++) expect(world.g[i]).toBeLessThanOrEqual(before[i] + 1e-6);
});
