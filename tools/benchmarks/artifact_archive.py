"""Pack and verify benchmark bundles. Called by artifacts.ts; Python 3.12+."""

import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile


def digest(stream):
    return hashlib.file_digest(stream, "sha256").hexdigest()


def sha(path):
    with path.open("rb") as stream:
        return digest(stream)


def safe_name(name):
    parts = PurePosixPath(name)
    if not name or parts.is_absolute() or ".." in parts.parts or str(parts) != name:
        raise ValueError(f"Unsafe archive path: {name}")
    return name


def inventory(archive, destination=None):
    files = {}
    with tarfile.open(archive, "r:gz") as bundle:
        for entry in bundle:
            name = safe_name(entry.name)
            if not entry.isfile() or name in files:
                raise ValueError(f"Not a unique regular file: {name}")
            with bundle.extractfile(entry) as source:
                if destination is None:
                    checksum = digest(source)
                else:
                    target = destination / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with target.open("xb") as output:
                        shutil.copyfileobj(source, output)
                    target.chmod(entry.mode & 0o777)
                    checksum = sha(target)
            files[name] = dict(bytes=entry.size, sha256=checksum, mode=entry.mode & 0o777)
    return files


def pack(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if not source.is_dir():
        raise ValueError(f"Source directory does not exist: {source}")
    if destination.is_relative_to(source):
        raise ValueError("Bundle must be outside its input directory")
    destination.mkdir(mode=0o700)
    archive = destination / "archive.tar.gz"
    # Fixed gzip/tar metadata makes a retry produce the same archive bytes.
    with archive.open("xb") as output, gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode="w|") as bundle:
            for file in sorted(source.rglob("*")):
                if file.is_symlink() or not (file.is_dir() or file.is_file()):
                    raise ValueError(f"Only regular files and directories may be archived: {file}")
                if file.is_dir():
                    continue
                entry = bundle.gettarinfo(str(file), arcname=file.relative_to(source).as_posix())
                entry.uid = entry.gid = entry.mtime = 0
                entry.uname = entry.gname = ""
                entry.mode &= 0o777
                with file.open("rb") as stream:
                    bundle.addfile(entry, stream)
    manifest = dict(schema=1, archive=dict(bytes=archive.stat().st_size, sha256=sha(archive)), files=inventory(archive))
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def verify(bundle, destination=None):
    manifest = json.loads((bundle / "manifest.json").read_text())
    archive = bundle / "archive.tar.gz"
    if manifest["schema"] != 1 or manifest["archive"] != dict(bytes=archive.stat().st_size, sha256=sha(archive)):
        raise ValueError("Archive checksum or size mismatch")
    if destination is None:
        actual = inventory(archive)
        if actual != manifest["files"]:
            raise ValueError("File manifest mismatch")
        return
    if destination.exists():
        raise ValueError(f"Destination already exists: {destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".fetch-", dir=destination.parent) as temporary:
        stage = Path(temporary) / "files"
        stage.mkdir(mode=0o700)
        if inventory(archive, stage) != manifest["files"]:
            raise ValueError("File manifest mismatch")
        if destination.exists():
            raise ValueError(f"Destination already exists: {destination}")
        os.rename(stage, destination)


if __name__ == "__main__":
    operation, *arguments = sys.argv[1:]
    if operation == "pack":
        pack(*map(Path, arguments))
    elif operation == "verify":
        verify(Path(arguments[0]))
    elif operation == "extract":
        verify(*map(Path, arguments))
    else:
        raise ValueError("Expected pack, verify or extract")
