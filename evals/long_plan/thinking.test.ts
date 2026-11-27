import { expect, test } from "bun:test";
import { Thinking } from "./thinking";
import { Stdio } from "../../src/providers/stdio";

test("effort experiments change the launched effort and preserve the production command", () => {
  const original = Stdio.spawn,
    calls: string[][] = [],
    command = ["claude", "--effort", "low", "--model", "claude-haiku-5-5", "--system-prompt", "Keep the rules."];
  Stdio.spawn = args => {
    calls.push(args);
    return Object.create(Stdio.prototype);
  };
  const experiment = new Thinking("high");
  try {
    Stdio.spawn(command, { cwd: "/tmp" });
    expect(command[2]).toBe("low");
    expect(calls[0]).toEqual([
      "claude",
      "--model",
      "claude-haiku-5-5",
      "--system-prompt",
      "Keep the rules.",
      "--effort",
      "high",
    ]);
    expect(experiment.launches).toEqual([{ model: "claude-haiku-5-5", effort: "high" }]);
    expect(() => Stdio.spawn(["another-process"], { cwd: "/tmp" })).toThrow("UnexpectedInferenceLaunch");
    experiment.close();
    Stdio.spawn(command, { cwd: "/tmp" });
    expect(calls[1]).toEqual(command);
  } finally {
    experiment.close();
    Stdio.spawn = original;
  }
});
