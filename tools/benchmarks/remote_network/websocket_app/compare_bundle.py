import hashlib, json, pathlib, re, struct, sys, difflib


def modules(path):
    data = path.read_bytes()
    assert data[:6] == b"\x7fELF\x02\x01"
    at = struct.unpack_from("<Q", data, 40)[0]
    size, count, names = struct.unpack_from("<HHH", data, 58)

    def section(index):
        return struct.unpack_from("<IIQQQQIIQQ", data, at + index * size)

    strings = section(names)
    strings = data[strings[4] : strings[4] + strings[5]]
    found = []
    for i in range(count):
        s = section(i)
        name = strings[s[0] :].split(b"\0")[0]
        if name == b".bun":
            found.append(data[s[4] : s[4] + s[5]])
    assert len(found) == 1
    blob = found[0]
    assert struct.unpack_from("<Q", blob, 0)[0] == len(blob) - 8
    offset = 8
    result = []
    for name, marker in [
        ("main", "// src/main.ts\n"),
        ("codex-worker", "// src/providers/codex/files_worker.ts\n"),
        ("resources-worker", "// src/trackers/resources_worker.ts\n"),
    ]:
        start = offset
        utf16 = blob[offset : offset + 4] == b"/\0/\0"
        if utf16:
            while blob[offset : offset + 2] != b"\0\0":
                offset += 2
            text = blob[start:offset].decode("utf-16le")
            offset += 2
        else:
            offset = blob.index(0, start)
            text = blob[start:offset].decode("utf8")
            offset += 1
        assert text.startswith("// @bun\n"), (name, text[:100])
        assert marker in text, (name, marker)
        result.append((name, text))
    return result


def normalize(text):
    # Only generated build metadata and bundler source-path comments differ.
    if "// src/build_config.ts\n" in text:
        start = text.index("// src/build_config.ts\n")
        end = text.index("\n// ", start + 1)
        block = text[start:end]
        for key in ["releaseCommit", "builtAt", "sourceHash"]:
            block, n = re.subn(
                r"\b" + key + r' = "[^"\n]*"', key + ' = "<BUILD_METADATA>"', block
            )
            assert n == 1, (key, n)
        text = text[:start] + block + text[end:]
    text = re.sub(r"(?m)^// (?:\.\./)+(native/zig-out/|node_modules/)", r"// \1", text)
    return text


first = pathlib.Path(sys.argv[1])
second = pathlib.Path(sys.argv[2])
out = pathlib.Path(sys.argv[3])
out.mkdir(exist_ok=True)
a = modules(first)
b = modules(second)
first_build = json.loads(first.with_name(first.name + ".build.json").read_text())
second_build = json.loads(second.with_name(second.name + ".build.json").read_text())
assert first_build["nativeSHA256"] == second_build["nativeSHA256"]
assert first_build["bunVersion"] == second_build["bunVersion"] == "1.4.4"
assert first_build["sha256"] == hashlib.sha256(first.read_bytes()).hexdigest()
assert second_build["sha256"] == hashlib.sha256(second.read_bytes()).hexdigest()
report = {
    "first": str(first.resolve()),
    "second": str(second.resolve()),
    "first_sha256": hashlib.sha256(first.read_bytes()).hexdigest(),
    "second_sha256": hashlib.sha256(second.read_bytes()).hexdigest(),
    "format": "Bun 1.4.4 standalone ELF64 little-endian .bun section; three bundled JS entrypoints",
    "native_assets_sha256": first_build["nativeSHA256"],
    "first_release_commit": first_build["releaseCommit"],
    "second_release_commit": second_build["releaseCommit"],
    "normalization": [
        "build_config.releaseCommit",
        "build_config.builtAt",
        "build_config.sourceHash",
        "bundler source-path comments: ../ prefixes before native/zig-out and node_modules",
    ],
    "modules": [],
}
for (name, x), (name2, y) in zip(a, b):
    assert name == name2
    xn, yn = normalize(x), normalize(y)
    r = {
        "name": name,
        "first_chars": len(x),
        "second_chars": len(y),
        "equal_unmodified": x == y,
        "equal_after_allowed_normalization": xn == yn,
        "first_raw_sha256": hashlib.sha256(x.encode()).hexdigest(),
        "second_raw_sha256": hashlib.sha256(y.encode()).hexdigest(),
        "first_normalized_sha256": hashlib.sha256(xn.encode()).hexdigest(),
        "second_normalized_sha256": hashlib.sha256(yn.encode()).hexdigest(),
    }
    report["modules"].append(r)
    if xn != yn:
        (out / (name + ".diff")).write_text(
            "".join(
                difflib.unified_diff(
                    xn.splitlines(True),
                    yn.splitlines(True),
                    fromfile="measured",
                    tofile="committed",
                )
            )
        )
    print(r)
report["all_runtime_modules_equal"] = all(
    r["equal_after_allowed_normalization"] for r in report["modules"]
)
(out / "equivalence.json").write_text(json.dumps(report, indent=2) + "\n")
if not report["all_runtime_modules_equal"]:
    raise SystemExit("Runtime modules differ; inspect the retained diffs")
