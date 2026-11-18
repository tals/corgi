import * as moonlander from "../moonlander/moonlander";

/** Random numbers that repeat from `seed`, so a moon comes out the same each run. */
export function seeded(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** A first flight on a `cols`-wide screen, over a moon made without chance. */
export function flight(cols = 72): moonlander.Engine {
  const engine = moonlander.create({ size: () => ({ cols, rows: 40 }), aspect: 2.2, random: () => 0.5 });
  engine.launch(1);
  return engine;
}

/** Puts the ship just above `pad`, sinking onto it slowly enough to land. */
export function over(engine: moonlander.Engine, pad = engine.world.pads[0]): void {
  Object.assign(engine.lander!, { x: (pad.x0 + pad.x1) / 2, y: pad.y - 10 * engine.world.K - 0.1, vx: 0, vy: 2, a: 0 });
}

/** A moon whose pads stand on mesas over a chasm too deep to climb out of:
 * the corgi can dig nowhere but into its own pad. */
export function mesa() {
  const engine = flight(100),
    { world } = engine,
    pad = world.pads.reduce((a, b) => (b.x1 - b.x0 > a.x1 - a.x0 ? b : a));
  for (const p of world.pads) {
    p.y = world.H * 0.5;
    for (let i = p.x0; i <= p.x1; i++) world.g[i] = p.y;
  }
  for (let i = 0; i <= world.W; i++) if (!world.pads.some(p => i >= p.x0 && i <= p.x1)) world.g[i] = world.H - world.K;
  over(engine, pad);
  return { engine, pad };
}
