import { createHash } from 'node:crypto'

export const CANONICAL_WORKER_GATE_TIMEOUT_SECONDS = 300

export function canonicalWorkerBindingHash(binding: Record<string, unknown>): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) {
      return `[${Array.from(value, canonical).join(',')}]`
    }
    if (value && typeof value === 'object') {
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      ) {
        throw new Error('Canonical worker bindings require plain JSON objects.')
      }
      return `{${Object.entries(value)
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([key, item]) => `${canonical(key)}:${canonical(item)}`)
        .join(',')}}`
    }
    if (typeof value === 'string' && Buffer.from(value).toString('utf8') !== value) {
      throw new Error('Canonical worker bindings require valid Unicode strings.')
    }
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return JSON.stringify(value)
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      return String(value)
    }
    throw new Error('Canonical worker bindings require JSON values and safe integer numbers.')
  }
  return createHash('sha256').update(canonical(binding)).digest('hex')
}

// Invoke the execution host's absolute Python with -I -S; argv/env stay in launch.json.
export const CANONICAL_WORKER_GATE_PYTHON = String.raw`
import datetime
import hashlib
import hmac
import json
import math
import os
import re
import signal
import stat
import subprocess
import sys
import time

state = None
directory_fd = None

def read_private_json(name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("invalid private file")
        content = stream.read(limit + 1)
    if len(content) > limit:
        raise ValueError("oversized private file")
    value = json.loads(content)
    if type(value) is not dict:
        raise ValueError("invalid private object")
    return value

def persist(phase, closed, reason=None):
    state.update(phase=phase, launch_gate_closed=closed,
                 observed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
    if reason:
        state["reason"] = reason
    temporary = "process.json.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                 0o600, dir_fd=directory_fd)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(state, stream, separators=(",", ":"), ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, "process.json", src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
    os.fsync(directory_fd)

def abort(reason):
    if state is not None:
        try:
            persist("aborted", True, reason)
        except Exception:
            pass
    raise SystemExit(125)

def signal_abort(signum, frame):
    abort("gate_interrupted")

def valid_binding(value):
    if type(value) is dict:
        return all(valid_binding(item) for item in value.values())
    if type(value) is list:
        return all(valid_binding(item) for item in value)
    return (value is None or type(value) in (str, bool) or
            (type(value) is int and abs(value) <= 9007199254740991))

def main():
    global state, directory_fd
    if os.name != "posix" or not sys.flags.isolated or not sys.flags.no_site:
        abort("unsupported_gate_runtime")
    directory, nonce = sys.argv[1:3]
    requested_timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 300.0
    if not math.isfinite(requested_timeout) or requested_timeout <= 0:
        abort("invalid_timeout")
    deadline = time.monotonic() + min(requested_timeout, 300.0)
    if not os.path.isabs(directory) or not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", nonce):
        abort("invalid_gate_identity")
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    info = os.fstat(directory_fd)
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        abort("invalid_gate_directory")
    launch = read_private_json("launch.json", 16 * 1024 * 1024)
    os.unlink("launch.json", dir_fd=directory_fd)
    os.fsync(directory_fd)
    binding = launch["binding"]
    runner = launch["runnerInstance"]
    argv, environment, cwd = launch["argv"], launch["env"], launch["cwd"]
    if (type(binding) is not dict or not binding or not valid_binding(binding)
            or type(runner) is not str or not runner
            or type(argv) is not list or not argv or not all(type(arg) is str for arg in argv)
            or not argv[0] or type(environment) is not dict
            or not all(type(key) is str and type(value) is str for key, value in environment.items())
            or type(cwd) is not str or not os.path.isabs(cwd)
            or type(launch["gatePython"]) is not str or not os.path.isabs(launch["gatePython"])
            or os.path.realpath(launch["gatePython"]) != os.path.realpath(sys.executable)):
        abort("invalid_launch")
    binding_hash = hashlib.sha256(json.dumps(binding, sort_keys=True, separators=(",", ":"),
                                            ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()
    pid = os.getpid()
    try:
        os.setpgid(0, 0)
    except OSError:
        if os.getpgrp() != pid:
            raise
    started_at = subprocess.check_output(
        ["/bin/ps", "-p", str(pid), "-o", "lstart="],
        env={**os.environ, "LC_ALL": "C"}, stderr=subprocess.DEVNULL,
        timeout=min(5.0, max(0.001, deadline - time.monotonic())), text=True).strip()
    if not started_at:
        abort("process_identity_unavailable")
    state = dict(pid=pid, pgid=os.getpgrp(), started_at=started_at, runner_instance=runner,
                 binding_hash=binding_hash, process_exited=False, exit_code=None)
    for name in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(name, signal_abort)
    persist("prepared", True)
    while True:
        if time.monotonic() >= deadline:
            abort("gate_timeout")
        try:
            permit = read_private_json("permit.json", 64 * 1024)
        except FileNotFoundError:
            time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
            continue
        expected = dict(nonce=nonce, binding_hash=binding_hash, pid=pid,
                        started_at=started_at, runner_instance=runner)
        if any(type(permit.get(key)) is not type(value) or
               (not hmac.compare_digest(permit[key].encode("utf-8"), value.encode("utf-8"))
                if type(value) is str else permit[key] != value)
               for key, value in expected.items()):
            abort("invalid_permit")
        os.unlink("permit.json", dir_fd=directory_fd)
        os.fsync(directory_fd)
        if time.monotonic() >= deadline:
            abort("gate_timeout")
        os.chdir(cwd)
        persist("released", False)
        if time.monotonic() >= deadline:
            abort("gate_timeout")
        os.execvpe(argv[0], argv, environment)

try:
    main()
except Exception:
    abort("gate_failure")
`
