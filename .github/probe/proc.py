#!/usr/bin/env python3
"""PROBE (probe/packaging, never merged): find an Electron app's main and renderer pids.

usage: proc.py main <regex>       the main process: matches <regex>, has no --type=, and has no
                                   matching descendant (so a node/pnpm wrapper is skipped)
       proc.py renderers <pid>    descendants of <pid> whose command line has --type=renderer
"""
import os
import re
import subprocess
import sys


def table():
    out = subprocess.run(
        ["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True, check=True
    ).stdout
    rows = {}
    for line in out.splitlines():
        parts = line.split(None, 2)
        if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
            rows[int(parts[0])] = (int(parts[1]), parts[2])
    return rows


def descendants(rows, root):
    found, frontier = [], [root]
    while frontier:
        parent = frontier.pop()
        for pid, (ppid, _command) in rows.items():
            if ppid == parent and pid not in found:
                found.append(pid)
                frontier.append(pid)
    return found


rows = table()
if sys.argv[1] == "main":
    pattern = re.compile(sys.argv[2])
    me = {os.getpid(), os.getppid()}
    candidates = [
        pid
        for pid, (_ppid, command) in rows.items()
        if pid not in me and pattern.search(command) and "--type=" not in command
    ]
    leaves = [pid for pid in candidates if not any(d in candidates for d in descendants(rows, pid))]
    print(leaves[0] if leaves else "")
elif sys.argv[1] == "renderers":
    root = int(sys.argv[2])
    print(
        " ".join(
            str(pid) for pid in descendants(rows, root) if "--type=renderer" in rows[pid][1]
        )
    )
