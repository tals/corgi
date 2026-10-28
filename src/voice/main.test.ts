import { test, expect } from "bun:test";
import { flags, message } from "./main";
import { exitError } from "./bridge";
import * as config from "../build_config";

test("flags override settings within their ranges", () => {
  expect(
    flags([
      "--ssh",
      "devbox",
      "--model",
      "small.en",
      "--threshold",
      "60",
      "--silence",
      "1.5",
      "--port",
      "9000",
      "--device",
      "1",
      "--no-filter",
      "--verbose",
    ]),
  ).toEqual({
    ssh: "devbox",
    model: "small.en",
    threshold: 60,
    silence: 1.5,
    port: 9000,
    device: "1",
    speech_filter: false,
    verbose: true,
  });
  expect(flags([])).toEqual({});
  for (const bad of [
    ["--model", "large"],
    ["--threshold", "101"],
    ["--threshold", "4.5"],
    ["--silence", "0.2"],
    ["--port", "80"],
    ["--port", ""],
    ["--ssh", "-oProxyCommand=x"],
    ["--ssh"],
    ["--device"],
    ["--bogus"],
  ])
    expect(() => flags(bad)).toThrow("Usage");
});

test("startup failures read as the CLI contract words them", () => {
  const local = { model: "base.en", port: 8234 },
    remote = { ...local, ssh: "devbox" };
  const say = (name: string, s: { model: string; port: number | null; ssh?: string } = local) =>
    message(Error(name), s);
  expect(say("ModelMissing")).toBe("voice model base.en is not installed; run: corgi voice setup --model base.en");
  expect(say("PortInUse")).toBe(
    'port 8234 is in use; set another "port" in voice.json, pass --port, or leave it unset',
  );
  expect(say("PortInUse", { model: "base.en", port: null })).toBe(
    "whisper-server's port was taken as it started; start voice mode again",
  );
  expect(say("LocalTooOld", { ...local, ssh: "devbox" })).toBe(
    "Corgi on devbox speaks a newer voice bridge; update Corgi here",
  );
  expect(say("DaemonLacksVoice")).toBe("this Corgi daemon has no voice support; reload it with: corgi reload");
  expect(say("VoiceAttached")).toBe("another voice session is already attached to this runtime");
  expect(say("NoRuntime")).toBe("no Corgi runtime is running");
  expect(say("NoRuntime", remote)).toBe("no Corgi runtime is running on devbox");
  expect(say("RemoteTooOld", remote)).toBe(
    `Corgi on devbox has no voice support; install Corgi ${config.releaseVersion} or newer there`,
  );
  expect(say("WhisperMissing")).toStartWith("whisper-server not found; install: ");
  expect(message(Object.assign(Error("SshFailed"), { detail: "Permission denied" }), remote)).toBe(
    "could not reach devbox: Permission denied",
  );
});

test("how ssh ended says why the bridge never answered", () => {
  expect(exitError(2, "corgi: unknown command __voice-bridge; see corgi --help\n").message).toBe("RemoteTooOld");
  expect(exitError(127, "").message).toBe("RemoteMissing");
  expect(exitError(1, "sh: corgi: not found\n").message).toBe("RemoteMissing");
  const ssh = exitError(255, "ssh: connect to host devbox port 22: Connection refused\x1b]0;x\x07\n");
  expect(ssh.message).toBe("SshFailed");
  expect((ssh as { detail?: string }).detail).toBe("ssh: connect to host devbox port 22: Connection refused ]0;x ");
});
