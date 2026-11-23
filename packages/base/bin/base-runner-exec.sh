#!/usr/bin/env python3
"""base-runner-exec.sh - Acquire Deck's shared .runner.lock (flock + LockRecord)
on an inherited file descriptor and exec directly into the Base tmux agent runtime.

NO wrapper process remains alive: the runtime itself becomes the pane's foreground
process (so tmux pane_current_command stays codex/claude/agy), inherits the open
flock'd .runner.lock descriptor (so the kernel holds the exclusive lock for the
runtime and every descendant automatically), and carries DECK_PTY_SESSION_ID.

Usage: base-runner-exec.sh <agent-home> -- <cmd> [args...]
"""

import fcntl
import json
import os
import re
import stat
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
    except (FileNotFoundError, ProcessLookupError):
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


def has_live_marked_process(session_id, deck_birth):
    marker = f"DECK_PTY_SESSION_ID={session_id}".encode("utf-8")
    my_uid = os.getuid()
    min_birth = int(deck_birth)
    try:
        entries = os.listdir("/proc")
    except OSError:
        return True
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid <= 1:
            continue
        try:
            st = os.stat(f"/proc/{pid}")
        except OSError:
            continue
        if st.st_uid != my_uid:
            continue
        info = proc_info(pid)
        if info is None or not is_live_state(info["state"]):
            continue
        if int(info["birth"]) < min_birth:
            continue
        try:
            with open(f"/proc/{pid}/environ", "rb") as f:
                env_bytes = f.read()
        except (FileNotFoundError, ProcessLookupError):
            continue
        except OSError:
            return True
        if marker in env_bytes.split(b"\0"):
            return True
    return False


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


def validate_lock_record(rec):
    if not isinstance(rec, dict):
        return False
    owner = rec.get("owner")
    deck_pid = rec.get("deckPid")
    deck_birth = rec.get("deckBirth")
    child_pid = rec.get("childPid")
    child_birth = rec.get("childBirth")
    rec_boot_id = rec.get("bootId")
    rec_session_id = rec.get("sessionId")
    started_at = rec.get("startedAt")
    phase = rec.get("phase")
    if (
        owner not in (None, "base", "pty", "acp")
        or not valid_pid(deck_pid)
        or not (child_pid is None or valid_pid(child_pid))
        or not isinstance(deck_birth, str)
        or not deck_birth.isdigit()
        or not (child_birth is None or (isinstance(child_birth, str) and child_birth.isdigit()))
        or not isinstance(rec_boot_id, str)
        or not UUID_RE.match(rec_boot_id)
        or not isinstance(rec_session_id, str)
        or not UUID_RE.match(rec_session_id)
        or not (phase in (None, "spawning") or (phase == "reserved" and child_pid is None and child_birth is None))
        or not isinstance(started_at, int)
        or isinstance(started_at, bool)
    ):
        return False
    return True


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
        if not validate_lock_record(rec):
            return False

        owner = rec.get("owner")
        deck_pid = rec["deckPid"]
        deck_birth = rec["deckBirth"]
        child_pid = rec["childPid"]
        child_birth = rec["childBirth"]
        rec_boot_id = rec["bootId"]
        rec_session_id = rec["sessionId"]
        phase = rec.get("phase")

        if rec_boot_id == current_boot_id:
            try:
                deck = proc_info(deck_pid)
            except OSError:
                return False
            if deck and deck["birth"] == deck_birth and is_live_state(deck["state"]):
                return False
            if owner == "base":
                # Major 4 (Round 14): Base holds flock on an inherited fd across exec;
                # flock already succeeded above, and we also verify no incomplete spawning
                # lock or marked descendant survived after closing fds.
                if phase == "spawning" and child_pid is None:
                    return False
                if has_live_marked_process(rec_session_id, deck_birth):
                    return False
            elif phase != "reserved":
                if child_pid is None:
                    return False
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


def cleanup_unlaunched(lock_file, fd, owned_stat):
    try:
        if same_inode(lock_file, owned_stat):
            os.unlink(lock_file)
    except OSError:
        pass
    try:
        os.close(fd)
    except OSError:
        pass


def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        sys.stderr.write("base-runner-exec: usage: base-runner-exec.sh <agent-home> -- <cmd> [args...]\n")
        return 2

    agent_home = os.path.realpath(sys.argv[1])
    cmd = sys.argv[3:]
    if not cmd or not os.path.isdir(agent_home):
        sys.stderr.write("base-runner-exec: invalid agent home or command\n")
        return 2

    # Non-Linux / missing /proc: honour .runner opt-in and exec directly.
    if sys.platform != "linux" or not os.path.isdir("/proc"):
        if marker_opts_into_runner(agent_home):
            return 0
        os.chdir(agent_home)
        os.execvp(cmd[0], cmd)

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

    try:
        # Re-check .runner marker WHILE holding exclusive flock on .runner.lock (closes cutover race).
        if marker_opts_into_runner(agent_home):
            cleanup_unlaunched(lock_file, fd, owned_stat)
            return 0

        session_id = str(uuid.uuid4())
        # After os.execvp, the runtime process keeps my_pid and my_info["birth"] verbatim,
        # inherits the open flock'd lock descriptor, and becomes the pane's foreground command.
        record = {
            "owner": "base",
            "deckPid": my_pid,
            "deckBirth": my_info["birth"],
            "childPid": my_pid,
            "childBirth": my_info["birth"],
            "bootId": boot_id,
            "sessionId": session_id,
            "startedAt": int(time.time() * 1000),
        }
        persist_record(fd, record)

        os.environ["DECK_PTY_SESSION_ID"] = session_id
        os.set_inheritable(fd, True)
        os.chdir(agent_home)
    except Exception:
        cleanup_unlaunched(lock_file, fd, owned_stat)
        return 1

    try:
        os.execvp(cmd[0], cmd)
    except OSError as exc:
        cleanup_unlaunched(lock_file, fd, owned_stat)
        sys.stderr.write(f"base-runner-exec: exec failed: {exc}\n")
        return 127


if __name__ == "__main__":
    sys.exit(main())
