"""Explicit provisioning and offline integrity checks for the reviewed Laya snapshot."""
import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

MANIFEST = json.loads(Path(__file__).with_name("manifest.json").read_text())


def entries(root):
    for name, digest in MANIFEST["modelFiles"].items():
        url = "https://huggingface.co/{}/resolve/{}/{}".format(
            MANIFEST["modelRepository"], MANIFEST["modelRevision"], name)
        yield root / "model" / name, digest, url
    for name, digest in MANIFEST["sourceFiles"].items():
        url = "https://raw.githubusercontent.com/NandhaKishorM/laya/{}/{}".format(
            MANIFEST["sourceRevision"], name)
        yield root / "source" / name, digest, url


def file_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify(root):
    root = root.resolve(strict=True)
    for path, digest, _ in entries(root):
        if not path.resolve(strict=True).is_relative_to(root) or file_digest(path) != digest:
            raise ValueError("checkpoint_integrity_failed")
    # Extra model or Python files can alter loading despite valid expected hashes.
    allowed = {path.relative_to(root) for path, _, _ in entries(root)}
    actual = {path.relative_to(root) for directory in (root / "model", root / "source")
              for path in directory.rglob("*") if path.is_file()}
    if actual != allowed:
        raise ValueError("checkpoint_unexpected_files")


def provision(root):
    root.mkdir(parents=True, exist_ok=False)
    for path, digest, url in entries(root):
        path.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as response, path.open("xb") as target:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 850_000_000:
                    raise ValueError("checkpoint_download_too_large")
                target.write(chunk)
        if file_digest(path) != digest:
            raise ValueError("checkpoint_integrity_failed")
    verify(root)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["download", "verify"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.operation == "download":
        provision(args.directory)
    else:
        verify(args.directory)
    print(json.dumps({"verified": True, "model": MANIFEST["model"]}))
