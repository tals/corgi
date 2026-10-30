/** Real ReadyLoop with an isolated old/new readiness DSO; Linux only. */
import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dlopen, JSCallback, ptr, type Pointer } from "bun:ffi";
import { native, ReadyLoop, READ, WRITE, wouldBlock } from "../../src/fd_loop";
import { n, pair } from "../../src/native_ffi";
import * as benchmark from "./cpu_lock";

const library = resolve(process.argv[2]),
  scenario = process.argv[3],
  diagnostic = process.argv.includes("--diagnostic"),
  directCallback = process.argv.includes("--callback"),
  verifyOnly = process.argv.includes("--verify-only"),
  warmup = diagnostic ? 0 : Number(process.env.READINESS_WARMUP ?? 3),
  seconds = diagnostic ? 4 : Number(process.env.READINESS_SECONDS ?? 10),
  lanes = 16,
  recordSize = 128,
  ticks = Math.ceil((warmup + seconds) * 20) + 4,
  bytesPerLane = ticks * recordSize;
assert.ok(scenario === "aligned" || scenario === "staggered");
assert.ok(seconds > 0 && warmup >= 0);
const replacement = dlopen(library, {
    fd_loop_new: { args: ["ptr"], returns: "ptr" },
    fd_loop_arm: { args: ["ptr", "i32", "u32", "u32"], returns: "i32" },
    fd_loop_free: { args: ["ptr"], returns: "void" },
    fd_cloexec: { args: ["i32"], returns: "i32" },
    bench_counts: { args: ["ptr"], returns: "void" },
    bench_set_callback: { args: ["ptr"], returns: "void" },
    bench_notifications: { args: ["ptr", "u32"], returns: "u32" },
    bench_enqueue: { args: ["ptr", "u32", "u32"], returns: "i32" },
    bench_defer: { args: ["u32", "u32"], returns: "ptr" },
    bench_defer_join: { args: ["ptr"], returns: "void" },
    bench_now_ns: { args: [], returns: "u64" },
    bench_ready_cpu: { args: ["ptr"], returns: "u64" },
    bench_producer: { args: ["ptr", "u32", "i32", "i32", "ptr"], returns: "ptr" },
    bench_producer_start: { args: ["ptr"], returns: "u64" },
    bench_producer_cpu: { args: ["ptr"], returns: "u64" },
    bench_producer_error: { args: ["ptr"], returns: "i32" },
    bench_producer_free: { args: ["ptr"], returns: "void" },
  }),
  helper = replacement.symbols,
  original = { ...native },
  release = await benchmark.acquire();
let loop: ReadyLoop | null = null,
  producer: Pointer | bigint | null = null,
  deferred: Pointer | bigint | null = null,
  bridge: JSCallback | null = null;
let closed = false,
  lateIgnored = 0;
const fds: number[] = [],
  watches: ReturnType<ReadyLoop["watch"]>[] = [],
  offsets = new Uint32Array(lanes),
  expected = Buffer.alloc(lanes * bytesPerLane),
  received = Array.from({ length: lanes }, () => Buffer.alloc(bytesPerLane)),
  latency = new Float64Array(lanes * ticks),
  counts = new BigUint64Array(75),
  notificationLog = Buffer.alloc(131072),
  nativeLog = new Uint32Array(32768);
let dataCallbacks = 0,
  notificationBytes = 0,
  readinessCallbacks = 0,
  partialChunks = 0,
  carry = 0,
  failure: Error | null = null;
