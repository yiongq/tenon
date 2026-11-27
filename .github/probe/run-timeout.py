#!/usr/bin/env python3
"""PROBE (probe/packaging, never merged): run a command with a time limit, killing its whole group.

usage: run-timeout.py <seconds> <command> [args...]
exit code: the command's, or 124 after a timeout (like coreutils timeout, which macOS lacks).
"""
import os
import signal
import subprocess
import sys

limit = int(sys.argv[1])
child = subprocess.Popen(sys.argv[2:], start_new_session=True)
try:
    sys.exit(child.wait(timeout=limit))
except subprocess.TimeoutExpired:
    os.killpg(child.pid, signal.SIGKILL)
    print(f"run-timeout: killed after {limit}s", flush=True)
    sys.exit(124)
