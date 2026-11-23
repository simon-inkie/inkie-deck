#!/usr/bin/env bash
# base-runner-exec.sh - Hold Deck's shared .runner.lock (flock + LockRecord) for
# the lifetime of a Base tmux agent runtime, closing Base <-> ACP overlap races
# atomically and failing closed on every error.
#
# Usage: base-runner-exec.sh <agent-home> -- <cmd> [args...]

set -euo pipefail

if [[ $# -lt 3 || "${2:-}" != "--" ]]; then
  echo "base-runner-exec: usage: base-runner-exec.sh <agent-home> -- <cmd> [args...]" >&2
  exit 2
fi

AGENT_HOME="$1"
shift 2

exec python3 - "$AGENT_HOME" "$@" <<'PY'
import errno
import fcntl
import json
import os
import re
import signal
import stat
import subprocess
import sys
import time
import uuid

MAX_LOCK_BYTES = 4096
UUID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")


def read_boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id", "r", encoding="utf-8") as f:
            val = f.read().strip()
        return val if UUID_RE.match(val) else None
    except OSError:
        return None


def proc_info(pid):
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as f:
            raw = f.read()
        fields = raw[raw.rindex(")") + 2 :].split(" ")
        return {
            "state": fields[0],
            "group": int(fields[2]),
            "session": int(fields[3]),
            "birth": fields[19],
        }
    except FileNotFoundError:
        return None
    except ProcessLookupError:
        return None


def is_live_state(state):
    return state not in ("Z", "X")


def group_exists(pgid):
    try:
        os.kill(-pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def marker_opts_into_runner(agent_home):
    marker = os.path.join(agent_home, ".runner")
    try:
        st = os.lstat(marker)
    except FileNotFoundError:
        return False
    except OSError:
        return True
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        return True
    try:
        with open(marker, "r", encoding="utf-8") as f:
            val = f.read(64).strip()
        return val in ("pty", "acp")
    except OSError:
        return True


def same_inode(path, owned_stat):
    try:
        cur = os.lstat(path)
    except FileNotFoundError:
        return False
    return cur.st_dev == owned_stat.st_dev and cur.st_ino == owned_stat.st_ino


def valid_pid(val):
    return isinstance(val, int) and not isinstance(val, bool) and 1 < val <= 0x7FFFFFFF


def try_reap_stale_lock(lock_file, current_boot_id):
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(lock_file, flags)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return False
        st = os.fstat(fd)
        if (
            not stat.S_ISREG(st.st_mode)
            or st.st_size <= 0
            or st.st_size > MAX_LOCK_BYTES
            or st.st_uid != os.getuid()
            or (st.st_mode & 0o022) != 0
        ):
            return False
        if not same_inode(lock_file, st):
            return False
        os.lseek(fd, 0, os.SEEK_SET)
        raw = os.read(fd, MAX_LOCK_BYTES + 1)
        if len(raw) != st.st_size:
            return False
        try:
            rec = json.loads(raw.decode("utf-8"))
        except Exception:
            return False
        if not isinstance(rec, dict):
            return False
        deck_pid = rec.get("deckPid")
        deck_birth = rec.get("deckBirth")
        child_pid = rec.get("childPid")
        child_birth = rec.get("childBirth")
        rec_boot_id = rec.get("bootId")
        rec_session_id = rec.get("sessionId")
        started_at = rec.get("startedAt")
        if (
            not valid_pid(deck_pid)
            or not (child_pid is None or valid_pid(child_pid))
            or not isinstance(deck_birth, str)
            or not deck_birth.isdigit()
            or not (child_birth is None or (isinstance(child_birth, str) and child_birth.isdigit()))
            or not isinstance(rec_boot_id, str)
            or not UUID_RE.match(rec_boot_id)
            or not isinstance(rec_session_id, str)
            or not UUID_RE.match(rec_session_id)
            or not isinstance(started_at, int)
        ):
            return False

        if rec_boot_id == current_boot_id:
            try:
                deck = proc_info(deck_pid)
            except OSError:
                return False
            if deck and deck["birth"] == deck_birth and is_live_state(deck["state"]):
                return False
            if child_pid is not None:
                try:
                    child = proc_info(child_pid)
                except OSError:
                    return False
                if child and is_live_state(child["state"]) and (child_birth is None or child["birth"] == child_birth):
                    return False
                if group_exists(child_pid):
                    return False

        if not same_inode(lock_file, st):
            return False
        os.unlink(lock_file)
        return True
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def claim_lock(lock_file, current_boot_id):
    create_flags = os.O_CREAT | os.O_EXCL | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    for _attempt in range(2):
        try:
            fd = os.open(lock_file, create_flags, 0o600)
        except FileExistsError:
            if not try_reap_stale_lock(lock_file, current_boot_id):
                return None, None
            continue
        except OSError:
            return None, None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.fchmod(fd, 0o600)
            st = os.fstat(fd)
            return fd, st
        except OSError:
            try:
                os.close(fd)
            except OSError:
                pass
            return None, None
    return None, None


def persist_record(fd, record):
    payload = (json.dumps(record) + "\n").encode("utf-8")
    os.lseek(fd, 0, os.SEEK_SET)
    written = 0
    while written < len(payload):
        n = os.write(fd, payload[written:])
        if n <= 0:
            raise OSError("Short write on .runner.lock")
        written += n
    os.ftruncate(fd, len(payload))
    os.fsync(fd)


def main():
    agent_home = os.path.realpath(sys.argv[1])
    cmd = sys.argv[2:]
    if not cmd or not os.path.isdir(agent_home):
        sys.stderr.write("base-runner-exec: invalid agent home or command\n")
        return 2

    boot_id = read_boot_id()
    my_pid = os.getpid()
    try:
        my_info = proc_info(my_pid)
    except OSError:
        my_info = None
    if not boot_id or not my_info or not my_info.get("birth"):
        sys.stderr.write("base-runner-exec: cannot verify process identity or boot_id; failing closed\n")
        return 1

    lock_file = os.path.join(agent_home, ".runner.lock")
    fd, owned_stat = claim_lock(lock_file, boot_id)
    if fd is None or owned_stat is None:
        sys.stderr.write(f"base-runner-exec: runner lock busy or unrecoverable for {agent_home}\n")
        return 1

    def release_lock():
        try:
            if same_inode(lock_file, owned_stat):
                os.unlink(lock_file)
        except OSError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass

    child = None
    try:
        # Re-check .runner marker WHILE holding exclusive flock on .runner.lock (closes cutover race!)
        if marker_opts_into_runner(agent_home):
            return 0

        session_id = str(uuid.uuid4())
        record = {
            "deckPid": my_pid,
            "deckBirth": my_info["birth"],
            "childPid": None,
            "childBirth": None,
            "bootId": boot_id,
            "sessionId": session_id,
            "startedAt": int(time.time() * 1000),
            "phase": "spawning",
        }
        persist_record(fd, record)

        child_env = dict(os.environ)
        child_env["DECK_PTY_SESSION_ID"] = session_id

        child = subprocess.Popen(cmd, cwd=agent_home, env=child_env, close_fds=True)

        try:
            child_info = proc_info(child.pid)
        except OSError:
            child_info = None
        if child_info and child_info.get("birth"):
            record["childPid"] = child.pid
            record["childBirth"] = child_info["birth"]
            persist_record(fd, record)

        def forward_signal(signum, _frame):
            if child is not None and child.poll() is None:
                try:
                    child.send_signal(signum)
                except OSError:
                    pass

        signal.signal(signal.SIGTERM, forward_signal)
        signal.signal(signal.SIGINT, forward_signal)
        signal.signal(signal.SIGHUP, forward_signal)

        rc = child.wait()
        return rc if rc >= 0 else 128 + (-rc)
    except Exception as exc:
        if child is not None and child.poll() is None:
            try:
                child.kill()
                child.wait(timeout=2)
            except Exception:
                pass
        sys.stderr.write(f"base-runner-exec: failed: {exc}\n")
        return 1
    finally:
        release_lock()


sys.exit(main())
PY