function sha(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function recordNotification(token: number, events: number) {
  assert.ok(notificationBytes + 8 <= notificationLog.length, "notification log overflow");
  notificationLog.writeUInt32LE(token, notificationBytes);
  notificationLog.writeUInt32LE(events, notificationBytes + 4);
  notificationBytes += 8;
}
function snapshot() {
  helper.bench_counts(ptr(counts));
  return Array.from(counts, Number);
}
function check() {
  if (failure) throw failure;
  assert.equal(helper.bench_producer_error(producer), 0, "producer write failure");
}
async function until(deadline: bigint) {
  for (;;) {
    check();
    const left = Number(deadline - BigInt(helper.bench_now_ns())) / 1e6;
    if (left <= 0) return;
    await Bun.sleep(Math.min(left, 100));
  }
}
async function verifyCallback() {
  assert.ok(directCallback && loop && bridge);
  const [fd, peer] = pair();
  fds.push(fd, peer);
  let stale = 0;
  const oldToken = loop["next"],
    old = loop.watch(fd, () => stale++);
  watches.push(old);
  const initial = new Uint32Array([oldToken]);
  assert.equal(helper.bench_enqueue(ptr(initial), 1, READ), 0);
  old.close();
  const delivered: number[] = [],
    tokens = new Uint32Array(64),
    activeToken = loop["next"],
    active = loop.watch(fd, events => {
      assert.equal(events, READ);
      delivered.push(activeToken);
    });
  watches.push(active);
  const [otherFd, otherPeer] = pair();
  fds.push(otherFd, otherPeer);
  const otherToken = loop["next"],
    other = loop.watch(otherFd, events => {
      assert.equal(events, READ);
      delivered.push(otherToken);
    });
  watches.push(other);
  for (let i = 0; i < tokens.length; i++) tokens[i] = i % 3 === 0 ? oldToken : i % 2 ? activeToken : otherToken;
  assert.equal(helper.bench_enqueue(ptr(tokens), tokens.length, READ), 0);
  const wanted = Array.from(tokens).filter(token => token !== oldToken),
    deadline = Date.now() + 2000;
  while (delivered.length < wanted.length) {
    assert.ok(Date.now() < deadline, "queued callbacks were lost");
    await Bun.sleep(1);
  }
  assert.deepEqual(delivered, wanted, "foreign producer callback order");
  assert.equal(stale, 0, "closed token delivered after same-fd registration");
  active.close();
  other.close();
  let direction = 0,
    finishDuplex!: () => void;
  const duplexDone = new Promise<void>(resolve => (finishDuplex = resolve)),
    byte = Buffer.from([91]),
    read = Buffer.alloc(1),
    duplex = loop.watch(fd, events => {
      if (direction === 0) {
        assert.ok(events & WRITE, "initial writable readiness");
        direction++;
        assert.equal(n.probe_write(peer, ptr(byte), 1), 1);
        duplex.arm(READ);
      } else {
        assert.equal(direction++, 1, "duplicate readiness after changed interest");
        assert.ok(events & READ, "rearmed readable readiness");
        assert.equal(n.probe_read(fd, ptr(read), 1), 1);
        assert.ok(read.equals(byte));
        duplex.close();
        finishDuplex();
      }
    });
  watches.push(duplex);
  duplex.arm(READ | WRITE);
  await duplexDone;
  // No JS timer is pending while awaiting this foreign-thread callback.
  const deferredToken = loop["next"];
  let wake!: () => void;
  const pending = new Promise<void>(resolve => (wake = resolve)),
    lifetime = loop.watch(fd, () => wake());
  watches.push(lifetime);
  assert.equal(loop["socket"].destroyed, false);
  deferred = helper.bench_defer(deferredToken, READ)!;
  assert.ok(deferred);
  await pending;
  helper.bench_defer_join(deferred);
  deferred = null;
  lifetime.close();
  const closeToken = loop["next"],
    last = loop.watch(fd, () => {
      throw Error("callback ran after loop close");
    }),
    queued = new Uint32Array(50).fill(closeToken);
  watches.push(last);
  assert.equal(helper.bench_enqueue(ptr(queued), queued.length, READ), 0);
  closed = true;
  loop.close(); // Clears map, joins native reporter, closes the keepalive Socket.
  bridge.close(); // Bun still delivers already queued invocations.
  bridge = null;
  helper.bench_set_callback(null);
  const closeDeadline = Date.now() + 2000;
  while (lateIgnored < queued.length) {
    assert.ok(Date.now() < closeDeadline, "queued invocation retirement timeout");
    await Bun.sleep(1);
  }
  assert.equal(lateIgnored, queued.length);
  return {
    queued_order: true,
    stale_token_ignored: true,
    read_write_rearm: direction === 2,
    idle_socket_keepalive: true,
    close_with_queued: lateIgnored,
  };
}
async function measure() {
  assert.ok(loop);
  if (diagnostic)
    loop["socket"].on("data", (chunk: Buffer) => {
      dataCallbacks++;
      assert.ok(!directCallback, "callback transport wrote to idle Socket");
      assert.ok(notificationBytes + chunk.length <= notificationLog.length, "notification log overflow");
      chunk.copy(notificationLog, notificationBytes);
      notificationBytes += chunk.length;
      if (carry || chunk.length % 8) partialChunks++;
      carry = (carry + chunk.length) % 8;
    });
  const peers = new Int32Array(lanes);
  for (let lane = 0; lane < lanes; lane++) {
    const [fd, peer] = pair(),
      scratch = Buffer.alloc(4096);
    fds.push(fd, peer);
    peers[lane] = peer;
    const watch = loop.watch(fd, () => {
      try {
        readinessCallbacks++;
        for (;;) {
          const count = n.probe_read(fd, ptr(scratch), scratch.length);
          if (count === -4) continue;
          if (count <= 0) {
            if (count === 0) return;
            assert.ok(wouldBlock(count), `unexpected read ${count}`);
            break;
          }
          const before = offsets[lane];
          assert.ok(before + count <= bytesPerLane, "unexpected bytes");
          scratch.copy(received[lane], before, 0, count);
          offsets[lane] += count;
          if (diagnostic) {
            const at = BigInt(helper.bench_now_ns());
            for (
              let sequence = Math.floor(before / recordSize);
              sequence < Math.floor(offsets[lane] / recordSize);
              sequence++
            ) {
              const sent = received[lane].readBigUInt64LE(sequence * recordSize + 8);
              assert.ok(sent > 0n && at >= sent);
              latency[lane * ticks + sequence] = Number(at - sent) / 1000;
            }
          }
        }
        watch.arm(READ);
      } catch (error) {
        failure = error instanceof Error ? error : Error(String(error));
      }
    });
    watches.push(watch);
    watch.arm(READ);
  }
  producer = helper.bench_producer(
    ptr(peers),
    ticks,
    Number(scenario === "staggered"),
    Number(diagnostic),
    ptr(expected),
  )!;
  assert.ok(producer);
  const begin = BigInt(helper.bench_producer_start(producer));
  await until(begin + BigInt(Math.round(warmup * 1e9)));
  const countsBefore = snapshot(),
    bytesBefore = Array.from(offsets),
    callbacksBefore = readinessCallbacks,
    cpuBefore = process.cpuUsage(),
    readyBefore = BigInt(helper.bench_ready_cpu(loop["handle"])),
    producerBefore = BigInt(helper.bench_producer_cpu(producer)),
    atBefore = BigInt(helper.bench_now_ns()),
    phaseEpoch = Date.now();
  await until(begin + BigInt(Math.round((warmup + seconds) * 1e9)));
  const atAfter = BigInt(helper.bench_now_ns()),
    producerAfter = BigInt(helper.bench_producer_cpu(producer)),
    readyAfter = BigInt(helper.bench_ready_cpu(loop["handle"])),
    cpu = process.cpuUsage(cpuBefore),
    measured = Number(atAfter - atBefore) / 1e9,
    countsAfter = snapshot(),
    deltas = countsAfter.map((value, index) => value - countsBefore[index]),
    delivered = Array.from(offsets, (value, lane) => (value - bytesBefore[lane]) / recordSize),
    callbacksAfter = readinessCallbacks;
  const done = begin + BigInt(ticks * 50_000_000 + 2_000_000_000);
  while (offsets.some(offset => offset !== bytesPerLane)) {
    check();
    assert.ok(BigInt(helper.bench_now_ns()) < done, "missing progress");
    await Bun.sleep(1);
  }
  check();
  for (let lane = 0; lane < lanes; lane++) {
    assert.equal(offsets[lane], bytesPerLane);
    assert.ok(
      received[lane].equals(expected.subarray(lane * bytesPerLane, (lane + 1) * bytesPerLane)),
      `lane ${lane} bytes`,
    );
    assert.ok(delivered[lane] / measured > 19 && delivered[lane] / measured < 21, `lane ${lane} cadence`);
  }
  if (diagnostic) await Bun.sleep(5);
  const countersFinal = snapshot(),
    sortedLatency = Array.from(latency).sort((a, b) => a - b);
  assert.ok(readyAfter >= readyBefore && readyAfter > 0n, "readiness CPU clock");
  assert.ok(producerAfter >= producerBefore && producerAfter > 0n, "producer CPU clock");
  if (diagnostic) {
    assert.equal(countersFinal[73], 0, "notification bytes/order differ from kernel wait results");
    assert.equal(notificationBytes % 8, 0);
    assert.equal(notificationBytes / 8, readinessCallbacks);
    assert.equal(countersFinal[3], notificationBytes);
    assert.equal(countersFinal[1], readinessCallbacks);
    const words = helper.bench_notifications(ptr(nativeLog), nativeLog.length);
    assert.notEqual(words, 0xffffffff, "native log overflow");
    assert.ok(
      notificationLog.subarray(0, notificationBytes).equals(Buffer.from(nativeLog.buffer, 0, words * 4)),
      "dispatch order differs from kernel notification order",
    );
    assert.equal(countersFinal[74], directCallback ? readinessCallbacks : 0);
    if (directCallback) assert.equal(dataCallbacks, 0, "Socket must remain idle");
    assert.ok(sortedLatency[0] > 0);
    assert.ok(sortedLatency.at(-1)! < 250_000, "readiness latency exceeded250ms");
    // Timestamp bytes vary across processes; canonical content must still match.
    for (let lane = 0; lane < lanes; lane++)
      for (let sequence = 0; sequence < ticks; sequence++)
        received[lane].fill(0, sequence * recordSize + 8, sequence * recordSize + 16);
  } else
    assert.ok(
      countersFinal.every(value => value === 0),
      "timing build must have counters compiled out",
    );
  const producerCPU = Number(producerAfter - producerBefore) / 1e9,
    processCPU = (cpu.user + cpu.system) / 1e6,
    mappings = readFileSync("/proc/self/maps", "utf8").split("\n");
  assert.ok(
    mappings.some(line => line.endsWith(library)),
    "benchmark DSO must be loaded",
  );
  console.log(
    JSON.stringify(
      {
        scenario,
        transport: directCallback ? "threadsafe_callback_idle_socket" : "batched_socket",
        diagnostic,
        warmup,
        requested_seconds: seconds,
        phase_started_epoch_ms: phaseEpoch,
        seconds: measured,
        lanes,
        updates_per_second: 20,
        bytes_per_update: recordSize,
        bytes_per_lane: bytesPerLane,
        canonical_payload_sha256: sha(Buffer.concat(received)),
        cadence_by_lane: delivered.map(value => value / measured),
        callbacks_per_second: (callbacksAfter - callbacksBefore) / measured,
        cpu: {
          process_percent: (processCPU * 100) / measured,
          producer_thread_percent: (producerCPU * 100) / measured,
          readiness_thread_percent: ((Number(readyAfter - readyBefore) / 1e9) * 100) / measured,
          process_minus_producer_percent: ((processCPU - producerCPU) * 100) / measured,
        },
        counters: diagnostic
          ? {
              phase: {
                wait_calls: deltas[0],
                wait_events: deltas[1],
                transport_calls: deltas[2],
                send_calls: directCallback ? 0 : deltas[2],
                ffi_callbacks: deltas[74],
                transport_bytes: deltas[3],
                send_bytes: directCallback ? 0 : deltas[3],
                short_sends: deltas[4],
                send_eintr: deltas[5],
                wait_eintr: deltas[6],
                epoll_ctl: deltas[7],
                wait_size_histogram: deltas.slice(8, 73),
              },
              total: {
                events: countersFinal[1],
                transport_calls: countersFinal[2],
                sends: directCallback ? 0 : countersFinal[2],
                ffi_callbacks: countersFinal[74],
                minimum_queue_allocations_from_pinned_source: countersFinal[74] * 3,
                transport_bytes: countersFinal[3],
                send_bytes: directCallback ? 0 : countersFinal[3],
                callbacks: dataCallbacks,
                notification_bytes: notificationBytes,
                records: readinessCallbacks,
                partial_chunks: partialChunks,
                notification_order_mismatches: countersFinal[73],
                dispatch_order_verified: true,
              },
            }
          : null,
        latency_us: diagnostic
          ? {
              median: sortedLatency[Math.floor(sortedLatency.length / 2)],
              p95: sortedLatency[Math.floor(sortedLatency.length * 0.95)],
              p99: sortedLatency[Math.floor(sortedLatency.length * 0.99)],
              max: sortedLatency.at(-1),
            }
          : null,
        library: { path: library, sha256: sha(readFileSync(library)) },
        native_mappings: mappings.filter(line => line.endsWith(library) || line.includes("libcorgi_")),
        source_sha256: sha(readFileSync(import.meta.path)),
        ready_loop_sha256: sha(readFileSync(resolve(import.meta.dir, "../../src/fd_loop.ts"))),
        process_status: readFileSync("/proc/self/status", "utf8")
          .split("\n")
          .filter(line => /^(Cpus_allowed_list|Mems_allowed_list):/.test(line)),
        limits:
          "Socketpair workload and actual ReadyLoop dispatch/read/rearm; callback variant keeps its notification Socket idle as a lifetime anchor. No terminal emulation, daemon collection or protocol. CPU includes Bun/runtime helpers and isolated producer (reported separately). Counters/latency clocks only in diagnostic build. Thread CPU clocks are read at phase boundaries; quality/byte checks are outside CPU window. Callback queue allocations are inferred from pinned Bun source, not measured allocation events.",
      },
      null,
      2,
    ),
  );
}
try {
  Object.assign(native, {
    fd_loop_new: helper.fd_loop_new,
    fd_loop_arm: helper.fd_loop_arm,
    fd_loop_free: helper.fd_loop_free,
    fd_cloexec: helper.fd_cloexec,
  });
  if (directCallback) {
    bridge = new JSCallback(
      (token: number, events: number) => {
        if (closed || !loop) {
          lateIgnored++;
          return;
        }
        if (diagnostic) recordNotification(token, events);
        loop["callbacks"].get(token)?.(events);
      },
      { args: ["u32", "u32"], returns: "void", threadsafe: true },
    );
    helper.bench_set_callback(bridge.ptr);
  }
  loop = new ReadyLoop();
  if (verifyOnly)
    console.log(
      JSON.stringify(
        {
          verification: await verifyCallback(),
          library_sha256: sha(readFileSync(library)),
          source_sha256: sha(readFileSync(import.meta.path)),
        },
        null,
        2,
      ),
    );
  else await measure();
} finally {
  for (const watch of watches) watch.close();
  if (producer) helper.bench_producer_free(producer);
  if (deferred) helper.bench_defer_join(deferred);
  closed = true;
  loop?.close();
  bridge?.close();
  helper.bench_set_callback(null);
  for (const fd of fds) n.probe_close(fd);
  Object.assign(native, original);
  replacement.close();
  await release();
}
