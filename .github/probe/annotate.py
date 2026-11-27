#!/usr/bin/env python3
"""PROBE (probe/packaging, never merged): print a results file as GitHub notice annotations.

Annotations are readable without logging in (the check-runs annotations API), so the key results of
each phase survive even when the log itself needs a login.

usage: annotate.py <title> <results file>
"""
import sys

title, path = sys.argv[1], sys.argv[2]
with open(path, errors="replace") as handle:
    lines = [line.rstrip("\n")[:300] for line in handle]

chunks, current, size = [], [], 0
for line in lines:
    if current and size + len(line) + 1 > 3500:
        chunks.append(current)
        current, size = [], 0
    current.append(line)
    size += len(line) + 1
if current:
    chunks.append(current)

for number, chunk in enumerate(chunks[:9], 1):
    text = "\n".join(chunk).replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    label = title if len(chunks) == 1 else f"{title} ({number} of {len(chunks)})"
    print(f"::notice title={label}::{text}")
if len(chunks) > 9:
    print(f"::notice title={title} (cut)::{len(chunks) - 9} more chunks not shown")
