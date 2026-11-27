import type { Envelope } from "./plan_protocol";

/** Indentation quotes every source line, so source text cannot introduce headers. */
export function encode(input: Envelope) {
  const { support, events, ...metadata } = input;
  const section = (name: string, rows: Envelope["events"]) =>
    [
      name,
      ...rows.flatMap(([id, turn, kind, body]) => [
        `@${id} ${turn} ${kind}`,
        ...body.split("\n").map(line => " " + line),
      ]),
    ].join("\n");
  return [JSON.stringify(metadata), section("support", support), section("events", events)].join("\n");
}
