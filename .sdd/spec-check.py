#!/usr/bin/env python3
# sdd:spec-check v=2.0.2 hash=fa9c7f0c8aaf
"""sdd spec-check：规格驱动开发（sdd）的检查脚本。

单文件，只用 Python 标准库（兼容 3.9），调子进程和 git，不联网。
装进项目后的路径是 .sdd/spec-check.py。设计依据：sdd-v2-design.md 第 7 节。

用法（详见 --help）：
  python3 .sdd/spec-check.py                 按整个 PR 的范围跑全部检查（CI 用）
  python3 .sdd/spec-check.py --staged        只看暂存的文件（提交时用）
  python3 .sdd/spec-check.py --run <门禁>    经本脚本跑项目的门禁并记耗时
  其余模式：--measure --status --index --review-pack --red-on-base --mutants
            --all --report [--save] --handoff --fingerprint --stamp

退出码：0 = 没有拦（可以有警）；1 = 有拦；2 = 用法或环境错误。
"""
import argparse
import datetime
import difflib
import hashlib
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import unicodedata

VERSION = "2.0.2"
TIERS = ("lite", "standard", "heavy")
TIER_RANK = {"lite": 0, "standard": 1, "heavy": 2}
BLOCK = "block"
WARN = "warn"
LEVEL_LABEL = {BLOCK: "拦", WARN: "警"}

# 7.2 检查一览：每项检查在 lite / standard / heavy 三档的力度（None = 不跑）。
# gate-files、docs-sync、later 三项一律只警，调用时直接写 ctx.warn，不查这张表
LEVEL_TABLE = {
    "status": (BLOCK, BLOCK, BLOCK),
    "approval": (BLOCK, BLOCK, BLOCK),
    "pairs": (BLOCK, BLOCK, BLOCK),
    "frozen": (BLOCK, BLOCK, BLOCK),
    "line-refs": (BLOCK, BLOCK, BLOCK),
    "todo-files": (BLOCK, BLOCK, BLOCK),
    "leftovers": (BLOCK, BLOCK, BLOCK),
    "numbering": (BLOCK, BLOCK, BLOCK),
    "shape": (WARN, WARN, WARN),
    "codes": (WARN, WARN, WARN),
    "index": (WARN, WARN, WARN),
    "notes": (WARN, WARN, WARN),
    "handoff": (WARN, WARN, WARN),
    "timing": (WARN, WARN, WARN),
    "trace": (None, BLOCK, BLOCK),
    "tamper": (None, BLOCK, BLOCK),
    "special-case": (None, WARN, WARN),
    "review": (None, BLOCK, BLOCK),
    "red-on-base": (None, None, BLOCK),
    "mutants": (None, None, BLOCK),
    "rerun": (None, WARN, WARN),
}

# 第 4 节体量上限（起步值，超了只报警）；config 的 limits 可以覆盖
DEFAULT_LIMITS = {
    "spec_chars": {"lite": 3000, "standard": 15000, "heavy": 25000},
    "plan_chars": {"lite": 3000, "standard": 10000, "heavy": 30000},
    "agents_lines": {"lite": 40, "standard": 200, "heavy": 200},
    "agents_bytes": {"lite": None, "standard": 24 * 1024, "heavy": 24 * 1024},
    "line_chars": 600,
    "intro_lines": 40,
    "overview_lines": 200,
    "runbook_lines": 300,
    "master_lines": 80,
}

# 固定路径（见 references/modules/architecture.md 和 roadmap.md）
OVERVIEW_PATH = "docs/architecture/overview.md"
RUNBOOK_PATH = "docs/ops/runbook.md"
MASTER_REF_PATH = "docs/architecture/master-reference.md"
LATER_PATH = "docs/later.md"  # lite 的「以后再说」；standard 起写在总参考的「以后再说」一节
PROJECT_DECISIONS_PATH = "docs/decisions.md"
ADR_GLOB = "docs/adr/*.md"
# 门禁文件：CI 跑的是 PR 自己改过的这些文件，改了就能让检查闭嘴，所以由 owner 来合
GATE_FILE_LABELS = [(".github/workflows/**", "CI 流程"), ("lefthook.yml", "提交钩子"), ("lefthook.yaml", "提交钩子"),
                    (".lefthook.yml", "提交钩子"), ("lefthook-local.yml", "提交钩子"), (".sdd/config.json", "sdd 的配置"),
                    (".sdd/spec-check.py", "检查脚本本身"), (".claude/settings.json", "agent 的设置和钩子")]
GATE_CONFIG_NAMES = ["vitest.config.*", "playwright.config.*", "jest.config.*", "pytest.ini", "conftest.py"]  # 任何目录下的 conftest.py 都算
NO_KNOWN_CHECKS = ("gate-files",)  # 这类发现不许被 config 的 known 放过，不然改裁判的 PR 能先把提醒登记掉

MODULE_ORDER = ["roadmap", "architecture", "index", "decisions", "evidence", "critique", "matrix", "replace", "notes"]
TIER_MODULES = {
    "lite": [],
    "standard": ["roadmap", "architecture", "index", "decisions"],
    "heavy": ["roadmap", "architecture", "index", "decisions", "evidence", "critique", "matrix"],
}

DEFAULT_SPEC_ROOTS = ["docs/architecture/*/spec.md", "docs/features/*/spec.md"]
PLAN_HEADINGS = ["当前 / 需要你", "步骤", "交接", "Open", "验收矩阵"]
DEFAULT_CODE_PREFIXES = ["D", "E", "P", "M", "R"]
GATE_NAMES = ["install", "format:check", "lint", "typecheck", "test", "test:unit",
              "test:integration", "test:e2e", "test:mutation"]
FAST_GATES = ["format:check", "lint", "typecheck"]
COMMIT_BUDGET_S = 30  # 7.3 --measure 的建议线：提交时的检查合计 30 秒以内
WEAK_APPROVALS = ["继续", "开工", "好", "好的", "可以", "行", "ok", "都按推荐", "按推荐", "全部按推荐"]

CODE_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt",
             ".swift", ".rb", ".php", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".sh", ".vue", ".svelte")
# 按文件名就会被测试运行器收进去的测试文件（不看所在目录）。改名成不在这里的名字 = 运行器不收了
NAME_TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/test_*.py", "**/*_test.py",
                   "**/*_test.go", "**/*Test.kt", "**/*Test.java", "**/*Tests.swift", "**/*_spec.rb"]
TEST_GLOBS = NAME_TEST_GLOBS + ["**/tests/**", "**/e2e/**", "**/__snapshots__/**", "**/fixtures/**", "**/mocks/**"]
RUNCONFIG_NAMES = ["vitest.config.*", "playwright.config.*", "jest.config.*", "pytest.ini",
                   "pyproject.toml", "setup.cfg", "conftest.py"]
TAMPER_CONFIG_KEYS = re.compile(r"(?<![A-Za-z])(include|exclude|retry|retries|testMatch|testIgnore|testpaths|addopts|reruns)(?![A-Za-z])", re.I)
ASSERT_RE = re.compile(r"expect\(|\bassert|\.should\b")
# 跳过信号：.skip( 调用；describe/it/test/suite.skip 或 .fixme 不带括号被引用（const d = c ? describe : describe.skip）；
# .runIf( / skipIf( / skipUnless(（按环境变量整组跳过，含 from unittest import skipIf 之后直接写的 @skipIf(）；@skip(；
# xit( / xdescribe( / xtest(；.todo(；unittest 的 skip 系、self.skipTest( 和 raise unittest.SkipTest；pytest 的 skip / skipif
SKIP_RE = re.compile(r"\b(?:describe|it|test|suite)\.(?:skip|fixme)\b|\.skip\(|\.runIf\(|\b(?:skipIf|skipUnless)\(|@skip\("
                     r"|\bxit\(|\bxdescribe\(|\bxtest\(|\.todo\("
                     r"|unittest\.skip(?:Unless|If)?\b|\.skipTest\(|\braise\s+(?:unittest\.)?SkipTest\b|pytest\.mark\.skip|pytest\.skip\(")
ONLY_RE = re.compile(r"\.only\(|\bfit\(|\bfdescribe\(")
SPECIAL_CASE_RES = [
    re.compile(r"process\.env\.VITEST"),
    re.compile(r"JEST_WORKER_ID"),
    re.compile(r"NODE_ENV\s*===?\s*['\"]test['\"]"),
    re.compile(r"import\.meta\.vitest"),
    re.compile(r"PYTEST_CURRENT_TEST"),
    re.compile(r"""["']pytest["']\s+in\s+sys\.modules"""),
]
SPECIAL_COMMENT_RE = re.compile(r"for the test|hard-?code|为了测试|测试专用", re.I)
IMPORT_FAIL_RE = re.compile(r"Cannot find module|ImportError|ModuleNotFoundError|is not a function|is not defined|Failed to resolve import|Failed to load url", re.I)


class EnvError(Exception):
    """用法或环境错误（退出码 2）"""


# --------------------------------------------------------------------------
# 文本小工具
# --------------------------------------------------------------------------

def norm_nl(text):
    return text.replace("\r\n", "\n").replace("\r", "\n")


def split_lines(text):
    return norm_nl(text).split("\n")


def read_file(path, limit=4 * 1024 * 1024):
    try:
        if os.path.getsize(path) > limit:
            return None
        with open(path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    if b"\x00" in data[:8192]:
        return None
    return data.decode("utf-8", errors="replace")


def fence_lines(lines):
    """围栏代码块里的行号集合（1 起，含围栏行本身）。"""
    inside = set()
    fence = None
    for i, line in enumerate(lines, 1):
        m = re.match(r"^\s{0,3}(`{3,}|~{3,})", line)
        if fence is None:
            if m:
                fence = (m.group(1)[0], len(m.group(1)))
                inside.add(i)
        else:
            inside.add(i)
            if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= fence[1] and not line.strip()[len(m.group(1)):].strip():
                fence = None
    return inside


def heading_of(line):
    m = re.match(r"^(#{1,6})\s+(.*?)\s*#*\s*$", line)
    if not m:
        return None
    return len(m.group(1)), m.group(2).strip()


def heading_matches(name, text):
    """§节名匹配：全等，或标题以节名开头、后面紧跟空格或括号（全角半角都认）。"""
    name = name.strip()
    text = text.strip()
    if text == name:
        return True
    if text.startswith(name) and len(text) > len(name) and text[len(name)] in " \t(（":
        return True
    return False


def hash_lines(lines):
    """内容指纹：逐行去掉行尾空白、换行统一成 \\n，sha256 取前 12 位。"""
    data = "".join(l.rstrip() + "\n" for l in lines)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()[:12]


def glob_to_re(pat):
    out = []
    i = 0
    while i < len(pat):
        c = pat[i]
        if pat.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pat.startswith("/**", i) and i + 3 == len(pat):
            out.append("/.*")
            i += 3
        elif pat.startswith("**", i):
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(c))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def tier_max(a, b):
    if a is None:
        return b
    if b is None:
        return a
    return a if TIER_RANK[a] >= TIER_RANK[b] else b


def strip_punct(s):
    return "".join(ch for ch in s if unicodedata.category(ch)[0] not in "PZSC").lower()


def short(text, n=60):
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


# --------------------------------------------------------------------------
# 受管内容的标记和指纹（9.1）
# --------------------------------------------------------------------------

def parse_attrs(s):
    return dict(re.findall(r"(\w+)=(\S+)", s))


def find_block(lines, kind):
    """在行列表里找 <!-- sdd:KIND ... --> 到 <!-- /sdd:KIND -->（跳过代码块里的）。
    返回 (开标记行下标, 关标记行下标, 属性字典)；找不到返回 None。"""
    open_re = re.compile(r"^\s*<!--\s*sdd:%s\b(.*?)-->\s*$" % re.escape(kind))
    close_re = re.compile(r"^\s*<!--\s*/sdd:%s\s*-->\s*$" % re.escape(kind))
    fenced = fence_lines(lines)
    start = None
    attrs = {}
    for i, line in enumerate(lines):
        if (i + 1) in fenced:
            continue
        if start is None:
            m = open_re.match(line)
            if m:
                start = i
                attrs = parse_attrs(m.group(1))
        elif close_re.match(line):
            return start, i, attrs
    return None


def block_hash(lines, start, end):
    return hash_lines(lines[start + 1:end])


def script_hash(text):
    """spec-check.py 自身的指纹：覆盖除第 2 行以外的所有行。"""
    lines = split_lines(text)
    if lines and lines[-1] == "":
        lines = lines[:-1]
    rest = lines[:1] + lines[2:]
    return hash_lines(rest)


def set_marker_attrs(line, updates):
    """把标记行里的 key=value 就地改成新值（没有这个键就补在末尾）。行尾的 \\r 等原样保留。"""
    body = line.rstrip()
    tail = line[len(body):]
    for key, value in updates.items():
        if re.search(r"(?<=\s)%s=\S+" % re.escape(key), body):
            body = re.sub(r"(?<=\s)%s=\S+" % re.escape(key), lambda m, k=key, v=value: "%s=%s" % (k, v), body, count=1)
        elif body.endswith("-->"):
            body = re.sub(r"\s*-->$", " %s=%s -->" % (key, value), body, count=1)
        else:
            body += " %s=%s" % (key, value)
    return body + tail


def compute_modules(tier, cfg_modules):
    mods = list(TIER_MODULES.get(tier, []))
    for name in cfg_modules:
        if name in MODULE_ORDER and name not in mods:
            mods.append(name)
    return [m for m in MODULE_ORDER if m in mods]


def fingerprint_state(root):
    """三样受管内容各自的状态。返回 [(名称, 路径, 状态, 说明)]。"""
    out = []
    for kind, rel in (("core", "AGENTS.md"), ("process", "docs/spec-driven-dev.md")):
        path = os.path.join(root, rel)
        text = read_file(path) if os.path.exists(path) else None
        if text is None:
            out.append((kind, rel, "missing", ""))
            continue
        lines = split_lines(text)
        found = find_block(lines, kind)
        if not found:
            out.append((kind, rel, "missing", ""))
            continue
        s, e, attrs = found
        actual = block_hash(lines, s, e)
        recorded = attrs.get("hash", "")
        state = "clean" if recorded == actual else "modified"
        note = "v=%s tier=%s 记下 %s 现算 %s" % (attrs.get("v", "?"), attrs.get("tier", "?"), recorded or "无", actual)
        out.append((kind, rel, state, note))
    me = os.path.realpath(__file__)
    try:
        rel = os.path.relpath(me, os.path.realpath(root))
        if rel.startswith(".."):
            rel = me
    except ValueError:
        rel = me
    text = read_file(me)
    m = re.match(r"^# sdd:spec-check\s+(.*)$", split_lines(text)[1]) if text and len(split_lines(text)) > 1 else None
    if not m:
        out.append(("spec-check", rel, "missing", "第 2 行没有 sdd:spec-check 标记"))
    else:
        attrs = parse_attrs(m.group(1))
        actual = script_hash(text)
        recorded = attrs.get("hash", "")
        out.append(("spec-check", rel, "clean" if recorded == actual else "modified",
                    "v=%s 记下 %s 现算 %s" % (attrs.get("v", "?"), recorded or "无", actual)))
    return out


def stamp_all(root, tier_override, cfg_modules):
    """重算三样受管内容的指纹，并把版本、档位（、模块列表）写回各自的标记。先算后写。
    每个文件原来的换行（LF / CRLF）原样保留；脚本自己的第 2 行只在脚本位于项目根之内时才改，
    从 skill 目录跑时不碰 skill 里的脚本。"""
    plans = []  # (path, new_text)
    core_path = os.path.join(root, "AGENTS.md")
    proc_path = os.path.join(root, "docs", "spec-driven-dev.md")
    tier = tier_override
    texts = {}
    for path in (core_path, proc_path):
        if os.path.exists(path):
            texts[path] = read_file(path)
    if tier is None:
        for kind, path in (("core", core_path), ("process", proc_path)):
            if texts.get(path) is not None:
                found = find_block(texts[path].split("\n"), kind)
                if found and found[2].get("tier") in TIERS:
                    tier = found[2]["tier"]
                    break
    messages = []
    for kind, path in (("core", core_path), ("process", proc_path)):
        text = texts.get(path)
        if text is None:
            continue
        lines = text.split("\n")  # 不去掉行尾的 \r，写回时换行就不变
        found = find_block(lines, kind)
        if not found:
            continue
        s, e, attrs = found
        if tier is None:
            raise EnvError("标记里的档位还是占位，请加 --tier <lite|standard|heavy>")
        updates = {"v": VERSION, "tier": tier, "hash": block_hash(lines, s, e)}
        if kind == "process":
            updates["modules"] = ",".join(compute_modules(tier, cfg_modules)) or "none"
        lines[s] = set_marker_attrs(lines[s], updates)
        plans.append((path, "\n".join(lines)))
        messages.append("%s: %s" % (os.path.relpath(path, root), lines[s].strip()))
    me = os.path.realpath(__file__)
    root_real = os.path.realpath(root)
    text = read_file(me) if me.startswith(root_real + os.sep) else None
    if text is not None:
        lines = text.split("\n")
        if len(lines) > 1 and re.match(r"^# sdd:spec-check\b", lines[1]):
            lines[1] = set_marker_attrs(lines[1], {"v": VERSION, "hash": script_hash(text)})
            plans.append((me, "\n".join(lines)))
            messages.append("spec-check: %s" % lines[1].strip())
    for path, new_text in plans:
        with open(path, "w", encoding="utf-8", newline="") as f:
            f.write(new_text)
    return messages


# --------------------------------------------------------------------------
# git 封装
# --------------------------------------------------------------------------

def clean_env():
    env = dict(os.environ)
    for k in list(env):
        if k.startswith("GIT_") and k not in ("GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL"):
            env.pop(k)
    return env


class Git(object):
    def __init__(self, root, keep_env=True):
        self.root = root
        self.env = dict(os.environ) if keep_env else clean_env()
        self.env["GIT_OPTIONAL_LOCKS"] = "0"
        self._show_cache = {}

    def run(self, *args, **kw):
        cmd = ["git", "-c", "core.quotepath=false"] + list(args)
        try:
            p = subprocess.run(cmd, cwd=kw.get("cwd", self.root), env=self.env, input=kw.get("input"),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=kw.get("timeout", 120))
        except (OSError, subprocess.SubprocessError) as e:
            return 127, b"", str(e).encode("utf-8")
        return p.returncode, p.stdout, p.stderr

    def out(self, *args, **kw):
        rc, out, _ = self.run(*args, **kw)
        if rc != 0:
            return None
        return out.decode("utf-8", errors="replace")

    def ok(self, *args, **kw):
        rc, _, _ = self.run(*args, **kw)
        return rc == 0

    def rev(self, ref):
        o = self.out("rev-parse", "--verify", "--quiet", ref + "^{commit}")
        return o.strip() if o and o.strip() else None

    def merge_base(self, a, b):
        o = self.out("merge-base", a, b)
        return o.strip() if o and o.strip() else None

    def is_ancestor(self, a, b):
        return self.ok("merge-base", "--is-ancestor", a, b)

    def parents(self, rev):
        o = self.out("rev-list", "--parents", "-n", "1", rev)
        if not o:
            return []
        return o.split()[1:]

    def show(self, rev, path):
        """rev 为 '' 时读暂存区（:path）。读不到返回 None。"""
        key = (rev, path)
        if key in self._show_cache:
            return self._show_cache[key]
        spec = "%s:%s" % (rev, path)
        rc, out, _ = self.run("show", spec)
        val = out.decode("utf-8", errors="replace") if rc == 0 else None
        self._show_cache[key] = val
        return val

    def ls_files(self):
        o = self.out("ls-files", "-z")
        return [p for p in (o or "").split("\0") if p]

    def ls_untracked(self):
        o = self.out("ls-files", "--others", "--exclude-standard", "-z")
        return [p for p in (o or "").split("\0") if p]

    def empty_tree(self):
        o = self.out("hash-object", "-t", "tree", "/dev/null")
        return o.strip() if o else "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

    def name_status(self, *diff_args):
        """返回 [(状态字母, 旧路径, 新路径)]。"""
        o = self.out("diff", "--name-status", "-M", "-z", "--no-ext-diff", *diff_args)
        if o is None:
            return None
        parts = o.split("\0")
        res = []
        i = 0
        while i < len(parts) and parts[i]:
            st = parts[i]
            if st[0] in "RC":
                res.append((st[0], parts[i + 1], parts[i + 2]))
                i += 3
            else:
                res.append((st[0], parts[i + 1], parts[i + 1]))
                i += 2
        return res


def diff_texts(before, after):
    """逐行对比两段文本。返回 (新增行[(行号, 文本)], 删除行[(行号, 文本)])。行号 1 起。"""
    a = [] if before is None else split_lines(before)
    b = [] if after is None else split_lines(after)
    if a and a[-1] == "":
        a = a[:-1]
    if b and b[-1] == "":
        b = b[:-1]
    if not a:
        return [(i + 1, l) for i, l in enumerate(b)], []
    if not b:
        return [], [(i + 1, l) for i, l in enumerate(a)]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=len(a) + len(b) > 4000)
    added, removed = [], []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag in ("replace", "delete"):
            removed.extend((i + 1, a[i]) for i in range(i1, i2))
        if tag in ("replace", "insert"):
            added.extend((j + 1, b[j]) for j in range(j1, j2))
    return added, removed


# --------------------------------------------------------------------------
# 配置、上下文、输出
# --------------------------------------------------------------------------

def load_config(root):
    path = os.path.join(root, ".sdd", "config.json")
    if not os.path.exists(path):
        return {}
    text = read_file(path)
    try:
        cfg = json.loads(text or "{}")
    except ValueError as e:
        raise EnvError(".sdd/config.json 不是合法 JSON：%s" % e)
    if not isinstance(cfg, dict):
        raise EnvError(".sdd/config.json 顶层必须是对象")
    return cfg


def norm_msg(msg):
    """把消息里会变的部分抹掉（提交号、数字），用来给「已知不合规」按条匹配。"""
    msg = re.sub(r"\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b", "<sha>", msg)
    msg = re.sub(r"\d+", "#", msg)
    return " ".join(msg.split())


class Finding(object):
    def __init__(self, level, check, file, msg):
        self.level, self.check, self.file, self.msg = level, check, file or "-", msg

    def line(self):
        return "%s %s %s: %s" % (LEVEL_LABEL[self.level], self.check, self.file, self.msg)


class Ctx(object):
    def __init__(self, root, cfg, args, env=None):
        self.root = root
        self.cfg = cfg
        self.args = args
        self.env = env if env is not None else os.environ
        self.git = Git(root)
        self.findings = []
        self.suppressed = 0
        self.notes = []
        self.proj_tier = "lite"
        self.modules = set()
        self.is_ci = bool(self.env.get("GITHUB_ACTIONS") or self.env.get("CI"))
        self.is_push = self.env.get("GITHUB_EVENT_NAME") == "push"  # push 事件（不经 PR）只跑「仓库现状」类检查
        # 已知不合规（config 的 known）：每项 {check, file, message}，按「检查 + 文件 + 归一后的消息」逐条匹配。
        # 向后兼容：老版本 --save 写的 {check, file} 没有 message，当作该 check+file 的通配（整个文件的这类发现都放过）。
        self.known_exact = set()
        self.known_wild = set()
        for item in cfg.get("known") or []:
            if isinstance(item, dict) and isinstance(item.get("check"), str) and isinstance(item.get("file"), str):
                if isinstance(item.get("message"), str):
                    self.known_exact.add((item["check"], item["file"], norm_msg(item["message"])))
                else:
                    self.known_wild.add((item["check"], item["file"]))
        self._test_re = None
        helper_globs = cfg.get("helper_globs")
        if not isinstance(helper_globs, list):
            helper_globs = []
        self._helper_re = [glob_to_re(g) for g in helper_globs if isinstance(g, str) and g]
        self._name_re = None
        self._registered_re = None
        self._cfg_re = None
        self.tamper_tier = None  # tamper 实际按哪一档跑的；没跑就是 None，汇总行要写明
        self.code_prefixes = list(DEFAULT_CODE_PREFIXES)
        for p in cfg.get("code_prefixes") or []:
            if isinstance(p, str) and p not in self.code_prefixes:
                self.code_prefixes.append(p)

    # -- 记录发现 --
    def add(self, check, file, msg, level=None, tier="lite"):
        if level is None:
            level = LEVEL_TABLE[check][TIER_RANK[tier]]
        if level is None:
            return
        file = self.rel_file(file)
        if check not in NO_KNOWN_CHECKS and ((check, file) in self.known_wild or (check, file, norm_msg(msg)) in self.known_exact):
            self.suppressed += 1
            return
        self.findings.append(Finding(level, check, file, msg))

    def rel_file(self, file):
        """发现里的文件一律写仓库相对路径；绝对路径在仓库里的就转成相对的。"""
        if file and os.path.isabs(file):
            root = os.path.realpath(self.root)
            rp = os.path.realpath(file)
            if rp == root or rp.startswith(root + os.sep):
                return os.path.relpath(rp, root).replace(os.sep, "/")
        return file

    def block(self, check, file, msg):
        self.add(check, file, msg, level=BLOCK)

    def warn(self, check, file, msg):
        self.add(check, file, msg, level=WARN)

    # -- 配置读取 --
    def limit(self, key, tier):
        """体量上限：config 的 limits 里每个键可以写数字，也可以写 {lite, standard, heavy}；
        没写这一档、或写的不是数字，就用默认值。"""
        default = DEFAULT_LIMITS[key]
        fallback = default.get(tier) if isinstance(default, dict) else default
        lim = (self.cfg.get("limits") or {}).get(key)
        if isinstance(lim, dict):
            lim = lim.get(tier)
        if isinstance(lim, bool) or not isinstance(lim, (int, float)):
            return fallback
        return lim

    def cfg_modules(self):
        mods = self.cfg.get("modules") or {}
        if isinstance(mods, list):
            return [m for m in mods if isinstance(m, str)]
        if isinstance(mods, dict):
            return [k for k, v in mods.items() if v not in (False, None)]
        return []

    def module_conf(self, name):
        mods = self.cfg.get("modules")
        if isinstance(mods, dict) and isinstance(mods.get(name), dict):
            return mods[name]
        return {}

    def has_module(self, name):
        return name in self.modules

    def spec_roots(self):
        roots = self.cfg.get("spec_roots")
        if not roots:
            return list(DEFAULT_SPEC_ROOTS)
        out = []
        for r in roots:
            r = str(r).strip().rstrip("/")
            out.append(r if r.endswith(".md") else r + "/*/spec.md")
        return out

    def is_test_file(self, path):
        if self._test_re is None:
            globs = self.cfg.get("test_globs") or TEST_GLOBS
            globs = list(globs) + list(self.cfg.get("tamper_files") or [])
            self._test_re = [glob_to_re(g) for g in globs]
        return any(r.match(path) for r in self._test_re)

    def is_registered_test_file(self, path):
        """config 的 tamper_files 里登记的文件（不管扩展名）。"""
        if self._registered_re is None:
            self._registered_re = [glob_to_re(g) for g in (self.cfg.get("tamper_files") or []) if isinstance(g, str) and g]
        return any(r.match(path) for r in self._registered_re)

    def runner_collects(self, path):
        """这个路径的文件名，测试运行器会不会收进去：是代码文件，并且按文件名（不看所在目录）算测试。
        改了 test_globs 就按它；tamper_files 也算。"""
        if not path.endswith(CODE_EXTS):
            return False
        if self._name_re is None:
            globs = list(self.cfg.get("test_globs") or NAME_TEST_GLOBS) + list(self.cfg.get("tamper_files") or [])
            self._name_re = [glob_to_re(g) for g in globs]
        return any(r.match(path) for r in self._name_re)

    def is_runconfig(self, path):
        base = os.path.basename(path)
        for pat in RUNCONFIG_NAMES:
            if glob_to_re(pat).match(base):
                return True
        return base == "package.json"

    def is_prod_code(self, path):
        if not path.endswith(CODE_EXTS):
            return False
        if self.is_test_file(path):
            return False
        if any(r.match(path) for r in self._helper_re):
            return False
        if path.startswith((".sdd/", ".claude/", ".github/")):
            return False
        return True

    def seam_vars(self):
        return [v for v in (self.cfg.get("seam_vars") or []) if isinstance(v, str)]

    def local_dir(self):
        return os.path.join(self.root, ".sdd", "local")


# --------------------------------------------------------------------------
# 检查范围（Scope）：这次要看哪些文件、新增了哪些行
# --------------------------------------------------------------------------

class FileChange(object):
    def __init__(self, path, status, old=None):
        self.path, self.status, self.old = path, status, old or path


class Scope(object):
    """mode: range（整个 PR / 工作区）、staged（暂存区）、all（全量体检，所有内容都当新增）。"""

    def __init__(self, ctx, mode, base, after, changes, note=None):
        self.ctx, self.mode, self.base, self.after, self.changes = ctx, mode, base, after, changes
        self.note = note
        self._after, self._before, self._diff = {}, {}, {}
        self.target_ref = None
        self.review_head = "HEAD"

    @property
    def git(self):
        return self.ctx.git

    def paths(self):
        return list(self.changes.keys())

    def read_after(self, path):
        if path in self._after:
            return self._after[path]
        fc = self.changes.get(path)
        if fc is not None and fc.status == "D":
            val = None
        elif self.after == "index":
            val = self.git.show("", path)
        elif self.after == "head":
            val = self.git.show("HEAD", path)
        else:
            val = read_file(os.path.join(self.ctx.root, path))
        self._after[path] = val
        return val

    def read_before(self, path):
        if path in self._before:
            return self._before[path]
        fc = self.changes.get(path)
        if self.base is None or fc is None or fc.status == "A":
            val = None
        else:
            val = self.git.show(self.base, fc.old)
        self._before[path] = val
        return val

    def read_state(self, path):
        """不论是否改动，读这个文件在「改完之后」的内容。"""
        if path in self.changes:
            return self.read_after(path)
        if self.after == "index":
            return self.git.show("", path)
        if self.after == "head":
            return self.git.show("HEAD", path)
        return read_file(os.path.join(self.ctx.root, path))

    def diff(self, path):
        if path not in self._diff:
            fc = self.changes.get(path)
            if fc is None:
                self._diff[path] = ([], [])
            else:
                self._diff[path] = diff_texts(self.read_before(path), self.read_after(path))
        return self._diff[path]

    def added(self, path):
        return self.diff(path)[0]

    def removed(self, path):
        return self.diff(path)[1]

    def status(self, path):
        fc = self.changes.get(path)
        return fc.status if fc else None

    def tracked_files(self):
        """改完之后仓库里的文件列表。"""
        if self.after == "index":
            return self.git.ls_files()
        if self.after == "head":
            o = self.git.out("ls-tree", "-r", "-z", "--name-only", "HEAD")
            return [p for p in (o or "").split("\0") if p]
        files = self.git.ls_files() + self.git.ls_untracked()
        return sorted(set(f for f in files if os.path.exists(os.path.join(self.ctx.root, f))))

    def doc_only(self):
        return all(p.endswith(".md") for p in self.changes)


def resolve_base(ctx, args):
    """基线优先级：--base > GITHUB_BASE_REF > push 事件用 HEAD~1 > target_branch > origin/HEAD > main。
    返回 (分叉点提交号, 目标分支引用名)；找不到返回 (None, None)。"""
    g = ctx.git
    env = ctx.env
    if getattr(args, "base", None):
        cands = [args.base, "origin/" + args.base]
    elif env.get("GITHUB_BASE_REF"):
        b = env["GITHUB_BASE_REF"]
        cands = ["origin/" + b, b]
    elif env.get("GITHUB_EVENT_NAME") == "push":
        sha = g.rev("HEAD~1")
        return (sha, None) if sha else (None, None)
    else:
        cands = []
        tb = ctx.cfg.get("target_branch")
        if tb:
            cands += ["origin/" + tb, tb]
        cands += ["origin/HEAD", "main", "origin/main"]
    for ref in cands:
        if g.rev(ref):
            mb = g.merge_base(ref, "HEAD")
            if mb:
                return mb, ref
    return None, None


def build_scope(ctx, args, mode):
    g = ctx.git
    if mode == "staged":
        base = g.rev("HEAD") or g.empty_tree()
        ns = g.name_status("--cached", base) or []
        changes = {}
        for st, old, new in ns:
            changes[new] = FileChange(new, st, old)
        return Scope(ctx, "staged", base if g.rev("HEAD") else None, "index", changes)
    if mode == "all":
        files = g.ls_files() + g.ls_untracked()
        changes = dict((p, FileChange(p, "A")) for p in sorted(set(files)) if os.path.exists(os.path.join(ctx.root, p)))
        return Scope(ctx, "all", None, "worktree", changes)
    # range
    base, target = resolve_base(ctx, args)
    if g.rev("HEAD") is None:
        return Scope(ctx, "range", None, "worktree", dict((p, FileChange(p, "A")) for p in g.ls_files() + g.ls_untracked()),
                     note="仓库还没有提交")
    note = None
    if base is None:
        note = "找不到和目标分支的分叉点：完整性检查照跑，格式类只查工作区的改动"
        base = g.rev("HEAD")
    after = "head" if ctx.is_ci else "worktree"
    if after == "head":
        ns = g.name_status(base, "HEAD") or []
    else:
        ns = g.name_status(base) or []
    changes = {}
    for st, old, new in ns:
        changes[new] = FileChange(new, st, old)
    if after == "worktree":
        for p in g.ls_untracked():
            if p not in changes:
                changes[p] = FileChange(p, "A")
    sc = Scope(ctx, "range", base, after, changes, note=note)
    sc.target_ref = target
    # CI 的 pull_request 事件默认取出的是 GitHub 合成的合并提交，评审要看真正的 PR 头
    if ctx.is_ci and ctx.env.get("GITHUB_EVENT_NAME") == "pull_request":
        ps = g.parents("HEAD")
        if len(ps) == 2:
            sc.review_head = ps[1]
    return sc


# --------------------------------------------------------------------------
# spec 模型：页头、引用、验收、plan、log
# --------------------------------------------------------------------------

class HeaderEntry(object):
    def __init__(self, key, value, lineno, default_kind=None, raw_key=""):
        self.key, self.value, self.lineno, self.default_kind, self.raw_key = key, value, lineno, default_kind, raw_key


BASE_KEYS = {
    "status": ("status", None), "tier": ("tier", None), "phase": ("phase", None),
    "changes": ("changes", None), "changed by": ("changed by", None), "approved": ("approved", None),
    "amends": ("changes", None), "amended by": ("changed by", None),
}
HEADER_LINE_RE = re.compile(r"^([^\s#>`*\-|\[<][^:：]{0,40}?)\s*[:：]\s*(.*)$")


def header_alias_map(cfg):
    out = {}
    for k, v in (cfg.get("header_aliases") or {}).items():
        base = re.split(r"[（(]", str(v), 1)
        kind = None
        if len(base) > 1:
            kind = re.sub(r"[）)].*$", "", base[1]).strip() or None
        key = " ".join(base[0].lower().split())
        if key in BASE_KEYS:
            out[" ".join(str(k).lower().split())] = (BASE_KEYS[key][0], kind)
    return out


def parse_header(lines, aliases):
    """页头 = H1 到第一个 ## 之间。返回 (H1 文本, [HeaderEntry], 页头结束的下标)。"""
    title = ""
    entries = []
    end = len(lines)
    for i, line in enumerate(lines):
        if line.startswith("## "):
            end = i
            break
    for i in range(end):
        line = lines[i]
        if not title and line.startswith("# "):
            title = line[2:].strip()
            continue
        m = HEADER_LINE_RE.match(line)
        if not m:
            continue
        raw = m.group(1)
        key = " ".join(raw.lower().split())
        if key in aliases:
            canon, kind = aliases[key]
        elif key in BASE_KEYS:
            canon, kind = BASE_KEYS[key]
        else:
            continue
        entries.append(HeaderEntry(canon, m.group(2).strip(), i + 1, kind, raw))
    return title, entries, end


def split_entries(value):
    """按 ；/; 切分多条，括号和方括号里的不切。"""
    out, depth, cur = [], 0, []
    for ch in value:
        if ch in "（([":
            depth += 1
        elif ch in "）)]":
            depth = max(0, depth - 1)
        if ch in "；;" and depth == 0:
            out.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    out.append("".join(cur))
    return [e.strip() for e in out if e.strip()]


MDLINK_RE = re.compile(r"^\[[^\]]*\]\([^)]*\)")


def parse_ref_entry(entry, default_kind=None):
    """<ref> [§节][（增补|替换[：说明] / 取代 / §节）]  →  dict(ref, section, kind)"""
    e = entry.strip()
    m = MDLINK_RE.match(e)
    if m:
        ref, rest = m.group(0), e[m.end():]
    else:
        m = re.match(r"^[^\s§（(：:]+", e)
        ref, rest = (m.group(0), e[m.end():]) if m else (e, "")
    rest = rest.strip()
    section, kind = None, default_kind
    sm = re.match(r"^§\s*([^（(—]+)", rest)
    if sm:
        section = re.split(r"\s*[、，,]\s*|\s+[与和及]\s+|\s*§", sm.group(1))[0].strip()
        rest = rest[sm.end():].strip()
    pm = re.match(r"^[（(]\s*(.*)[）)]\s*$", rest, re.S)
    if pm:
        inner = pm.group(1).strip()
        if inner.startswith("§") and section is None:
            section = re.split(r"[）)]", inner[1:])[0].strip()
        for k in ("增补", "替换", "取代"):
            if inner.startswith(k):
                kind = k
                break
    if section is not None:
        section = section.strip() or None
    return {"ref": ref, "section": section, "kind": kind, "raw": entry}


def parse_status_value(value):
    v = value.strip()
    m = re.match(r"^superseded\s+by\s+(.+)$", v, re.I)
    if m:
        return "superseded", m.group(1).strip()
    m = re.match(r"^(draft|ready|implemented)\b", v, re.I)
    if m:
        return m.group(1).lower(), None
    return "invalid", None


def tier_of_value(value):
    m = re.match(r"^\s*(lite|standard|heavy)\b", value or "", re.I)
    return m.group(1).lower() if m else None


class Spec(object):
    def __init__(self, ctx, path, text):
        self.path = path
        self.dir = os.path.dirname(path)
        self.name = os.path.basename(self.dir)
        parts = self.dir.split("/")
        self.kind = "architecture" if "architecture" in parts else ("features" if "features" in parts else "other")
        m = re.match(r"^(\d{2})-", self.name)
        self.num = m.group(1) if m else None
        self.id = self.num if (self.num and self.kind == "architecture") else self.name
        self.text = text or ""
        self.lines = split_lines(self.text)
        self.title, self.entries, self.header_end = parse_header(self.lines, header_alias_map(ctx.cfg))
        self._ctx = ctx

    # 页头取值
    def values(self, key):
        return [e for e in self.entries if e.key == key]

    def first(self, key):
        v = self.values(key)
        return v[0].value if v else None

    @property
    def status_raw(self):
        return self.first("status")

    @property
    def status(self):
        v = self.status_raw
        return parse_status_value(v)[0] if v is not None else None

    @property
    def superseded_ref(self):
        v = self.status_raw
        return parse_status_value(v)[1] if v is not None else None

    @property
    def tier_own(self):
        return tier_of_value(self.first("tier"))

    def tier(self, default):
        return self.tier_own or default

    def title_names(self):
        t = self.title
        t = re.sub(r"^\s*\d+\s*[·.、:：\-—]\s*", "", t)
        aliases = re.findall(r"[（(]([^）)]+)[）)]", t)
        body = re.sub(r"[（(][^）)]*[）)]", "", t).strip()
        return body, aliases

    def names(self):
        body, aliases = self.title_names()
        out = [self.id, self.name]
        if self.num:
            out.append(self.num)
        out += [body] + aliases
        seen, res = set(), []
        for n in out:
            n = n.strip()
            if len(n) >= 2 and n.lower() not in seen:
                seen.add(n.lower())
                res.append(n)
        return res

    def named_in(self, quote):
        q = quote.lower()
        for n in self.names():
            nl = n.lower()
            if re.fullmatch(r"[0-9]+", nl):
                if re.search(r"(?<![0-9])%s(?![0-9])" % re.escape(nl), q):
                    return True
            elif nl in q:
                return True
        return False

    def sections(self):
        """[(行下标, 级别, 标题文本)]"""
        fenced = fence_lines(self.lines)
        out = []
        for i, line in enumerate(self.lines):
            if (i + 1) in fenced:
                continue
            h = heading_of(line)
            if h:
                out.append((i, h[0], h[1]))
        return out

    def find_section(self, name):
        for i, level, text in self.sections():
            if heading_matches(name, text):
                return i, level
        return None

    def section_span(self, name):
        found = self.find_section(name)
        if not found:
            return None
        start, level = found
        end = len(self.lines)
        for i, lv, _ in self.sections():
            if i > start and lv <= level:
                end = i
                break
        return start, end


def parse_acceptance(spec_lines):
    """## 验收标准 下的顶层列表项。返回 (OrderedDict-like list[(N, 文本)], 是否找到这一节)。"""
    start = None
    fenced = fence_lines(spec_lines)
    for i, line in enumerate(spec_lines):
        h = heading_of(line)
        if h and h[0] == 2 and heading_matches("验收标准", h[1]) and (i + 1) not in fenced:
            start = i
            break
    if start is None:
        return [], False
    items = []
    for j in range(start + 1, len(spec_lines)):
        line = spec_lines[j]
        if (j + 1) in fenced:
            if items:
                items[-1][1] += "\n" + line
            continue
        h = heading_of(line)
        if h and h[0] <= 2:
            break
        m = re.match(r"^(\d+)[.、]\s*(.*)$", line)
        if m:
            items.append([int(m.group(1)), m.group(2)])
        elif items and (line.startswith((" ", "\t")) or not line.strip()):
            items[-1][1] += "\n" + line
    return [(n, t) for n, t in items], True


def acceptance_tag(text):
    """验收条目的标记：manual（人工）、live、platform（平台，可以写成（平台：macOS））；没标返回 None。"""
    if re.search(r"[（(]\s*人工\s*[）)]", text):
        return "manual"
    if re.search(r"[（(]\s*live\s*[）)]", text, re.I):
        return "live"
    if re.search(r"[（(]\s*平台\s*(?:[:：][^）)]*)?[）)]", text):
        return "platform"
    return None


class Step(object):
    def __init__(self, checked, num, text, indent):
        self.checked, self.num, self.text, self.indent = checked, num, text, indent


class Plan(object):
    def __init__(self, text):
        self.text = text or ""
        self.lines = split_lines(self.text)
        self.headings = []   # [(下标, 文本)]
        self.steps = []
        fenced = fence_lines(self.lines)
        section = None
        for i, line in enumerate(self.lines):
            if (i + 1) in fenced:
                continue
            h = heading_of(line)
            if h and h[0] == 2:
                self.headings.append((i, h[1]))
                section = h[1]
                continue
            if section is not None and heading_matches("步骤", section):
                m = re.match(r"^(\s*)- \[( |x|X)\]\s*(.*)$", line)
                if m:
                    body = m.group(3)
                    nm = re.match(r"^(\d+(?:\.\d+)*)\.?\s+(.*)$", body)
                    self.steps.append(Step(m.group(2) != " ", nm.group(1) if nm else None,
                                           nm.group(2) if nm else body, len(m.group(1))))

    def unchecked(self):
        return [s for s in self.steps if not s.checked]

    def pending(self):
        return bool(self.unchecked())

    def waiting_for_owner(self):
        u = self.unchecked()
        return len(u) == 1 and bool(re.search(r"owner\s*验收\s*(→|->)\s*改\s*Status", u[0].text))

    def field(self, name):
        for line in self.lines:
            m = re.match(r"^\s*%s\s*[:：]\s*(.*)$" % re.escape(name), line)
            if m:
                return m.group(1).strip()
        return None


class ReviewRecord(object):
    def __init__(self, heading, lineno, sha, date, lines):
        self.heading, self.lineno, self.sha, self.date, self.lines = heading, lineno, sha, date, lines

    def verdict(self):
        for l in self.lines:
            m = re.match(r"^\s*结论[:：]\s*(通过|不通过)", l)
            if m:
                return m.group(1)
        return None

    def has_mutation_line(self):
        return any(re.match(r"^\s*突变[:：]", l) for l in self.lines)

    def findings(self):
        out = []
        for l in self.lines:
            m = re.match(r"^\s*-\s*\[(blocker|major|建议)\]\s*(.*)$", l)
            if m:
                out.append((m.group(1), m.group(2)))
        return out


def finding_disposition(rest):
    parts = re.split(r"\s·\s", rest)
    last = parts[-1].strip() if len(parts) > 1 else ""
    if re.match(r"^已修\s+[0-9a-fA-F]{7,40}", last):
        return "已修"
    if re.match(r"^不修[:：]", last):
        return "不修"
    if re.match(r"^交\s*owner", last):
        return "交 owner"
    return None


class Mutant(object):
    def __init__(self, mid, spec_ref, gate, path, original, replacement, lineno):
        self.id, self.spec_ref, self.gate, self.path = mid, spec_ref, gate, path
        self.original, self.replacement, self.lineno = original, replacement, lineno


class Log(object):
    def __init__(self, text):
        self.text = text or ""
        self.lines = split_lines(self.text)

    def reviews(self):
        recs = []
        fenced = fence_lines(self.lines)
        idx = [i for i, l in enumerate(self.lines) if l.startswith("## ") and (i + 1) not in fenced]
        for n, i in enumerate(idx):
            line = self.lines[i]
            if not re.match(r"^##\s+评审(\s|$|·)", line):
                continue
            end = idx[n + 1] if n + 1 < len(idx) else len(self.lines)
            m = re.search(r"审过\s+([0-9a-fA-F]{7,40})", line)
            dm = re.search(r"(\d{4}-\d{2}-\d{2})", line)
            recs.append(ReviewRecord(line, i + 1, m.group(1) if m else None, dm.group(1) if dm else None, self.lines[i + 1:end]))
        return recs

    def line_items(self, label):
        out = []
        for i, l in enumerate(self.lines):
            m = re.match(r"^\s*(?:[-*]\s*)?%s[:：]\s*(.*)$" % re.escape(label), l)
            if m:
                out.append((i + 1, m.group(1).strip()))
        return out

    def test_changes(self):
        res = []
        for ln, body in self.line_items("测试改动"):
            parts = [p.strip() for p in body.split("·")]
            res.append((ln, parts[0] if parts else "", parts[1] if len(parts) > 1 else "",
                        " · ".join(parts[2:]) if len(parts) > 2 else ""))
        return res

    def test_author_commits(self):
        out = []
        for ln, body in self.line_items("测试作者提交"):
            m = re.match(r"([0-9a-fA-F]{7,40})", body)
            if m:
                out.append(m.group(1))
        return out

    def revoked(self):
        out = set()
        for l in self.lines:
            m = re.match(r"^\s*(?:[-*]\s*)?撤销突变\s*(M\d+)\s*[:：]", l)
            if m:
                out.add(m.group(1))
        return out

    def mutants(self):
        res = []
        fenced = fence_lines(self.lines)
        i = 0
        n = len(self.lines)
        while i < n:
            m = re.match(r"^###\s+突变\s+(M\d+)\s*·\s*(.+?)\s*·\s*门禁\s+(\S+)\s*$", self.lines[i])
            if not m or (i + 1) in fenced:
                i += 1
                continue
            j = i + 1
            while j < n and not re.match(r"^#{1,3}\s", self.lines[j]):
                j += 1
            body = self.lines[i + 1:j]
            path, orig, repl = None, None, None
            k = 0
            while k < len(body):
                fm = re.match(r"^\s*文件[:：]\s*`?([^`\s]+)`?\s*$", body[k])
                if fm:
                    path = fm.group(1)
                lab = re.match(r"^\s*(原文|改成)[:：]\s*$", body[k])
                if lab:
                    k += 1
                    while k < len(body) and not re.match(r"^\s*(`{3,}|~{3,})", body[k]):
                        k += 1
                    if k < len(body):
                        fence = re.match(r"^\s*(`{3,}|~{3,})", body[k]).group(1)
                        k += 1
                        buf = []
                        while k < len(body) and not body[k].strip().startswith(fence):
                            buf.append(body[k])
                            k += 1
                        if lab.group(1) == "原文":
                            orig = "\n".join(buf)
                        else:
                            repl = "\n".join(buf)
                k += 1
            res.append(Mutant(m.group(1), m.group(2), m.group(3), path, orig, repl, i + 1))
            i = j
        return res


def parse_wait_items(text):
    """### 待回流 skill 小节下以 `- ` 开头的条目。"""
    if not text:
        return []
    lines = split_lines(text)
    fenced = fence_lines(lines)
    out, inside = [], False
    for i, line in enumerate(lines):
        if (i + 1) in fenced:
            continue
        h = heading_of(line)
        if h:
            inside = h[1].startswith("待回流 skill")
            continue
        if inside and line.startswith("- "):
            out.append(line[2:].strip())
    return out


# --------------------------------------------------------------------------
# 项目初始化：核心块、档位、模块、spec 清单、PR 属于哪份 spec
# --------------------------------------------------------------------------

def read_core_marker(root):
    path = os.path.join(root, "AGENTS.md")
    text = read_file(path) if os.path.exists(path) else None
    if text is None:
        return None
    found = find_block(split_lines(text), "core")
    return found[2] if found else None


def init_project(ctx, allow_tier_flag=False):
    marker = read_core_marker(ctx.root)
    tier_arg = getattr(ctx.args, "tier", None)
    if marker is None and not (allow_tier_flag and tier_arg):
        raise EnvError("没接入：AGENTS.md 里找不到 sdd 核心块标记（<!-- sdd:core …）。新项目说「sdd init」，已有项目说「sdd adopt」。")
    tier = tier_arg or (marker or {}).get("tier")
    if tier is None:
        tier = "lite"
    if tier not in TIERS:
        raise EnvError("档位「%s」不合法，只认 lite / standard / heavy（标记里的 tier= 还是占位？）" % tier)
    ctx.proj_tier = tier
    mods = set(TIER_MODULES[tier]) | set(m for m in ctx.cfg_modules() if m in MODULE_ORDER)
    proc = os.path.join(ctx.root, "docs", "spec-driven-dev.md")
    ptext = read_file(proc) if os.path.exists(proc) else None
    if ptext:
        pf = find_block(split_lines(ptext), "process")
        if pf and pf[2].get("modules"):
            for m in pf[2]["modules"].split(","):
                if m.strip() in MODULE_ORDER:
                    mods.add(m.strip())
    ctx.modules = mods
    return marker


class SpecSet(object):
    def __init__(self, specs):
        self.list = specs
        self.by_path = dict((s.path, s) for s in specs)

    def resolve(self, ref, from_path=None):
        ref = (ref or "").strip()
        mm = re.match(r"^\[([^\]]*)\]\(([^)]*)\)", ref)
        if mm:
            target = mm.group(2).split("#")[0].strip()
            if target and from_path:
                p = os.path.normpath(os.path.join(os.path.dirname(from_path), target)).replace(os.sep, "/")
                if p in self.by_path:
                    return self.by_path[p]
                for s in self.list:
                    if s.dir == p.rstrip("/"):
                        return s
            ref = mm.group(1).strip()
        ref = ref.strip("`").strip()
        if not ref:
            return None
        for s in self.list:
            if ref == s.id or ref == s.name:
                return s
        for s in self.list:
            if s.num and ref == s.num:
                return s
        return None


def discover_specs(ctx, scope):
    regs = [glob_to_re(p) for p in ctx.spec_roots()]
    specs = []
    for p in scope.tracked_files():
        if any(r.match(p) for r in regs):
            text = scope.read_state(p)
            if text is None:
                continue
            specs.append(Spec(ctx, p, text))
    order = {"architecture": 0, "features": 1, "other": 2}
    specs.sort(key=lambda s: (order[s.kind], s.id))
    return SpecSet(specs)


def new_spec_paths(ctx, scope):
    new = set(p for p, fc in scope.changes.items() if fc.status == "A")
    bc = ctx.cfg.get("baseline_commit")
    if bc and ctx.git.rev(bc) and scope.mode != "all":
        ns = ctx.git.name_status("--diff-filter=A", bc, "HEAD") or []
        for st, old, p in ns:
            new.add(p)
    return new


def spec_of_path(specset, path):
    best = None
    for s in specset.list:
        if path.startswith(s.dir + "/"):
            if best is None or len(s.dir) > len(best.dir):
                best = s
    return best


def classify_specs(ctx, scope, specset):
    """返回 (动过的 spec 列表, 归属的 spec 列表)。只在页头加了 Changed by / 改成 superseded 的老 spec 不算归属。"""
    touched = {}
    for p in scope.changes:
        s = spec_of_path(specset, p)
        if s is not None:
            touched.setdefault(s.path, []).append(p)
    tl = [specset.by_path[k] for k in touched]
    owners = []
    for s in tl:
        files = touched[s.path]
        passive = False
        if files == [s.path] and scope.status(s.path) in ("M", "R"):
            bt = scope.read_before(s.path)
            if bt is not None and Spec(ctx, s.path, bt).status == "implemented":
                passive = True
        if not passive:
            owners.append(s)
    if not owners:
        owners = tl
    return tl, owners


class Project(object):
    """一次检查要用到的所有派生信息。"""

    def __init__(self, ctx, scope):
        self.ctx, self.scope = ctx, scope
        self.specs = discover_specs(ctx, scope)
        self.new_paths = new_spec_paths(ctx, scope)
        self.touched, self.owners = classify_specs(ctx, scope, self.specs)
        tier = None
        for s in self.owners:
            tier = tier_max(tier, s.tier(ctx.proj_tier))
        self.pr_tier = tier
        self.files = set(scope.tracked_files())

    def tier_of(self, spec):
        return spec.tier(self.ctx.proj_tier)

    def effective_tier(self):
        return self.pr_tier or "lite"


# --------------------------------------------------------------------------
# 完整性类检查（拦）
# --------------------------------------------------------------------------

def chk_status(ctx, pj):
    for s in pj.specs.list:
        raw = s.status_raw
        kind = None
        if raw is None:
            ctx.block("status", s.path, "页头没有 Status 行")
        else:
            kind, ref = parse_status_value(raw)
            if kind == "invalid":
                ctx.block("status", s.path, "Status 值「%s」不合法，只认 draft / ready / implemented / superseded by <ref>" % short(raw, 30))
            elif kind == "superseded":
                if pj.specs.resolve(ref, s.path) is None:
                    ctx.block("status", s.path, "superseded by %s 指向的 spec 不存在" % short(ref, 30))
        tv = s.first("tier")
        if tv is None:
            if s.path in pj.new_paths:
                ctx.block("status", s.path, "新写的 spec 缺 Tier: 行（写成 Tier: lite|standard|heavy — 一句理由）")
        elif tier_of_value(tv) is None:
            ctx.block("status", s.path, "Tier 值「%s」不是 lite / standard / heavy" % short(tv, 30))
        if kind == "ready" and (s.dir + "/plan.md") not in pj.files:
            ctx.block("status", s.path, "Status 是 ready，但同目录没有 plan.md")


APPROVED_RE = re.compile(r"^(?P<state>[^\s·]+)\s*·\s*(?P<date>\S+)\s*·\s*「(?P<quote>.*)」\s*·\s*(?P<src>[^·]*?)\s*$")


def validate_approved(spec, value, want_state):
    """返回错误说明列表（空 = 合格）。"""
    m = APPROVED_RE.match(value)
    if not m:
        return ["Approved 行格式不对，应为 Approved: 状态 · YYYY-MM-DD · 「原话」 · 出处"]
    errs = []
    if want_state and m.group("state").lower() != want_state:
        errs.append("Approved 行的状态是 %s，和这次改成的 %s 对不上" % (m.group("state"), want_state))
    try:
        datetime.datetime.strptime(m.group("date"), "%Y-%m-%d")
    except ValueError:
        errs.append("Approved 行的日期「%s」不是 YYYY-MM-DD" % m.group("date"))
    quote = m.group("quote")
    if strip_punct(quote) in [strip_punct(w) for w in WEAK_APPROVALS] or not strip_punct(quote):
        errs.append("原话「%s」不算批准（要点名是哪份，比如「%s 改 ready」）" % (quote, spec.id))
    elif not spec.named_in(quote):
        errs.append("原话「%s」没点名这份 spec（要有编号 %s、目录名或标题）" % (short(quote, 30), spec.id))
    if not m.group("src").strip():
        errs.append("Approved 行缺出处（对话 / PR #n / 路径）")
    return errs


def chk_approval(ctx, pj):
    sc = pj.scope
    for s in pj.specs.list:
        if s.path not in sc.changes:
            continue
        bt = sc.read_before(s.path)
        bspec = Spec(ctx, s.path, bt) if bt is not None else None
        before_status = bspec.status if bspec else None
        after = s.status
        if after not in ("ready", "implemented") or before_status == after:
            continue
        prev = {}
        if bspec:
            for e in bspec.values("approved"):
                prev[e.value] = prev.get(e.value, 0) + 1
        new = []
        for e in s.values("approved"):
            if prev.get(e.value, 0) > 0:
                prev[e.value] -= 1
            else:
                new.append(e)
        if not new:
            ctx.block("approval", s.path, "Status 改成 %s，但没有同时新增 Approved: 行（日期、逐字原话、出处）" % after)
            continue
        best = None
        for e in new:
            errs = validate_approved(s, e.value, after)
            if not errs:
                best = []
                break
            if best is None or len(errs) < len(best):
                best = errs
        for err in best or []:
            ctx.block("approval", s.path, err)


def sec_compat(a, b):
    if not a or not b:
        return True
    na = re.sub(r"\s+", "", a.lstrip("§")).lower()
    nb = re.sub(r"\s+", "", b.lstrip("§")).lower()
    return na == nb or na.startswith(nb) or nb.startswith(na)


def collect_links(pj):
    """每份 spec 的 Changes / Changed by 条目（已解析引用）。"""
    changes, changed_by = {}, {}
    for s in pj.specs.list:
        for key, store in (("changes", changes), ("changed by", changed_by)):
            for e in s.values(key):
                for ent in split_entries(e.value):
                    d = parse_ref_entry(ent, e.default_kind)
                    d["target"] = pj.specs.resolve(d["ref"], s.path)
                    legacy = " ".join(e.raw_key.lower().split()) in ("amends", "amended by")
                    if legacy and d["target"] is None and not MDLINK_RE.match(d["ref"]):
                        continue  # 老写法里夹着的说明文字，不是引用
                    store.setdefault(s.path, []).append(d)
    return changes, changed_by


def chk_pairs(ctx, pj):
    changes, changed_by = collect_links(pj)
    replace_on = ctx.has_module("replace")
    for s in pj.specs.list:
        for d in changes.get(s.path, []):
            y = d["target"]
            if y is None:
                ctx.block("pairs", s.path, "Changes 指向的 %s 不存在" % short(d["ref"], 30))
                continue
            if d["kind"] == "取代":
                ref = y.superseded_ref
                tgt = pj.specs.resolve(ref, y.path) if ref else None
                if y.status != "superseded" or tgt is None or tgt.path != s.path:
                    ctx.block("pairs", s.path, "写了 Changes: %s（取代），但 %s 的 Status 不是 superseded by %s" % (y.id, y.id, s.id))
                continue
            if d["kind"] == "替换" and not replace_on:
                ctx.block("pairs", s.path, "写了「替换」，但项目没开逐条替换模块（.sdd/config.json 的 modules 里加 replace）")
            ok = False
            for c in changed_by.get(y.path, []):
                if c["target"] is not None and c["target"].path == s.path and sec_compat(c["section"], d["section"]):
                    ok = True
            if not ok:
                sec = "（§%s）" % d["section"] if d["section"] else ""
                ctx.block("pairs", s.path, "Changes: %s 没有对应：%s 的页头缺 Changed by: %s%s" % (y.id, y.id, s.id, sec))
        for c in changed_by.get(s.path, []):
            x = c["target"]
            if x is None:
                ctx.block("pairs", s.path, "Changed by 指向的 %s 不存在" % short(c["ref"], 30))
                continue
            ok = False
            for d in changes.get(x.path, []):
                if d["target"] is not None and d["target"].path == s.path and sec_compat(c["section"], d["section"]):
                    ok = True
            if not ok:
                ctx.block("pairs", s.path, "Changed by: %s 没有对应：%s 的页头缺 Changes: %s" % (x.id, x.id, s.id))
        if s.status == "superseded":
            x = pj.specs.resolve(s.superseded_ref, s.path)
            if x is not None:
                ok = any(d["target"] is not None and d["target"].path == s.path and d["kind"] == "取代"
                         for d in changes.get(x.path, []))
                if not ok:
                    ctx.block("pairs", s.path, "Status: superseded by %s，但 %s 的页头缺 Changes: %s（取代）" % (x.id, x.id, s.id))


def split_header_body(lines):
    for i, l in enumerate(lines):
        if l.startswith("## "):
            return lines[:i], lines[i:]
    return lines, []


def canon_of_line(line, aliases):
    m = HEADER_LINE_RE.match(line)
    if not m:
        return None
    key = " ".join(m.group(1).lower().split())
    return aliases.get(key, BASE_KEYS.get(key, (None, None)))[0]


def chk_frozen(ctx, pj):
    sc = pj.scope
    aliases = header_alias_map(ctx.cfg)
    for path, fc in sc.changes.items():
        if not path.endswith("spec.md") or fc.status == "A":
            continue
        bt = sc.read_before(path)
        if bt is None or Spec(ctx, fc.old, bt).status != "implemented":
            continue
        if fc.status == "D":
            ctx.block("frozen", fc.old, "implemented 的 spec 被删除了；要改就新写一份 spec")
            continue
        at = sc.read_after(path)
        if at is None:
            continue
        bl = [l.rstrip() for l in split_lines(bt)]
        al = [l.rstrip() for l in split_lines(at)]
        bh, bb = split_header_body(bl)
        ah, ab = split_header_body(al)
        if bb != ab:
            added, removed = diff_texts("\n".join(bb), "\n".join(ab))
            ctx.block("frozen", path, "implemented 的 spec 正文被改动（加 %d 行、删 %d 行）；要改就新写一份 spec，用 Changes / Changed by 连起来" % (len(added), len(removed)))
            continue
        # 页头：只许新增 Changed by 行，或把 Status 改成 superseded by
        left = {}
        for l in bh:
            left[l] = left.get(l, 0) + 1
        ah2 = []
        for l in ah:
            if left.get(l, 0) > 0:
                left[l] -= 1
                ah2.append(l)
            elif canon_of_line(l, aliases) != "changed by":
                ah2.append(l)
        bh2 = list(bh)
        for i, l in enumerate(ah2):
            if canon_of_line(l, aliases) == "status" and parse_status_value(HEADER_LINE_RE.match(l).group(2))[0] == "superseded":
                ah2[i] = "<STATUS>"
                for j, bl in enumerate(bh2):
                    if canon_of_line(bl, aliases) == "status":
                        bh2[j] = "<STATUS>"
        if ah2 != bh2:
            ctx.block("frozen", path, "implemented 的 spec 页头被改动（只许新增 Changed by 行，或把 Status 改成 superseded by）")


LINE_REF_DOC_RE = re.compile(r"^docs/(architecture|features)/[^/]+/(spec|plan|decisions)\.md$")
TLD_LIKE = set("com org net io dev ai cn app co edu gov info biz me us uk de fr jp ru cc tv xyz".split())


def find_line_refs(line, aliases):
    s = re.sub(r"https?://\S+", " ", line)
    s = re.sub(r"\b[0-9a-fA-F]{7,40}:[^\s:]+:\d+(?:-\d+)?", " ", s)
    hits = []
    for m in re.finditer(r"[\w./-]+\.([A-Za-z][A-Za-z0-9]{0,7}):\d+(?:-\d+)?", s):
        ext = m.group(1).lower()
        if ("." + ext) in CODE_EXTS or ext not in TLD_LIKE:  # 先看是不是代码扩展名（.cc 既是 C++ 又是域名后缀）
            hits.append(m.group(0))
    for m in re.finditer(r"(?<![\w.])\d{2}:\d{3,}", s):
        hits.append(m.group(0))
    for m in re.finditer(r"(?<![\w.])\d{2}:\d+-\d+(?![\d:])", s):
        hits.append(m.group(0))
    for a in aliases:
        for m in re.finditer(r"(?<![\w])%s:\d+" % re.escape(a), s):
            hits.append(m.group(0))
    return hits


def chk_line_refs(ctx, pj):
    sc = pj.scope
    spec_dirs = set(s.dir for s in pj.specs.list)
    aliases = [a for a in (ctx.cfg.get("line_ref_aliases") or []) if isinstance(a, str)]
    for path in sc.paths():
        if sc.status(path) == "D":
            continue
        base = os.path.basename(path)
        is_doc = path == "AGENTS.md" or LINE_REF_DOC_RE.match(path) or (
            base in ("spec.md", "plan.md", "decisions.md") and os.path.dirname(path) in spec_dirs)
        if not is_doc:
            continue
        text = sc.read_after(path)
        if text is None:
            continue
        fenced = fence_lines(split_lines(text))
        for ln, line in sc.added(path):
            if ln in fenced:
                continue
            hits = find_line_refs(line, aliases)
            if hits:
                ctx.block("line-refs", path, "第 %d 行有行号引用「%s」；引用文档写节名，引用代码写路径 + 函数名" % (ln, hits[0]))


def chk_todo_files(ctx, pj):
    allow = [glob_to_re(g) for g in (ctx.cfg.get("todo_allow") or [])]
    for p in sorted(pj.files):
        if os.path.basename(p).lower() in ("tasks.md", "todo.md") and not any(r.match(p) for r in allow):
            ctx.block("todo-files", p, "不建 tasks.md / TODO.md；待办只放 plan.md（要放行就加进 config 的 todo_allow）")


NOTE_MD_RE = re.compile(r"<!--\s*sdd-note\b")
NOTE_HASH_RE = re.compile(r"^\s*#\s*sdd-note\b")
PLACEHOLDER_RE = re.compile(r"\{\{sdd:[^}]*\}\}")


def chk_leftovers(ctx, pj):
    sc = pj.scope
    for path in sc.paths():
        if sc.status(path) == "D" or path.startswith(".sdd/") or path.startswith(".git/"):
            continue
        text = sc.read_after(path)
        if text is None:
            continue
        is_md = path.endswith(".md")
        if is_md:
            fenced = fence_lines(split_lines(text))
        else:
            fenced = set()
        for ln, line in sc.added(path):
            if ln in fenced:
                continue
            probe = line  # 只有围栏代码块可以豁免；行内的反引号里留着占位，也是没填
            m = PLACEHOLDER_RE.search(probe)
            if m:
                ctx.block("leftovers", path, "第 %d 行还有没填的模板占位 %s" % (ln, m.group(0)))
                continue
            if NOTE_MD_RE.search(probe) or (not is_md and NOTE_HASH_RE.match(probe)):
                ctx.block("leftovers", path, "第 %d 行还留着模板的生成说明（sdd-note），产物里要删掉" % ln)


def chk_numbering(ctx, pj):
    if not ctx.has_module("roadmap"):
        return
    seen = {}
    for p in pj.files:
        m = re.match(r"^docs/architecture/(\d{2})-([^/]+)/", p)
        if m:
            seen.setdefault(m.group(1), set()).add(m.group(1) + "-" + m.group(2))
    for num, names in sorted(seen.items()):
        if len(names) > 1:
            ctx.block("numbering", "docs/architecture", "编号 %s 重复：%s" % (num, "、".join(sorted(names))))


# --------------------------------------------------------------------------
# 形状类检查（警）
# --------------------------------------------------------------------------

def strip_comment_lines(lines):
    return [("" if l.strip().startswith("<!--") else l) for l in lines]


def code_re(ctx):
    return re.compile(r"(?<![A-Za-z0-9_])(?:%s)\d+(?![A-Za-z0-9_])" % "|".join(re.escape(p) for p in ctx.code_prefixes))


def chk_shape(ctx, pj):
    sc = pj.scope
    extra = set(ctx.cfg.get("plan_extra_headings") or [])
    # AGENTS.md 体量
    if "AGENTS.md" in sc.changes and sc.status("AGENTS.md") != "D":
        text = sc.read_after("AGENTS.md") or ""
        lines = split_lines(text)
        n = len(lines) - (1 if lines and lines[-1] == "" else 0)
        lim = ctx.limit("agents_lines", ctx.proj_tier)
        if lim and n > lim:
            ctx.warn("shape", "AGENTS.md", "共 %d 行，超过 %s 档的上限 %d 行" % (n, ctx.proj_tier, lim))
        blim = ctx.limit("agents_bytes", ctx.proj_tier)
        nb = len(text.encode("utf-8"))
        if blim and nb > blim:
            ctx.warn("shape", "AGENTS.md", "共 %d 字节，超过上限 %d 字节（%d KiB）" % (nb, blim, blim // 1024))
    # overview、运维手册、总参考：超过上限只报警
    for key, dpath, label, hint in (
            ("overview_lines", OVERVIEW_PATH, "overview", "只写现在是什么样；过去为什么这么定放 decisions.md 和各份 spec"),
            ("runbook_lines", RUNBOOK_PATH, "运维手册", "按操作拆开"),
            ("master_lines", MASTER_REF_PATH, "总参考", "只放目标和不做、阶段表、以后再说；其余挪走")):
        if dpath in sc.changes and sc.status(dpath) != "D":
            dlines = split_lines(sc.read_after(dpath) or "")
            dn = len(dlines) - (1 if dlines and dlines[-1] == "" else 0)
            dlim = ctx.limit(key, ctx.proj_tier)
            if dlim and dn > dlim:
                ctx.warn("shape", dpath, "%s 共 %d 行，超过上限 %d 行；%s" % (label, dn, dlim, hint))
    # 每份动过的 spec / plan
    for s in pj.specs.list:
        tier = pj.tier_of(s)
        if s.path in sc.changes:
            lim = ctx.limit("spec_chars", tier)
            if lim and len(s.text) > lim:
                ctx.warn("shape", s.path, "spec 全文 %d 字符，超过 %s 档的上限 %d（超了按子阶段拆）" % (len(s.text), tier, lim))
            if TIER_RANK[tier] >= 1:
                shape_intro(ctx, pj, s)
        ppath = s.dir + "/plan.md"
        if ppath in sc.changes and sc.status(ppath) != "D":
            ptext = sc.read_after(ppath) or ""
            lim = ctx.limit("plan_chars", tier)
            if lim and len(ptext) > lim:
                ctx.warn("shape", ppath, "plan 全文 %d 字符，超过 %s 档的上限 %d；过程记录请挪进 log.md" % (len(ptext), tier, lim))
    # plan 里的大段记录（规定以外的 ## 标题、多个交接）
    for path in sc.paths():
        if os.path.basename(path) != "plan.md" or sc.status(path) == "D":
            continue
        text = sc.read_after(path)
        if text is None:
            continue
        plan = Plan(text)
        added_lines = set(ln for ln, _ in sc.added(path))
        allowed = PLAN_HEADINGS + list(extra)
        for idx, h in plan.headings:
            if (idx + 1) in added_lines and not any(heading_matches(a, h) for a in allowed):
                ctx.warn("shape", path, "出现 plan 规定以外的「## %s」；这类记录建议挪进 log.md，确实要保留就登记 plan_extra_headings" % short(h, 24))
        handoffs = [1 for _, h in plan.headings if heading_matches("交接", h)]
        if len(handoffs) > 1 and any((i + 1) in added_lines for i, h in plan.headings if heading_matches("交接", h)):
            ctx.warn("shape", path, "有 %d 个「## 交接」，只留最新一条" % len(handoffs))
    # log.md 只许追加
    for path in sc.paths():
        if os.path.basename(path) == "log.md" and sc.status(path) in ("M", "R"):
            rm = sc.removed(path)
            if rm:
                ctx.warn("shape", path, "log.md 只许往后追加，这次删掉或改掉了 %d 行" % len(rm))
    # 长行
    limit = ctx.limit("line_chars", ctx.proj_tier)
    for path in sc.paths():
        if not path.endswith(".md") or sc.status(path) == "D":
            continue
        if os.path.basename(path) == "log.md" or "/research/" in "/" + path:
            continue
        text = sc.read_after(path)
        if text is None:
            continue
        fenced = fence_lines(split_lines(text))
        longs = [ln for ln, l in sc.added(path) if ln not in fenced and not l.lstrip().startswith("|") and len(l) > limit]
        if longs:
            ctx.warn("shape", path, "有 %d 个新增行超过 %d 字符（第 %s 行）；一段一件事，拆开写" %
                     (len(longs), limit, "、".join(str(n) for n in longs[:5])))


def shape_intro(ctx, pj, s):
    lines = s.lines
    fenced = fence_lines(lines)
    first = None
    for i, l in enumerate(lines):
        if (i + 1) in fenced:
            continue
        h = heading_of(l)
        if h and h[0] == 2:
            first = (i, h[1])
            break
    if first is None:
        return
    if not heading_matches("给你看的一页", first[1]):
        ctx.warn("shape", s.path, "第一节应该是「给你看的一页」，现在是「%s」" % short(first[1], 20))
        return
    end = len(lines)
    for j in range(first[0] + 1, len(lines)):
        h = heading_of(lines[j])
        if h and h[0] <= 2 and (j + 1) not in fenced:
            end = j
            break
    span = lines[first[0] + 1:end]
    lim = ctx.limit("intro_lines", pj.tier_of(s))
    if len(span) > lim:
        ctx.warn("shape", s.path, "「给你看的一页」有 %d 行，超过 %d 行" % (len(span), lim))
    cre = code_re(ctx)
    for l in strip_comment_lines(span):
        if l.lstrip().startswith("要你定的"):
            continue
        m = cre.search(l)
        if m:
            ctx.warn("shape", s.path, "「给你看的一页」里出现代号 %s；这一页全用平常话写" % m.group(0))
            break
    acc, found = parse_acceptance(lines)
    nums = set(n for n, _ in acc)
    for l in strip_comment_lines(span):
        for m in re.finditer(r"验收\s*(\d+(?:\s*[、,，]\s*\d+)*)", l):
            for n in re.findall(r"\d+", m.group(1)):
                if int(n) not in nums:
                    ctx.warn("shape", s.path, "「给你看的一页」引的验收 %s 在「验收标准」里不存在" % n)


def chk_codes(ctx, pj):
    sc = pj.scope
    defined = set()
    cre = code_re(ctx)
    sources = []
    for s in pj.specs.list:
        sources += [s.dir + "/" + fn for fn in ("decisions.md", "evidence.md", "log.md")]
    # 项目级的拍板（R1、R2…）：docs/decisions.md；已经有 docs/adr 的项目，那里也是登记处
    adr = glob_to_re(ADR_GLOB)
    sources += [PROJECT_DECISIONS_PATH] + sorted(f for f in pj.files if adr.match(f))
    for p in sources:
        if p not in pj.files:
            continue
        text = sc.read_state(p)
        if not text:
            continue
        lines = split_lines(text)
        fenced = fence_lines(lines)
        for i, l in enumerate(lines):
            if (i + 1) not in fenced and heading_of(l):
                defined.update(m.group(0) for m in cre.finditer(l))
    for s in pj.specs.list:
        tier = pj.tier_of(s)
        if not ((s.dir + "/decisions.md") in pj.files or TIER_RANK[tier] >= 1):
            continue
        for fn in ("spec.md", "plan.md"):
            p = s.dir + "/" + fn
            if p not in sc.changes or sc.status(p) == "D":
                continue
            text = sc.read_after(p)
            if text is None:
                continue
            fenced = fence_lines(split_lines(text))
            missing = []
            for ln, l in sc.added(p):
                if ln in fenced or l.strip().startswith("<!--"):
                    continue
                for m in cre.finditer(l):
                    if m.group(0) not in defined and m.group(0) not in missing:
                        missing.append(m.group(0))
            if missing:
                ctx.warn("codes", p, "用到的代号 %s 在本仓库没有定义（决策卡 / 证据 / 突变的标题里找不到）；正文先写规则本身" % "、".join(missing[:6]))


# --------------------------------------------------------------------------
# 入口页（index）
# --------------------------------------------------------------------------

INDEX_PATH = "docs/README.md"
INDEX_HEAD = "由 spec-check --index 生成，勿手改"


def spec_what(s):
    fenced = fence_lines(s.lines)
    for i, l in enumerate(s.lines):
        if (i + 1) in fenced:
            continue
        m = re.match(r"^\s*(?:[-*]\s*)?做什么[:：]\s*(.+)$", l)
        if m:
            return m.group(1).strip()
    return s.title or s.name


def approval_date(s):
    best = None
    for e in s.values("approved"):
        m = APPROVED_RE.match(e.value)
        if m and re.match(r"^\d{4}-\d{2}-\d{2}$", m.group("date")):
            if best is None or m.group("date") < best:
                best = m.group("date")
    return best or "9999-99-99"


def impl_locations(s, start, end):
    out = []
    for l in s.lines[start:end]:
        m = re.match(r"^\s*实现位置[:：]\s*`?([^`\s→]+)`?\s*→\s*`?(.+?)`?\s*$", l)
        if m:
            out.append((m.group(1), m.group(2)))
    return out


def build_index(ctx, pj):
    """返回 (入口页全文, [(文件, 警告)])。"""
    warns = []
    rows = []
    for s in pj.specs.list:
        plan_text = pj.scope.read_state(s.dir + "/plan.md") if (s.dir + "/plan.md") in pj.files else None
        need = Plan(plan_text).field("需要你") if plan_text else None
        rel = os.path.relpath(s.path, "docs").replace(os.sep, "/")
        rows.append("- [%s](%s) · %s · %s · 需要你：%s" % (s.id, rel, s.status_raw or "（无 Status）",
                                                       short(spec_what(s), 80), short(need, 60) if need else "—"))
    order = dict((s.path, i) for i, s in enumerate(pj.specs.list))
    changes, _ = collect_links(pj)
    groups = {}
    keys = []
    for x in pj.specs.list:
        for d in changes.get(x.path, []):
            y = d["target"]
            if y is None:
                continue
            sec = "整份" if d["kind"] == "取代" else (d["section"] or "整份")
            k = (y.path, sec)
            if k not in groups:
                groups[k] = []
                keys.append(k)
            groups[k].append(x)
    first_seen = dict((k, i) for i, k in enumerate(keys))
    keys.sort(key=lambda k: (order[k[0]], first_seen[k]))
    out = [INDEX_HEAD, "", "# 入口页", "", "## 规格一览", ""] + rows + ["", "## 被改过的节", ""]
    if not keys:
        out.append("（没有）")
    for k in keys:
        y = pj.specs.by_path[k[0]]
        xs = sorted(groups[k], key=lambda x: (approval_date(x), order[x.path]))
        label = "%s §%s" % (y.id, k[1]) if k[1] != "整份" else "%s（整份）" % y.id
        out.append("- " + label + "".join(" ← " + x.id for x in xs))
        if k[1] != "整份":
            span = y.section_span(k[1])
            if span is None:
                warns.append((xs[0].path, "Changes 指的节「%s」在 %s 里不存在" % (k[1], y.id)))
            else:
                for path, name in impl_locations(y, span[0], span[1]):
                    out.append("  实现位置：%s → %s" % (path, name))
                    ftext = pj.scope.read_state(path) if path in pj.files else None
                    if ftext is None:
                        warns.append((y.path, "实现位置的文件 %s 不存在" % path))
                    elif name not in ftext:
                        warns.append((y.path, "实现位置：%s 里找不到「%s」" % (path, name)))
    return "\n".join(out) + "\n", warns


def chk_index(ctx, pj):
    if not ctx.has_module("index"):
        return
    text, warns = build_index(ctx, pj)
    for f, msg in warns:
        ctx.warn("index", f, msg)
    cur = pj.scope.read_state(INDEX_PATH) if INDEX_PATH in pj.files else None
    if cur is None:
        ctx.warn("index", INDEX_PATH, "入口页不存在，跑 python3 .sdd/spec-check.py --index 生成")
    elif [l.rstrip() for l in split_lines(cur)] != [l.rstrip() for l in split_lines(text)]:
        ctx.warn("index", INDEX_PATH, "入口页过期，跑 python3 .sdd/spec-check.py --index 重新生成")


# --------------------------------------------------------------------------
# 私有笔记、交接、耗时
# --------------------------------------------------------------------------

def chk_notes(ctx, pj):
    if not ctx.has_module("notes"):
        return
    conf = ctx.module_conf("notes")
    sc = pj.scope
    dirs = set()
    default = "../%s-notes" % os.path.basename(os.path.abspath(ctx.root))
    dirs.add(conf.get("path") or default)
    md_files = [p for p in pj.files if p.endswith(".md")]
    scan = md_files if sc.mode != "staged" else [p for p in sc.changes if p.endswith(".md") and sc.status(p) != "D"]
    words = [w for w in (conf.get("sensitive") or []) if isinstance(w, str) and w]
    for p in md_files:
        if sc.mode == "staged" and p not in sc.changes:
            continue
        t = sc.read_state(p)
        if t:
            for m in re.finditer(r"\.\./[A-Za-z0-9._-]+-notes/?", t):
                dirs.add(m.group(0).rstrip("/"))
    for d in sorted(dirs):
        full = os.path.normpath(os.path.join(ctx.root, d))
        if not os.path.isdir(full):
            continue
        if not os.path.exists(os.path.join(full, ".git")):
            ctx.warn("notes", d, "笔记目录不是 git 仓库（笔记没有历史记录）；在那里 git init")
    for p in scan:
        t = sc.read_state(p)
        if not t:
            continue
        low = t.lower()
        for w in words:
            if w.lower() in low:
                ctx.warn("notes", p, "公开文档里出现了敏感词「%s」；商业内容放私有笔记仓库" % w)
                break


def handoff_messages(ctx, pj):
    sc = pj.scope
    nonmd = [p for p in sc.changes if not p.endswith(".md") and not p.startswith(".sdd/local/")]
    if not nonmd:
        return []
    has_plan = any(p.endswith("/plan.md") for p in pj.files)
    plan_touched = any(os.path.basename(p) == "plan.md" for p in sc.changes)
    if has_plan and not plan_touched:
        return ["有 %d 个 .md 以外的文件改动（如 %s），但 plan.md 没动；停下前请重写 plan 的「当前」和「交接」" % (len(nonmd), nonmd[0])]
    return []


def chk_handoff(ctx, pj):
    for m in handoff_messages(ctx, pj):
        ctx.warn("handoff", "plan.md", m)


TIMING_FILE = ".sdd/local/timing.jsonl"


def read_timing(ctx):
    path = os.path.join(ctx.root, TIMING_FILE)
    rows = []
    text = read_file(path) if os.path.exists(path) else None
    for l in (text or "").splitlines():
        try:
            r = json.loads(l)
            if isinstance(r, dict):
                rows.append(r)
        except ValueError:
            pass
    return rows


def append_timing(ctx, gate, seconds, code, scenario, tree=None, failed=None):
    try:
        os.makedirs(ctx.local_dir(), exist_ok=True)
        row = {"ts": datetime.datetime.now().replace(microsecond=0).isoformat(), "gate": gate,
               "seconds": round(seconds, 2), "exit": code, "scenario": scenario, "tree": tree or "",
               "failed": failed or []}
        with open(os.path.join(ctx.root, TIMING_FILE), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
    except OSError:
        pass


def commit_limit(ctx):
    lim = ctx.cfg.get("commit_time_limit_s")
    if isinstance(lim, (int, float)) and lim > 0:
        return float(lim)
    meas = ctx.cfg.get("measured") or {}
    secs = meas.get("seconds") if isinstance(meas, dict) else None
    total = 0.0
    if isinstance(secs, dict):
        gates = ctx.cfg.get("commit_gates") or [g for g in secs if g != "test"]
        total = sum(float(secs.get(g) or 0) for g in gates)
    return max(float(COMMIT_BUDGET_S), total * 1.5)


def gh_ci_state(ctx):
    """HEAD 的 CI 是否通过：True / False / None（查不到）。"""
    if ctx.env.get("SDD_NO_GH") or not shutil.which("gh"):
        return None
    sha = ctx.git.rev("HEAD")
    if not sha:
        return None
    try:
        p = subprocess.run(["gh", "run", "list", "--commit", sha, "--json", "conclusion,status", "--limit", "20"],
                           cwd=ctx.root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
        runs = json.loads(p.stdout.decode("utf-8", errors="replace") or "[]")
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if not runs:
        return None
    done = [r for r in runs if r.get("status") == "completed"]
    if not done:
        return None
    return all(r.get("conclusion") == "success" for r in done)


def timing_state(ctx):
    """返回 [(说明)]；任何一条出现，都建议重新实测。"""
    rows = read_timing(ctx)
    msgs = []
    limit = commit_limit(ctx)
    # 情况 ①：最近 3 次提交，每次加总都超过上限
    per_tree = []
    for r in rows:
        if r.get("scenario") != "pre-commit" or not r.get("tree"):
            continue
        if per_tree and per_tree[-1][0] == r["tree"]:
            per_tree[-1][1] += float(r.get("seconds") or 0)
        else:
            seen = [t for t in per_tree if t[0] == r["tree"]]
            if seen:
                seen[0][1] += float(r.get("seconds") or 0)
            else:
                per_tree.append([r["tree"], float(r.get("seconds") or 0)])
    last3 = per_tree[-3:]
    if len(last3) == 3 and all(t[1] > limit for t in last3):
        msgs.append("最近 3 次提交的检查加总都超过 %d 秒（%s 秒）；建议重新实测（--measure）" %
                    (limit, "、".join("%.0f" % t[1] for t in last3)))
    # 情况 ②：同一条用例 / 门禁在本机最近 3 次都失败
    by_gate = {}
    for r in rows:
        if r.get("gate") and r["gate"] != "staged":
            by_gate.setdefault(r["gate"], []).append(r)
    for gate, rs in sorted(by_gate.items()):
        last = rs[-3:]
        if len(last) == 3 and all(int(r.get("exit") or 0) != 0 for r in last):
            names = None
            sets = [set(r.get("failed") or []) for r in last]
            if all(sets):
                common = set.intersection(*sets)
                if common:
                    names = sorted(common)
            what = "用例「%s」" % short(names[0], 50) if names else "门禁 %s" % gate
            ci = gh_ci_state(ctx)
            if ci is True:
                msgs.append("%s在本机最近 3 次都失败，而 HEAD 的 CI 通过了；建议重新实测（--measure）" % what)
            elif ci is None:
                msgs.append("%s在本机最近 3 次都失败（没有 gh，查不到 CI）；请对照这次 PR 的 CI 结果确认" % what)
    return msgs


def chk_timing(ctx, pj):
    for m in timing_state(ctx):
        ctx.warn("timing", TIMING_FILE, m)


# --------------------------------------------------------------------------
# 测试结果报告：vitest / Playwright / pytest-json-report 统一成「用例全名 → 状态」
# --------------------------------------------------------------------------

class Case(object):
    def __init__(self, name, file, status, message="", level="case", title=None):
        self.name, self.file, self.status, self.message, self.level = name, file, status, message, level
        self.title = title if title is not None else name
        self.report = ""  # 这条用例来自哪份报告（配置里的相对路径）


def _vitest_status(s):
    return "passed" if s == "passed" else ("failed" if s == "failed" else "skipped")


def parse_report_data(data):
    cases = []
    if not isinstance(data, dict):
        raise ValueError("报告顶层不是对象")
    if "testResults" in data:  # vitest / jest
        for tr in data.get("testResults") or []:
            f = tr.get("name") or ""
            ars = tr.get("assertionResults") or []
            if not ars and tr.get("status") == "failed":
                cases.append(Case(f, f, "failed", tr.get("message") or "", "file"))
            for a in ars:
                nm = a.get("fullName") or " ".join((a.get("ancestorTitles") or []) + [a.get("title") or ""])
                cases.append(Case(nm, f, _vitest_status(a.get("status")), "\n".join(a.get("failureMessages") or []),
                                  title=a.get("title") or nm))
        return cases
    if "suites" in data and ("stats" in data or "config" in data):  # Playwright
        for err in data.get("errors") or []:
            cases.append(Case("(加载出错)", "", "failed", err.get("message") or "", "file"))

        def walk(suite, trail, top):
            for sp in suite.get("specs") or []:
                sts = []
                msg = ""
                for t in sp.get("tests") or []:
                    res = t.get("results") or []
                    st = res[-1].get("status") if res else t.get("status")
                    if t.get("status") == "skipped" or st == "skipped":
                        sts.append("skipped")
                    elif st == "passed":
                        sts.append("passed")
                    else:
                        sts.append("failed")
                        if res and res[-1].get("error"):
                            msg = res[-1]["error"].get("message") or ""
                status = "failed" if "failed" in sts else ("passed" if "passed" in sts else "skipped")
                cases.append(Case(" ".join(trail + [sp.get("title") or ""]), sp.get("file") or top, status, msg,
                                  title=sp.get("title") or ""))
            for sub in suite.get("suites") or []:
                walk(sub, trail + [sub.get("title") or ""], top)
        for s in data.get("suites") or []:
            walk(s, [], s.get("file") or s.get("title") or "")
        return cases
    if isinstance(data.get("tests"), list):  # pytest-json-report
        for c in data.get("collectors") or []:
            if c.get("outcome") == "failed":
                cases.append(Case(c.get("nodeid") or "", c.get("nodeid") or "", "failed", str(c.get("longrepr") or ""), "file"))
        for t in data["tests"]:
            node = t.get("nodeid") or ""
            oc = t.get("outcome")
            st = "passed" if oc in ("passed", "xpassed") else ("skipped" if oc in ("skipped", "xfailed") else "failed")
            msg = ""
            for ph in ("call", "setup", "teardown"):
                if isinstance(t.get(ph), dict) and t[ph].get("longrepr"):
                    msg = str(t[ph]["longrepr"])
                    break
            cases.append(Case(node, node.split("::")[0], st, msg, title=node.split("::")[-1]))
        return cases
    raise ValueError("认不出这是 vitest / Playwright / pytest-json-report 的哪种报告")


def load_reports(ctx, root=None):
    """读 config 的 test_reports。返回 (用例列表(同名取最后一次), 配了几个, 读到几个, [(报告路径, 问题说明)])。"""
    root = root or ctx.root
    conf = ctx.cfg.get("test_reports") or {}
    paths = list(conf.values()) if isinstance(conf, dict) else list(conf)
    paths = [p for p in paths if isinstance(p, str) and p]
    cases, problems, loaded = {}, [], 0
    for rel in paths:
        full = os.path.join(root, rel)
        if not os.path.exists(full):
            problems.append((rel, "配置的测试报告在 %s 找不到（.sdd/config.json 的 test_reports）" % rel))
            continue
        text = read_file(full)
        if text is None:
            problems.append((rel, "配置的测试报告 %s 读不了或读不懂：打不开、太大或不是文本" % rel))
            continue
        try:
            for c in parse_report_data(json.loads(text)):
                c.report = rel
                cases[(c.file, c.name)] = c
            loaded += 1
        except ValueError as e:
            problems.append((rel, "配置的测试报告 %s 读不了或读不懂：%s" % (rel, e)))
    return list(cases.values()), len(paths), loaded, problems


# --------------------------------------------------------------------------
# trace：验收和测试一一对应
# --------------------------------------------------------------------------

def name_regex(spec):
    names = [spec.id, spec.name] + ([spec.num] if spec.num else [])
    names = sorted(set(names), key=len, reverse=True)
    alts = ["[-_]".join(re.escape(p) for p in re.split(r"[-_]", n)) for n in names]
    return re.compile(r"(?<![0-9A-Za-z])(?:%s)[ _]验收[ _]?(\d+(?:\s*、\s*\d+)*)" % "|".join(alts))


def case_numbers(rx, case):
    """用例点名的验收号：先看它自己的标题；标题里没有，才看带上外层 describe 的全名。"""
    own = named_numbers(rx, case.title)
    return own or named_numbers(rx, case.name)


def named_numbers(rx, text):
    out = set()
    for m in rx.finditer(text or ""):
        for n in re.findall(r"\d+", m.group(1)):
            out.add(int(n))
    return out


JS_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte")
JS_TITLE_RE = re.compile(
    r"""\b(?:it|test|describe|suite|specify|fit|xit|fdescribe|xdescribe)"""
    r"""(?:\s*\.\s*\w+(?:\s*\((?:[^()]|\([^()]*\))*\))?)*"""
    r"""\s*\(\s*(?P<q>['"`])(?P<t>(?:\\.|(?!(?P=q))[^\\])*)(?P=q)""")


def strip_js_comments(text):
    """去掉 // 和 /* */ 注释（字符串里的不动），换行保留。"""
    out, i, n, q = [], 0, len(text), None
    while i < n:
        c = text[i]
        if q:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == q or (c == "\n" and q != "`"):
                q = None
            i += 1
            continue
        if c in "'\"`":
            q = c
            out.append(c)
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            if j == -1:
                break
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j == -1:
                break
            out.append("\n" * text.count("\n", i, j))
            i = j + 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


C_STYLE_EXTS = (".go", ".rs", ".java", ".kt", ".swift", ".cs", ".c", ".cc", ".cpp", ".h", ".hpp", ".php")
GO_RUN_RE = re.compile(r'''\bt\.Run\(\s*(?:"(?P<t>(?:\\.|[^"\\])*)"|`(?P<r>[^`]*)`)''')
GO_FUNC_RE = re.compile(r"\bfunc\s+(?:\([^)]*\)\s*)?(Test\w*)")
RUST_TEST_RE = re.compile(r"#\[(?:[\w:]*::)?test(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)")
DISPLAY_NAME_RE = re.compile(r'''DisplayName\s*[(=]\s*"(?P<t>(?:\\.|[^"\\])*)"''')
SWIFT_TEST_RE = re.compile(r'''@(?:Test|Suite)\s*\(\s*"(?P<t>(?:\\.|[^"\\])*)"''')
KOTLIN_TICK_RE = re.compile(r"\bfun\s+`([^`\n]+)`")
FUNC_NAME_RE = re.compile(r"\b(?:def|fn|func|function|void|fun)\s+(\w+)|\bTask\s+(\w+)\s*\(")
RSPEC_RE = re.compile(r"""^\s*(?:RSpec\.)?(?:it|describe|context|specify|example|scenario|feature)\s*\(?\s*(?P<q>['"])(?P<t>.*?)(?P=q)""", re.M)


def test_titles(path, text):
    """测试源码里的「用例名」。注释里的、普通字符串里的、生产代码里写的「05 验收 2」都不算点名。
    JS/TS：it / test / describe 的标题字符串。Python：test 函数名和 Test 类名。
    Go：t.Run("…") 的标题和 func Test…。Rust：#[test] 后面的 fn。Java / Kotlin / C# / Swift：@DisplayName("…")、
    DisplayName = "…"、@Test("…")、反引号函数名和函数名。Ruby：it "…"、describe "…"。其他语言：函数名。"""
    low = path.lower()
    if low.endswith(JS_EXTS):
        return [m.group("t") for m in JS_TITLE_RE.finditer(strip_js_comments(text))]
    if low.endswith(".py"):
        return re.findall(r"^\s*(?:async\s+)?def\s+(test\w*)", text, re.M) + re.findall(r"^\s*class\s+(Test\w*)", text, re.M)
    if low.endswith(".rb"):
        return [m.group("t") for m in RSPEC_RE.finditer(text)]  # 行首锚定，# 开头的注释行自然匹配不上
    if low.endswith(C_STYLE_EXTS):
        body = strip_js_comments(text)
        names = []
        if low.endswith(".go"):
            names += [m.group("t") if m.group("t") is not None else m.group("r") for m in GO_RUN_RE.finditer(body)]
            names += GO_FUNC_RE.findall(body)
            return names
        if low.endswith(".rs"):
            return RUST_TEST_RE.findall(body)
        names += [m.group("t") for m in DISPLAY_NAME_RE.finditer(body)]
        names += [m.group("t") for m in SWIFT_TEST_RE.finditer(body)]
        names += KOTLIN_TICK_RE.findall(body)
        for m in FUNC_NAME_RE.finditer(body):
            names.append(m.group(1) or m.group(2))
        return names
    names = []
    for line in text.splitlines():
        if line.lstrip().startswith(("//", "#", "*", "/*")):
            continue
        names += re.findall(r"\b(?:def|fn|func|function|void)\s+(\w+)", line)
    return names


def test_sources(ctx, pj, only_changed=False):
    """[(路径, [用例名])]：测试文件里点名用的标题。"""
    sc = pj.scope
    paths = [p for p in (sc.changes if only_changed else pj.files)
             if ctx.is_test_file(p) and p.endswith(CODE_EXTS) and sc.status(p) != "D"]
    res = []
    for p in sorted(paths):
        t = sc.read_state(p)
        if t and "验收" in t:
            titles = test_titles(p, t)
            if titles:
                res.append((p, titles))
    return res


def case_file(ctx, pj, case, default):
    """报告里用例的文件路径 → 仓库相对路径。绝对路径在仓库里的直接转相对；
    别处（比如 CI 机器）生成的报告，按后缀在仓库的文件里找同名的；都对不上，退回报告本身的路径。"""
    p = (case.file or "").replace("\\", "/")
    fallback = ctx.rel_file(case.report) if case.report else default
    if not p:
        return fallback
    root = os.path.realpath(ctx.root)
    if os.path.isabs(p):
        rp = os.path.realpath(p)
        if rp == root or rp.startswith(root + os.sep):
            return os.path.relpath(rp, root).replace(os.sep, "/")
    else:
        p = os.path.normpath(p).replace(os.sep, "/")
        if p in pj.files:
            return p
    best = None
    for f in pj.files:
        if p == f or p.endswith("/" + f) or f.endswith("/" + p.lstrip("/")):
            if best is None or len(f) > len(best):
                best = f
    return best or fallback


def trace_specs(ctx, pj):
    sc = pj.scope
    base = pj.specs.list if sc.mode == "all" else pj.owners
    return [s for s in base if TIER_RANK[pj.tier_of(s)] >= 1]


def chk_trace_staged(ctx, pj):
    specs = [s for s in pj.specs.list if TIER_RANK[pj.tier_of(s)] >= 1]
    for path, titles in test_sources(ctx, pj, only_changed=True):
        for s in specs:
            acc, _ = parse_acceptance(s.lines)
            nums = set(n for n, _ in acc)
            rx = name_regex(s)
            named = set()
            for t in titles:
                named |= named_numbers(rx, t)
            for n in sorted(named):
                if n not in nums:
                    ctx.block("trace", path, "用例点名了 %s 验收 %d，但 %s 的验收标准里没有这个编号" % (s.id, n, s.id))


def chk_trace(ctx, pj):
    sc = pj.scope
    if sc.mode == "staged":
        chk_trace_staged(ctx, pj)
        return
    specs = trace_specs(ctx, pj)
    if not specs:
        return
    cases, nconf, nloaded, problems = load_reports(ctx)
    for rel, msg in problems:
        ctx.warn("trace", rel, msg)
    sources = test_sources(ctx, pj)
    configured = nconf > 0
    warned_noreport = False
    for s in specs:
        rx = name_regex(s)
        acc, found = parse_acceptance(s.lines)
        nums = set(n for n, _ in acc)
        named = {}  # 验收号 → 源码里点名它的测试文件（只认用例标题）
        for path, titles in sources:
            for t in titles:
                for n in named_numbers(rx, t):
                    named.setdefault(n, path)
        hits = {}  # 验收号 → 报告里点名它的用例
        for c in cases:
            for n in case_numbers(rx, c):
                hits.setdefault(n, []).append(c)
        if not found or not acc:
            if s.status in ("ready", "implemented"):
                ctx.warn("trace", s.path, "没找到「## 验收标准」下的编号条目，trace 没法对照")
            continue
        for n in sorted(set(named) | set(hits)):
            if n not in nums:
                where = named.get(n) or (case_file(ctx, pj, hits[n][0], s.path) if n in hits else s.path)
                ctx.add("trace", where, "用例点名了 %s 验收 %d，但 %s 的验收标准里没有这个编号" % (s.id, n, s.id), tier=pj.tier_of(s))
        before_status = None
        if sc.mode == "range" and s.path in sc.changes:
            bt = sc.read_before(s.path)
            before_status = Spec(ctx, s.path, bt).status if bt is not None else None
        # 「改成 implemented」那一次才拦得更严；push 事件（不经 PR）没有这个动作
        transition = (not ctx.is_push) and sc.mode == "range" and s.path in sc.changes \
            and s.status == "implemented" and before_status != "implemented"
        tags = dict((n, acceptance_tag(text)) for n, text in acc)
        unnamed, nopass = [], []
        for n, _text in acc:
            if tags[n] in ("manual", "live"):
                continue  # （人工）（live）的条目不要求在 CI 里真跑
            if n not in named and n not in hits:
                unnamed.append(n)
                continue
            h = hits.get(n, [])
            passed = [c for c in h if c.status == "passed"]
            skipped = [c for c in h if c.status == "skipped"]
            if passed:
                if skipped:
                    # 至少一条通过了，另有几条被跳过：只警，列出被跳过的
                    ctx.warn("trace", case_file(ctx, pj, skipped[0], s.path), "%s 验收 %d 有 %d 条点名的用例被跳过（另有 %d 条通过了）：%s" %
                             (s.id, n, len(skipped), len(passed), "、".join(short(c.name, 40) for c in skipped[:3])))
            elif skipped and tags[n] == "platform" and len(skipped) == len(h):
                # （平台）验收：只能在某些平台上跑，点名的用例在别的平台的 CI 上全被跳过是正常的，只警；由 owner 或在那个平台上的会话确认。
                # 有的失败了（其余被跳过）就不在这里：和没标（平台）的失败一样，改成 implemented 的那次按 3a 拦
                ctx.warn("trace", case_file(ctx, pj, skipped[0], s.path), "%s 验收 %d 是（平台）验收，点名的用例在这里都被跳过了：%s；请 owner 或在那个平台上的会话确认" %
                         (s.id, n, "、".join(short(c.name, 40) for c in skipped[:3])))
            elif skipped and tags[n] != "platform":
                # 报告里出现了、一条都没通过，且至少一条被跳过：拦（任何时候）
                ctx.add("trace", case_file(ctx, pj, skipped[0], s.path), "%s 验收 %d 点名的用例没有一条通过，都被跳过了：%s" %
                        (s.id, n, "、".join(short(c.name, 40) for c in skipped[:3])), tier=pj.tier_of(s))
            elif configured:
                # 配了测试报告，既没有通过的、也没有被跳过的点名用例：要么缺席（报告里一条都没有），要么全是失败的。
                # 改成 implemented 的那一次拦；平时，缺席只警，全是失败的归测试 job 去拦，这里不重复报
                if transition:
                    nopass.append(n)
                elif nloaded > 0 and n not in hits:
                    ctx.warn("trace", named[n], "%s 验收 %d 有用例点名，但测试报告里找不到它（没跑？）" % (s.id, n))
        if unnamed:
            ctx.add("trace", s.path, "%s 验收 %s 没有用例点名，也没标（人工）/（live）%s" %
                    (s.id, "、".join(str(n) for n in unnamed), "；改成 implemented 前必须补上" if transition else ""),
                    level=BLOCK if transition else WARN)
        if nopass:
            ctx.add("trace", s.path, "%s 验收 %s 有用例点名，但测试报告里没有一条通过的用例（没跑、没出现在报告里或失败了）；"
                    "改成 implemented 前，每条验收都要有通过的用例" % (s.id, "、".join(str(n) for n in nopass)), level=BLOCK)
        if not configured and named and not warned_noreport:
            warned_noreport = True
            ctx.warn("trace", ".sdd/config.json", "没配 test_reports（测试结果报告），「点名的用例有没有真跑」只能报警")


# --------------------------------------------------------------------------
# tamper：定下的测试被削弱
# --------------------------------------------------------------------------

def tamper_reasons(ctx, pj):
    """log.md 新增行 + 范围内提交说明里的「测试改动：文件 · …」。返回 [(文件路径, 整行)]"""
    sc = pj.scope
    res = []
    pat = re.compile(r"测试改动[:：]\s*`?([^·`\n]+?)`?\s*·\s*(.*)$")
    for path in sc.paths():
        if os.path.basename(path) == "log.md":
            for _, l in sc.added(path):
                m = pat.search(l)
                if m:
                    res.append((m.group(1).strip(), l.strip()))
    if sc.base:
        msgs = ctx.git.out("log", "--format=%B%x00", "%s..HEAD" % sc.base) or ""
        for l in msgs.splitlines():
            m = pat.search(l)
            if m:
                res.append((m.group(1).strip(), l.strip()))
    return res


def same_file(a, b):
    a = a.strip().lstrip("./")
    b = b.strip().lstrip("./")
    return a == b or a.endswith("/" + b) or b.endswith("/" + a)


def package_test_scripts(text):
    try:
        d = json.loads(text or "{}")
    except ValueError:
        return {}
    sc = d.get("scripts") if isinstance(d, dict) else None
    return dict((k, v) for k, v in (sc or {}).items() if k.startswith("test")) if isinstance(sc, dict) else {}


def section_map(text):
    """行号（1 起）→ 所在的 [段落名]（toml / ini 用）。"""
    cur, out = None, {}
    for i, line in enumerate(split_lines(text or ""), 1):
        m = re.match(r"^\s*\[+([^\]]+)\]+", line)
        if m:
            cur = m.group(1).strip()
        out[i] = cur
    return out


def cfg_changed_lines(base, before, after, added, removed):
    """运行配置里算数的改动行。pyproject.toml / setup.cfg 只看 pytest 的段落，其余文件整个都算。"""
    lines = []
    if base in ("pyproject.toml", "setup.cfg"):
        bsec, asec = section_map(before), section_map(after)
        lines += [t for ln, t in added if "pytest" in (asec.get(ln) or "").lower()]
        lines += [t for ln, t in removed if "pytest" in (bsec.get(ln) or "").lower()]
    else:
        lines += [t for _, t in added] + [t for _, t in removed]
    return [t for t in lines if t.strip()]


def tamper_signals(ctx, path, before, after, is_test, is_cfg, old=None):
    """返回 (阻断信号, 只列给评审看的改动, 新增行数, 删除行数)。old 是改名之前的路径（没改名就不传）。"""
    sig, notes = [], []
    added, removed = diff_texts(before, after)
    if is_test:
        if old and old != path and ctx.runner_collects(old) and not ctx.runner_collects(path):
            sig.append("定下的测试文件被改名成测试运行器不收的名字（%s → %s），等于删掉了它" % (old, path))
        ar = sum(len(ASSERT_RE.findall(t)) for _, t in removed)
        aa = sum(len(ASSERT_RE.findall(t)) for _, t in added)
        if after is None:
            sig.append("定下的测试文件被删了（带着 %d 处断言）" % ar)
        elif ar > aa:
            sig.append("删掉的断言（%d 处）比新加的（%d 处）多" % (ar, aa))
        if any(SKIP_RE.search(t) for _, t in added):
            sig.append("新加了跳过（skip / skipIf / runIf / todo 等）")
        if any(ONLY_RE.search(t) for _, t in added):
            sig.append("新加了只跑一条（only / fit / fdescribe）")
    if is_cfg:
        base = os.path.basename(path)
        if base == "package.json":
            b, a = package_test_scripts(before), package_test_scripts(after)
            for k in sorted(set(b) | set(a)):
                if b.get(k) == a.get(k):
                    continue
                if k not in a:
                    sig.append("删掉了 package.json 的 scripts.%s" % k)
                elif TAMPER_CONFIG_KEYS.search(str(b.get(k))) or TAMPER_CONFIG_KEYS.search(str(a.get(k))):
                    sig.append("改了 package.json 的 scripts.%s" % k)
                else:
                    notes.append("改了 package.json 的 scripts.%s" % k)
        else:
            changed = cfg_changed_lines(base, before, after, added, removed)
            hit = next((TAMPER_CONFIG_KEYS.search(t) for t in changed if TAMPER_CONFIG_KEYS.search(t)), None)
            if hit:
                sig.append("改了测试运行配置里的 %s" % hit.group(1))
            elif changed:
                notes.append("改了测试运行配置")
    return sig, notes, len(added), len(removed)


def new_runconfig_note(path, after):
    """PR 新加的测试运行配置文件：没有旧版本可比，只看里面有没有实质内容。返回 (行数, 出现的关键词) 或 None。"""
    base = os.path.basename(path)
    if base == "package.json":
        lines = ["%s: %s" % (k, v) for k, v in sorted(package_test_scripts(after).items())]
    else:
        added, _ = diff_texts(None, after)
        lines = cfg_changed_lines(base, None, after, added, [])
    if not lines:
        return None
    words = sorted(set(m.group(1).lower() for t in lines for m in TAMPER_CONFIG_KEYS.finditer(t)))
    return len(lines), words


def chk_tamper(ctx, pj):
    sc = pj.scope
    # 按本 PR 碰到的 spec 里最高的档和项目默认档里更高的那个跑：顺手改一份 lite spec 的 plan，不会让它停跑。
    # 没动任何 spec 的 PR 也跑；push 事件（不经 PR）不跑
    eff = tier_max(pj.pr_tier, ctx.proj_tier)
    # 「只改文档」的 PR 不跑 tamper；但登记成 tamper_files 的 .md（评测基线之类）被改、被改名了，不能算只改文档
    registered = any(ctx.is_registered_test_file(p) or ctx.is_registered_test_file(fc.old) for p, fc in sc.changes.items())
    if sc.mode != "range" or (sc.doc_only() and not registered) or ctx.is_push or TIER_RANK[eff] < 1:
        return
    ctx.tamper_tier = eff
    reasons = tamper_reasons(ctx, pj)
    prod_changed = any(ctx.is_prod_code(p) for p in sc.changes if sc.status(p) != "D")
    items = []
    new_cfgs = []
    for path, fc in sc.changes.items():
        is_test = ctx.is_test_file(fc.old) or ctx.is_test_file(path)
        is_cfg = ctx.is_runconfig(fc.old) or ctx.is_runconfig(path)
        if fc.status == "A":
            if is_cfg:
                new_cfgs.append((path, sc.read_after(path)))
            continue
        if is_test or is_cfg:
            items.append((path, sc.read_before(path), sc.read_after(path), is_test, is_cfg, "目标分支上已有", fc.old))
    for s in pj.owners:
        if pj.tier_of(s) != "heavy" or (s.dir + "/log.md") not in pj.files:
            continue
        for sha in Log(sc.read_state(s.dir + "/log.md")).test_author_commits():
            full = ctx.git.rev(sha)
            if not full or not ctx.git.is_ancestor(full, "HEAD"):
                ctx.warn("tamper", s.dir + "/log.md", "测试作者提交 %s 在仓库里找不到，没法对照" % sha)
                continue
            o = ctx.git.out("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", full) or ""
            for p in [x for x in o.split("\0") if x]:
                if ctx.is_test_file(p) and p in sc.changes and sc.status(p) != "D" and sc.changes[p].status == "A":
                    items.append((p, ctx.git.show(full, p), sc.read_after(p), True, False, "测试作者提交 %s" % sha, p))
    for path, before, after, is_test, is_cfg, why, old in items:
        sig, notes, na, nr = tamper_signals(ctx, path, before, after, is_test, is_cfg, old)
        if not sig:
            if notes:
                ctx.warn("tamper", path, "%s（+%d/-%d 行），没有阻断信号，列给评审看" % ("；".join(notes), na, nr))
            elif is_test and (na or nr):
                note = "改了%s的文件（+%d/-%d 行），没有阻断信号，列给评审看" % (why, na, nr)
                if prod_changed:
                    note += "；同一个 PR 也改了实现"
                ctx.warn("tamper", path, note)
            continue
        mine = [r for f, r in reasons if same_file(f, path)]
        text = "；".join(sig)
        if mine:
            ctx.warn("tamper", path, "%s；已写理由，列给评审和 owner：%s" % (text, short(mine[0], 70)))
        else:
            ctx.add("tamper", path, "%s；没写理由（log.md 或提交说明里加一行「测试改动：%s · 用例 · 为什么」）" % (text, path), tier=eff)
    for path, after in new_cfgs:
        note = new_runconfig_note(path, after)
        if note:
            ctx.warn("tamper", path, "新加了测试运行配置文件（%d 行有内容）%s，没有旧版本可比，列给评审看；请核对它没有把定下的测试排除在外" %
                     (note[0], "，里面有 " + "、".join(note[1]) if note[1] else ""))


# lite 的 AGENTS.md 没有「硬规矩」一节，硬规矩写在「本项目要点」里（assets/templates/lite/AGENTS.md）
RULE_SECTIONS = (("AGENTS.md", "硬规矩"), ("AGENTS.md", "本项目要点"), ("docs/spec-driven-dev.md", "本项目补充"))


def section_span_in(lines, name):
    """名叫 name 的节（含小节）在行列表里的 (标题行下标, 结束行下标)；没有这一节返回 None。围栏代码块里的 # 不算标题。"""
    fenced = fence_lines(lines)
    start, level = None, 0
    for i, line in enumerate(lines):
        h = heading_of(line) if (i + 1) not in fenced else None
        if start is None:
            if h and heading_matches(name, h[1]):
                start, level = i, h[0]
        elif h and h[0] <= level:
            return start, i
    return (start, len(lines)) if start is not None else None


def section_lines_of(text, name):
    """文本里名叫 name 的节的正文行（不含标题行）；文本是 None 或没有这一节，返回 None。"""
    if text is None:
        return None
    lines = split_lines(text)
    span = section_span_in(lines, name)
    return None if span is None else lines[span[0] + 1:span[1]]


def chk_rule_edits(ctx, pj):
    """AGENTS.md 的「硬规矩」和流程文档的「本项目补充」被删改的行，列给评审。只报警：改规矩要 owner 点名批准。"""
    sc = pj.scope
    if sc.mode != "range" or ctx.is_push:
        return
    said = None  # 提交说明里的「规则改动：…」行，要用到时才去读
    for path, name in RULE_SECTIONS:
        fc = sc.changes.get(path)
        if fc is None or fc.status == "A":
            continue
        before = section_lines_of(sc.read_before(path), name)
        if before is None:
            continue
        after = section_lines_of(sc.read_after(path), name) or []
        _, removed = diff_texts("\n".join(before), "\n".join(after))
        removed = [t for _, t in removed if t.strip()]
        if not removed:
            continue
        msg = "「%s」里有 %d 行被删或改掉了：%s%s；删改或放宽这类规矩要 owner 点名批准，提交说明写 `规则改动：哪条 · 为什么 · 「原话」`" % (
            name, len(removed), "；".join("「%s」" % short(t.strip(), 40) for t in removed[:3]), "…" if len(removed) > 3 else "")
        if said is None:
            commit_msgs = ctx.git.out("log", "--format=%B%x00", "%s..HEAD" % sc.base) if sc.base else ""
            said = [l.strip() for l in (commit_msgs or "").splitlines() if re.search(r"规则改动[:：]", l)]
        if said:
            msg += "（提交说明里有：%s）" % short(said[0], 60)
        ctx.warn("tamper", path, msg)


# --------------------------------------------------------------------------
# special-case：生产代码里嗅探测试环境
# --------------------------------------------------------------------------

def comment_part(line):
    m = re.search(r"(//|/\*|#|<!--)(.*)$", line)
    if m:
        return m.group(2)
    m = re.match(r"^\s*\*(.*)$", line)
    return m.group(1) if m else ""


def chk_special_case(ctx, pj):
    sc = pj.scope
    if sc.mode == "staged" or sc.doc_only() or pj.pr_tier is None and sc.mode != "all":
        return
    if sc.mode != "all" and TIER_RANK[pj.pr_tier] < 1:
        return
    seams = ctx.seam_vars()
    for path in sorted(sc.paths()):
        if sc.status(path) == "D" or not ctx.is_prod_code(path):
            continue
        hits = []
        for ln, line in sc.added(path):
            if any(v in line for v in seams):
                continue
            hit = None
            for rx in SPECIAL_CASE_RES:
                m = rx.search(line)
                if m:
                    hit = m.group(0)
                    break
            if hit is None:
                m = SPECIAL_COMMENT_RE.search(comment_part(line))
                if m:
                    hit = "注释「%s」" % m.group(0)
            if hit:
                hits.append("第 %d 行 %s" % (ln, hit))
        if hits:
            ctx.add("special-case", path, "生产代码里像是在照顾测试环境：%s%s；列给评审看" %
                    ("；".join(hits[:3]), "…" if len(hits) > 3 else ""), tier=pj.pr_tier or ctx.proj_tier)


# --------------------------------------------------------------------------
# review：评审记录
# --------------------------------------------------------------------------

def spec_header_lines_only(before, after):
    added, removed = diff_texts(before, after)
    for _, l in added + removed:
        if not re.match(r"^\s*(Status|Approved)\s*[:：]", l):
            return False
    return True


ALLOWED_AFTER_REVIEW = "只许改 log.md、plan.md、spec 页头的 Status / Approved、总参考的状态列和「以后再说」、重新生成的 docs/README.md"


def master_ref_core(text):
    """总参考去掉「状态」列和「## 以后再说」一节之后剩下的文本；评审之后这两处允许改，其余不许。"""
    lines = split_lines(text)
    span = section_span_in(lines, "以后再说")
    if span is not None:
        lines = lines[:span[0]] + lines[span[1]:]
    out, col = [], None
    for l in lines:
        if l.lstrip().startswith("|"):
            cells = l.strip().strip("|").split("|")
            names = [c.strip() for c in cells]
            if col is None and "状态" in names:
                col = names.index("状态")
            elif col is not None and col < len(cells):
                cells[col] = ""
                l = "|" + "|".join(cells) + "|"
        else:
            col = None
        out.append(l.rstrip())
    return "\n".join(out)


def allowed_after_review(path, before, after):
    """评审之后还允许改的：log.md、plan.md，spec.md 页头的 Status / Approved 两行，总参考阶段表的「状态」列和「以后再说」一节
    （lite 的 docs/later.md 整份），以及 --index 重新生成的 docs/README.md。其他改动都要复审。"""
    base = os.path.basename(path)
    if base in ("log.md", "plan.md"):
        return True
    if base == "spec.md":
        return spec_header_lines_only(before, after)
    if path == LATER_PATH:
        return True
    if path == MASTER_REF_PATH:
        return before is not None and after is not None and master_ref_core(before) == master_ref_core(after)
    if path == INDEX_PATH:
        return after is not None and split_lines(after)[0] == INDEX_HEAD and (before is None or split_lines(before)[0] == INDEX_HEAD)
    return False


def chk_review(ctx, pj):
    sc = pj.scope
    if sc.mode != "range" or sc.doc_only() or ctx.is_push:
        return
    g = ctx.git
    for s in pj.owners:
        tier = pj.tier_of(s)
        if TIER_RANK[tier] < 1:
            continue
        logp = s.dir + "/log.md"
        text = sc.read_state(logp) if logp in pj.files else None
        if not text:
            ctx.add("review", logp, "没有 log.md：说做完之前要有一条独立评审记录", tier=tier)
            continue
        added = set(ln for ln, _ in sc.added(logp)) if logp in sc.changes else set()
        recs = [r for r in Log(text).reviews() if r.lineno in added]
        if not recs:
            ctx.add("review", logp, "本次改动里没有新增评审记录（log.md 里要有「## 评审 · 日期 · 审过 <提交号>」）", tier=tier)
            continue
        rec = recs[-1]
        bad = []
        full = None
        if not rec.sha:
            bad.append("评审记录的标题没有绑「审过 <提交号>」")
        else:
            full = g.rev(rec.sha)
            if not full:
                bad.append("审过的提交 %s 在仓库里找不到" % rec.sha)
        v = rec.verdict()
        if v is None:
            bad.append("评审记录缺「结论：通过」或「结论：不通过」")
        elif v != "通过":
            bad.append("评审结论是「不通过」，还不能合并")
        if not rec.has_mutation_line():
            bad.append("评审记录缺「突变：」这一行（出了几个、存活几个、存活的怎么处理）")
        for kind, rest in rec.findings():
            disp = finding_disposition(rest)
            has_evidence = bool(re.search(r"证据[:：]", rest))
            if disp is None:
                bad.append("发现「%s」没有处置（已修 <提交号> / 不修： / 交 owner）" % short(rest, 30))
            elif kind == "blocker" and has_evidence and disp == "不修":
                bad.append("[blocker]「%s」带着证据，处置不能是「不修：」（只能是已修 <提交号> 或交 owner；「不修：」只给 major 和建议）" % short(rest, 30))
            elif kind in ("blocker", "major") and not has_evidence:
                ctx.warn("review", logp, "[%s]「%s」没写证据，只算建议" % (kind, short(rest, 30)))
        pend = [d for k, d, ev in owner_pending(Log(text)) if k == "blocker" and ev]  # 这份 spec 所有的评审记录，不只最新一条
        if pend:
            plan = s.dir + "/plan.md"
            need = Plan(sc.read_state(plan)).field("需要你") if plan in pj.files else None
            for d in pend:
                ctx.warn("review", logp, "[blocker]「%s」带着证据，处置是交 owner：结论照写，但不要开自动合并；把它写进 plan 的「需要你」，"
                         "owner 回了（log.md 里加一行「owner 回复：…」）再合%s" % (short(d, 30), "；现在 plan 的「需要你」是空的" if not trivial_lines([need or ""]) else ""))
        if full:
            head = sc.review_head
            if not g.is_ancestor(full, head):
                bad.append("审过的提交 %s 不在当前分支的历史里（rebase 过？），要求复审" % rec.sha)
            else:
                bad += review_after_problems(ctx, sc, full, head)
        for b in bad:
            ctx.add("review", logp, b, tier=tier)


def review_after_problems(ctx, sc, sha, head):
    g = ctx.git
    bad = []
    o = g.out("rev-list", "--first-parent", "%s..%s" % (sha, head)) or ""
    for c in o.split():
        ps = g.parents(c)
        if len(ps) >= 2 and sc.target_ref and g.is_ancestor(ps[1], sc.target_ref):
            continue
        parent = ps[0] if ps else None
        if parent:
            names = (g.out("diff", "--name-only", "-z", parent, c) or "").split("\0")
        else:
            names = (g.out("diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", c) or "").split("\0")
        for p in [n for n in names if n]:
            before = g.show(parent, p) if parent else None
            after = g.show(c, p)
            if not allowed_after_review(p, before, after):
                bad.append("审过 %s 之后，提交 %s 又改了 %s（%s）" % (sha[:7], c[:7], p, ALLOWED_AFTER_REVIEW))
    if sc.after == "worktree" and head == "HEAD":
        dirty = (g.out("diff", "--name-only", "-z", "HEAD") or "").split("\0") + g.ls_untracked()
        for p in [d for d in dirty if d]:
            if p.startswith(".sdd/local/"):
                continue
            if not allowed_after_review(p, g.show("HEAD", p), read_file(os.path.join(ctx.root, p))):
                bad.append("审过之后工作区又改了 %s（%s）" % (p, ALLOWED_AFTER_REVIEW))
    return bad


def chk_rerun(ctx, pj):
    try:
        n = int(ctx.env.get("GITHUB_RUN_ATTEMPT") or 1)
    except ValueError:
        n = 1
    if n > 1 and pj.pr_tier is not None and TIER_RANK[pj.pr_tier] >= 1:
        ctx.add("rerun", ".github/workflows", "这是第 %d 次重跑；偶发失败请登记进 .sdd/config.json 的 flaky（用例名、first_seen、count）" % n,
                tier=pj.pr_tier)


# --------------------------------------------------------------------------
# gate-files / docs-sync / later：改裁判的 PR、该同步没同步的文档、没了结的事
# --------------------------------------------------------------------------

CHANGE_WORD = {"A": "新加了", "D": "删掉了", "R": "改名了", "M": "改了", "C": "复制了"}


def gate_file_label(ctx, sc, path):
    """这个改动算不算门禁文件的改动。返回是哪一类；不是门禁文件，或测试运行配置没有实质改动，返回 None。"""
    fc = sc.changes[path]
    for glob, label in GATE_FILE_LABELS:
        rx = glob_to_re(glob)
        if rx.match(path) or rx.match(fc.old):
            return label
    bases = sorted(set([os.path.basename(path), os.path.basename(fc.old)]))
    if not any(b in ("package.json", "pyproject.toml", "setup.cfg") or any(glob_to_re(g).match(b) for g in GATE_CONFIG_NAMES) for b in bases):
        return None  # 不是运行配置，就不用去读它的新旧内容
    before, after = sc.read_before(path), sc.read_after(path)
    for base in bases:
        if base == "package.json":
            if package_test_scripts(before) != package_test_scripts(after):
                return "测试脚本 package.json 的 scripts.test*"
        elif base in ("pyproject.toml", "setup.cfg"):
            added, removed = diff_texts(before, after)
            if cfg_changed_lines(base, before, after, added, removed):
                return "测试运行配置 %s 里 pytest 的段落" % base
        elif any(glob_to_re(g).match(base) for g in GATE_CONFIG_NAMES):
            if fc.status in ("D", "R") or before != after:
                return "测试运行配置"
    return None


def known_without_message(before, after):
    """config 的 known 里这次新增的、不带 message 的条目，返回 [(check, file)]。"""
    def parse(text):
        try:
            d = json.loads(text or "{}")
        except ValueError:
            return []
        k = d.get("known") if isinstance(d, dict) else None
        return [e for e in k if isinstance(e, dict)] if isinstance(k, list) else []

    def key(e):
        return (e.get("check"), e.get("file"), e.get("message") if isinstance(e.get("message"), str) else None)
    old = set(key(e) for e in parse(before))
    out = []
    for e in parse(after):
        k = key(e)
        if k[2] is None and k not in old and (k[0], k[1]) not in out:
            out.append((k[0], k[1]))
    return out


def chk_gate_files(ctx, pj):
    """改了门禁文件（CI 流程、钩子、sdd 的配置和脚本、agent 的设置、测试运行配置）的 PR 不开自动合并，由 owner 来合。
    CI 跑的是 PR 自己改过的文件，它们一起改，任何机器检查都能被同一个 PR 关掉，所以只能报警、列给评审。"""
    sc = pj.scope
    if sc.mode != "range" or ctx.is_push:
        return
    for path in sorted(sc.changes):
        label = gate_file_label(ctx, sc, path)
        if label:
            ctx.warn("gate-files", path, "%s门禁文件（%s）：这类 PR 不开自动合并，由 owner 来合；评审包（--review-pack）会列出这处改动" %
                     (CHANGE_WORD.get(sc.changes[path].status, "改了"), label))
    cfg = ".sdd/config.json"
    if cfg in sc.changes and sc.status(cfg) != "D":
        for check, file in known_without_message(sc.read_before(cfg), sc.read_after(cfg)):
            ctx.warn("gate-files", cfg, "known 里新增了不带 message 的条目（%s · %s）：它会放过这个文件里这一类的全部发现，包括以后新冒出来的；"
                     "要登记就跑 --all --report --save 生成带 message 的条目，并请 owner 看过" % (check, file))


def trivial_lines(lines):
    """去掉空行和注释后的行；「无」之类等于没有内容。"""
    body = re.sub(r"<!--.*?-->", "", "\n".join(lines or []), flags=re.S)
    out = [l.rstrip() for l in body.split("\n") if l.strip()]
    return [] if strip_punct("".join(out)) in ("", "无", "没有", "暂无", "none") else out


def interface_changed(sc, path):
    """spec.md 的「接口」一节在这个 PR 里有没有改动。新加的 spec 里这一节有实际内容也算。"""
    after = trivial_lines(section_lines_of(sc.read_after(path), "接口"))
    if sc.status(path) == "A":
        return bool(after)
    return trivial_lines(section_lines_of(sc.read_before(path), "接口")) != after


def chk_docs_sync(ctx, pj):
    """overview、运维手册该跟着改没改：本 PR 改了 spec 的「接口」一节，或动了 config 登记的架构路径（architecture_paths），
    却没动 overview；动了运维路径（ops_paths），却没动运维手册。只报警，列给评审。"""
    sc = pj.scope
    if sc.mode != "range" or ctx.is_push:
        return

    def hits(key):
        rxs = [glob_to_re(g) for g in (ctx.cfg.get(key) or []) if isinstance(g, str) and g]
        return sorted(p for p in sc.changes if any(r.match(p) or r.match(sc.changes[p].old) for r in rxs))
    ifaces = []
    if OVERVIEW_PATH in pj.files:  # 项目有 overview 才用「接口」这一节去提醒
        ifaces = [s for s in pj.specs.list if s.path in sc.changes and sc.status(s.path) != "D" and interface_changed(sc, s.path)]
    arch, ops = hits("architecture_paths"), hits("ops_paths")
    if (ifaces or arch) and OVERVIEW_PATH not in sc.changes:
        what = []
        if ifaces:
            what.append("spec 的「接口」一节（%s）" % "、".join(s.id for s in ifaces[:4]))
        if arch:
            what.append("架构路径（%s）" % "、".join(arch[:3]) + ("…" if len(arch) > 3 else ""))
        ctx.warn("docs-sync", OVERVIEW_PATH, "本 PR 改了 %s，却没动 %s；它写的是现在的样子，该跟着改就在同一个 PR 里改（spec 还没做完的话，等改成 implemented 的那个 PR 也行），不用改就在评审里说一句" %
                 ("和".join(what), OVERVIEW_PATH))
    if ops and RUNBOOK_PATH not in sc.changes:
        ctx.warn("docs-sync", RUNBOOK_PATH, "本 PR 动了运维路径（%s），却没动 %s；改了部署脚本、迁移或环境变量，同一个 PR 里更新运维手册和 .env.example" %
                 ("、".join(ops[:3]) + ("…" if len(ops) > 3 else ""), RUNBOOK_PATH))


def chk_later(ctx, pj):
    """把 spec 改成 implemented 的那个 PR：plan 的 Open 和 spec 的「开放问题」要是（无）；没了结的挪进「以后再说」。"""
    sc = pj.scope
    if sc.mode != "range" or ctx.is_push:
        return
    for s in pj.specs.list:
        if s.path not in sc.changes or s.status != "implemented":
            continue
        bt = sc.read_before(s.path)
        if bt is not None and Spec(ctx, s.path, bt).status == "implemented":
            continue
        left = []
        if trivial_lines(section_lines_of(s.text, "开放问题")):
            left.append("spec 的「开放问题」")
        plan = s.dir + "/plan.md"
        if plan in pj.files and trivial_lines(section_lines_of(sc.read_state(plan), "Open")):
            left.append("plan 的 Open")
        if left:
            ctx.warn("later", s.path, "改成 implemented 时，%s 还有内容；没了结的挪进总参考的「以后再说」一节（docs/architecture/master-reference.md，lite 是 docs/later.md），已经定了的，就把那一节改成（无）" %
                     "、".join(left))


def later_entries(pj):
    """「以后再说」里的条目：总参考的「## 以后再说」一节，和 lite 的 docs/later.md 整份。
    返回 ([有这一节或这个文件的路径], [(路径, 条目全文, 挡不挡上线)])。条目 = 列表项，格式「什么事 · 谁做 · 什么时候做或挡着什么 · 出处」；第三段以「挡」开头算挡上线。"""
    places, items = [], []
    for path, whole in ((MASTER_REF_PATH, False), (LATER_PATH, True)):
        if path not in pj.files:
            continue
        text = pj.scope.read_state(path)
        if text is None:
            continue
        lines = split_lines(text) if whole else section_lines_of(text, "以后再说")
        if lines is None:
            continue
        places.append(path)
        fenced = fence_lines(lines)
        body = re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), "\n".join(lines), flags=re.S).split("\n")
        for i, line in enumerate(body):
            if (i + 1) in fenced:
                continue
            m = re.match(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$", line)
            if not m or strip_punct(m.group(1)) in ("", "无", "暂无", "没有"):
                continue
            segs = [x.strip() for x in re.split(r"\s*·\s*", m.group(1))]
            items.append((path, m.group(1), len(segs) > 2 and segs[2].startswith("挡")))
    return places, items


def owner_reply_target(body):
    """`owner 回复：` 后面第一个「 · 」之前的部分去掉标点：回复的对象。「 · 」之后是 owner 的原话，不算。"""
    return strip_punct(re.split(r"\s*·\s*", body, maxsplit=1)[0])


def owner_pending(log):
    """这份 log.md 里所有的评审记录中，处置是「交 owner」、之后还没有 owner 回复的发现：[(级别, 描述, 有没有证据)]，同一条发现只列一次。
    回复写成该记录之后的一行 `owner 回复：<发现描述的前 8 个字> · 「原话」`：去掉标点后，描述不到 8 个字就整段；
    对象是「全部」就覆盖它之前所有记录里的。只看 `·` 之前的对象，原话里写了什么不算。"""
    replies = [(ln, owner_reply_target(body)) for ln, body in log.line_items("owner 回复")]
    out = []
    for rec in log.reviews():
        targets = [t for ln, t in replies if ln > rec.lineno]
        for kind, rest in rec.findings():
            if finding_disposition(rest) != "交 owner":
                continue
            desc = re.split(r"\s·\s", rest)[0]
            key = strip_punct(desc)[:8]
            if any(t == "全部" or (key and key in t) for t in targets):
                continue
            item = (kind, desc, bool(re.search(r"证据[:：]", rest)))
            if item not in out:
                out.append(item)
    return out


# --------------------------------------------------------------------------
# 门禁：对照表、执行、记耗时
# --------------------------------------------------------------------------

def detect_pm(root):
    for lock, pm in (("pnpm-lock.yaml", "pnpm"), ("yarn.lock", "yarn"), ("bun.lockb", "bun"),
                     ("bun.lock", "bun"), ("package-lock.json", "npm")):
        if os.path.exists(os.path.join(root, lock)):
            return pm
    return "npm"


def default_gate_cmd(root, gate):
    pkg = os.path.join(root, "package.json")
    if os.path.exists(pkg):
        try:
            scripts = (json.loads(read_file(pkg) or "{}").get("scripts") or {})
        except ValueError:
            scripts = {}
        pm = detect_pm(root)
        if gate in scripts:
            return "%s run %s" % (pm, gate)
        if gate == "install":
            if pm == "npm":
                return "npm ci" if os.path.exists(os.path.join(root, "package-lock.json")) else "npm install"
            return "%s install" % pm
    mk = os.path.join(root, "Makefile")
    if os.path.exists(mk):
        target = gate.replace(":", "-")
        if re.search(r"^%s\s*:" % re.escape(target), read_file(mk) or "", re.M):
            return "make %s" % target
    return None


def gate_cmd(ctx, gate, root=None):
    gates = ctx.cfg.get("gates") or {}
    if isinstance(gates, dict) and gates.get(gate):
        return gates[gate]
    return default_gate_cmd(root or ctx.root, gate)


def exec_cmd(cmd, cwd, timeout=None, env=None):
    """跑一条 shell 命令，抓输出。返回 (退出码, 秒数, 是否超时, 输出)。"""
    t0 = time.time()
    p = subprocess.Popen(cmd, shell=True, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         start_new_session=True)
    timed_out = False
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except OSError:
            p.kill()
        out, _ = p.communicate()
    return p.returncode, time.time() - t0, timed_out, (out or b"").decode("utf-8", errors="replace")


def exit_code(rc):
    return rc if rc >= 0 else 128 - rc


def failed_names(ctx, gate, started=None):
    conf = ctx.cfg.get("test_reports") or {}
    rel = conf.get(gate) if isinstance(conf, dict) else None
    if not rel:
        return []
    full = os.path.join(ctx.root, rel)
    try:
        if started is not None and os.path.getmtime(full) < started - 1:
            return []
        data = json.loads(read_file(full) or "{}")
        return [c.name for c in parse_report_data(data) if c.status == "failed"][:20]
    except (OSError, ValueError):
        return []


def scenario_of(ctx):
    sc = getattr(ctx.args, "scenario", None) or ctx.env.get("SDD_SCENARIO")
    if sc in ("pre-commit", "stop", "manual"):
        return sc
    return "pre-commit" if ctx.env.get("GIT_INDEX_FILE") else "manual"


def current_tree(ctx):
    o = ctx.git.out("write-tree")
    return o.strip() if o else ""


def mode_run(ctx, gate):
    cmd = gate_cmd(ctx, gate)
    if not cmd:
        raise EnvError("门禁「%s」没配：在 .sdd/config.json 的 gates 里写对照表（通用名 → 项目命令）" % gate)
    t0 = time.time()
    rc = subprocess.call(cmd, shell=True, cwd=ctx.root)
    secs = time.time() - t0
    code = exit_code(rc)
    append_timing(ctx, gate, secs, code, scenario_of(ctx), current_tree(ctx), failed_names(ctx, gate, t0) if code else [])
    return code


# --------------------------------------------------------------------------
# --measure
# --------------------------------------------------------------------------

def is_placeholder_output(out):
    """占位门禁：退出 0 且输出里有一行（去掉空白后）以 TODO 开头（区分大小写）。工具多打的警告行不影响。"""
    return any(l.strip().startswith("TODO") for l in out.splitlines())


def mode_measure(ctx):
    results = []  # (gate, 命令, 秒, 退出码, 占位?)
    started = time.time()
    names = FAST_GATES + ["test"]
    unconfigured = []
    for g in names:
        cmd = gate_cmd(ctx, g)
        if not cmd:
            unconfigured.append(g)
            continue
        rc, secs, to, out = exec_cmd(cmd, ctx.root, timeout=900)
        results.append((g, cmd, secs, 124 if to else rc, (not to and rc == 0 and is_placeholder_output(out))))
    print("实测（当前环境，也就是 agent 的环境）：")
    for g, cmd, secs, rc, ph in results:
        print("  %-13s %6.1f 秒  %s" % (g, secs, "占位输出（没接真实工具）" if ph else ("通过" if rc == 0 else "没过（退出码 %d）" % rc)))
    for g in unconfigured:
        print("  %-13s 未配置" % g)
    if not results:
        raise EnvError("一个门禁都没配：在 .sdd/config.json 的 gates 里写对照表，或在 package.json / Makefile 里加同名脚本")
    fast = [r for r in results if r[0] in FAST_GATES]
    test = [r for r in results if r[0] == "test"]
    real = [r for r in results if not r[4]]
    commit_gates = [r[0] for r in fast]
    advice = ""
    if not real:
        commit_gates = [r[0] for r in results]
        advice = "门禁还是占位输出，没法实测 → 先把 %s 都带上（含全量测试）；接上真实工具后再跑 --measure。确认吗？" % "、".join(commit_gates)
    else:
        fast_s = sum(r[2] for r in fast)
        failed_fast = [r[0] for r in fast if r[3] != 0 and not r[4]]
        if test:
            t = test[0]
            nfail = len(failed_names(ctx, "test", started)) if t[3] != 0 else 0
            total = fast_s + t[2]
            if t[4]:
                commit_gates = [r[0] for r in results]
                advice = "全量测试还是占位输出 → 先带上；接上真实工具后再跑 --measure。确认吗？"
            elif t[3] == 0 and not failed_fast and total <= COMMIT_BUDGET_S:
                commit_gates = [r[0] for r in results]
                advice = "提交时的检查合计 %.0f 秒（不超过 %d 秒）且在这里全过 → 提交时带上全量测试。确认吗？" % (total, COMMIT_BUDGET_S)
            else:
                why = []
                if t[3] != 0:
                    why.append("有 %d 条在这里跑不了" % nfail if nfail else "在这里没全过")
                if total > COMMIT_BUDGET_S:
                    why.append("合计 %.0f 秒超过 %d 秒" % (total, COMMIT_BUDGET_S))
                advice = "全量测试 %.0f 秒%s → 提交时只跑快检查（%s），全量测试交给 CI。确认吗？" % (
                    t[2], "，" + "，".join(why) if why else "", "、".join(commit_gates) or "无")
        else:
            advice = "没配全量测试门禁 → 提交时只跑快检查（%s）。确认吗？" % ("、".join(commit_gates) or "无")
        if failed_fast:
            advice += "（注意：%s 在这里没过）" % "、".join(failed_fast)
    commit_s = sum(r[2] for r in results if r[0] in commit_gates)
    snippet = {
        "commit_gates": commit_gates,
        "commit_time_limit_s": int(max(COMMIT_BUDGET_S, round(commit_s * 1.5))),
        "measured": {"date": datetime.date.today().isoformat(),
                     "seconds": dict((r[0], round(r[2], 1)) for r in results),
                     "agent_env_pass": dict((r[0], r[3] == 0) for r in results)},
    }
    print("建议：" + advice)
    print("可以直接写进 .sdd/config.json 的内容（spec-check 不会自己改文件）：")
    print(json.dumps(snippet, ensure_ascii=False, indent=2))
    return 0


# --------------------------------------------------------------------------
# --status
# --------------------------------------------------------------------------

def pick_current(ctx, pj):
    cands = []
    for s in pj.specs.list:
        if s.status != "ready" or (s.dir + "/plan.md") not in pj.files:
            continue
        plan = Plan(pj.scope.read_state(s.dir + "/plan.md"))
        if plan.pending():
            cands.append((s, plan))
    if ctx.has_module("roadmap"):
        arch = sorted([c for c in cands if c[0].kind == "architecture"], key=lambda c: c[0].id)
        if arch:
            return [arch[0]], cands
        feats = [c for c in cands if c[0].kind != "architecture"]
        return feats, cands
    return cands, cands


def status_todo(ctx, pj, later_blockers):
    """「要你做的」：所有「需要你」不为空的 spec（不管什么状态）、挡上线的「以后再说」、还没回的「交 owner」。"""
    out = []
    for s in pj.specs.list:
        plan = s.dir + "/plan.md"
        need = Plan(pj.scope.read_state(plan)).field("需要你") if plan in pj.files else None
        if need and trivial_lines([need]):
            out.append("%s（%s）需要你：%s" % (s.id, s.status_raw or "无 Status", short(need, 100)))
    for _, text, _ in later_blockers:
        out.append("挡上线的「以后再说」：%s" % short(text, 100))
    for s in pj.specs.list:
        logp = s.dir + "/log.md"
        if logp not in pj.files:
            continue
        for kind, desc, _ in owner_pending(Log(pj.scope.read_state(logp))):
            out.append("交 owner 还没回（%s）：[%s] %s" % (s.id, kind, short(desc, 80)))
    return out


def mode_status(ctx, pj):
    picked, cands = pick_current(ctx, pj)
    counts = {}
    for s in pj.specs.list:
        counts[s.status or "?"] = counts.get(s.status or "?", 0) + 1
    print("共 %d 份 spec：%s" % (len(pj.specs.list), "、".join("%s %d" % (k, v) for k, v in sorted(counts.items())) or "无"))
    chosen = None
    if not picked:
        print("开工规则没有选中任何 spec：没有 Status: ready 且 plan 里还有没勾步骤的。")
    elif len(picked) > 1:
        print("有 %d 份 spec 都是 ready 且没做完，请 owner 指定先做哪份：" % len(picked))
        for s, plan in picked:
            print("  - %s" % s.path)
    else:
        chosen = picked[0]
        s, plan = chosen
        first = plan.unchecked()[0]
        done = len([x for x in plan.steps if x.checked])
        print("当前 spec：%s（ready，plan 进度 %d/%d）" % (s.path, done, len(plan.steps)))
        print("当前步骤：%s%s" % ((first.num + ". ") if first.num else "", first.text))
        need = plan.field("需要你")
        if need:
            print("需要你：%s" % need)
        if plan.waiting_for_owner():
            print("在等 owner 验收。")
            acc, _ = parse_acceptance(s.lines)
            items = [(acceptance_tag(t), n, t) for n, t in acc if acceptance_tag(t)]
            if items:
                print("（人工）（live）（平台）条目，要 owner 亲自看、在场，或由在那个平台上的会话确认：")
                for tag, n, t in items:
                    print("  %s验收 %d：%s" % ({"manual": "（人工）", "live": "（live）", "platform": "（平台）"}[tag], n,
                                              short(re.sub(r"[（(]\s*(?:人工|live|平台\s*(?:[:：][^）)]*)?)\s*[）)]", "", t, flags=re.I), 60)))
            logp = s.dir + "/log.md"
            if logp in pj.files:
                tc = Log(pj.scope.read_state(logp)).test_changes()
                if tc:
                    print("这份 spec 放宽过的测试，请看有没有不认的：")
                    for _, f, case, why in tc:
                        print("  %s · %s · %s" % (f, case, why))
    places, entries = later_entries(pj)
    blockers = [e for e in entries if e[2]]
    if places:
        print("以后再说：共 %d 条（%s）%s" % (len(entries), "、".join(places), "，其中挡上线 %d 条：" % len(blockers) if blockers else ""))
        for _, text, _ in blockers:
            print("  - " + short(text, 100))
    todo = status_todo(ctx, pj, blockers)
    if todo:
        print("要你做的（%d 条）：" % len(todo))
        for t in todo:
            print("  - " + t)
    wait = []
    for rel in ("docs/spec-driven-dev.md", "AGENTS.md"):
        if rel in pj.files:
            wait += parse_wait_items(pj.scope.read_state(rel))
    if wait:
        print("待回流 skill 的条目（请 owner 去 skill 仓库改、升版本号，再 sdd upgrade 回来）：")
        for w in wait:
            print("  - " + w)
    flaky = ctx.cfg.get("flaky") or []
    if flaky:
        print("已知偶发清单：")
        for f in flaky:
            if isinstance(f, dict):
                print("  - %s（first_seen %s，出现 %s 次）" % (f.get("test"), f.get("first_seen"), f.get("count")))
    for m in timing_state(ctx):
        print("建议重新实测（--measure）：" + m)
    return 0


# --------------------------------------------------------------------------
# --index / --review-pack / --handoff / 指纹
# --------------------------------------------------------------------------

def mode_index(ctx, pj):
    text, warns = build_index(ctx, pj)
    path = os.path.join(ctx.root, INDEX_PATH)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    for fl, msg in warns:
        print("警 index %s: %s" % (fl, msg))
    print("入口页已生成：" + INDEX_PATH)
    return 0


def clip(text, n=60000):
    return text if len(text) <= n else text[:n] + "\n…（太长，已截断）\n"


def mode_review_pack(ctx, pj):
    sc = pj.scope
    specs = pj.owners
    if not specs:
        raise EnvError("这次改动没动任何 spec 文件夹，评审包没法按 spec 生成")
    head = ctx.git.rev("HEAD") or ""
    out = ["# 评审包（spec-check --review-pack 生成）", "",
           "基线 %s · HEAD %s。评审只看这个包，不看作者的对话；作者写的理由和验收矩阵都只当待核对项。" % ((sc.base or "无")[:7], head[:7]), ""]
    for s in specs:
        out += ["## spec：%s" % s.path, "", s.text.rstrip(), ""]
    out += ["## diff（去掉 log.md 和 plan.md）", "", "```diff"]
    for p in sorted(sc.paths()):
        if os.path.basename(p) in ("log.md", "plan.md"):
            continue
        before, after = sc.read_before(p), sc.read_after(p)
        if before is None and after is None:
            continue
        diff = list(difflib.unified_diff(split_lines(before or ""), split_lines(after or ""),
                                         "a/" + sc.changes[p].old, "b/" + p, lineterm=""))
        out += diff
    out += ["```", "", "## 本次新增或改动的测试，和点名这些 spec 验收的测试", ""]
    shown = set()
    pool = [p for p in sorted(sc.paths()) if ctx.is_test_file(p) and sc.status(p) != "D"]
    for p, titles in test_sources(ctx, pj):
        for s in specs:
            rx = name_regex(s)
            if any(named_numbers(rx, t) for t in titles) and p not in pool:
                pool.append(p)
    for p in pool:
        if p in shown:
            continue
        shown.add(p)
        t = sc.read_state(p)
        if t is not None:
            out += ["### %s" % p, "", "```", clip(t).rstrip(), "```", ""]
    n0 = len(ctx.findings)
    chk_tamper(ctx, pj)
    tam = ctx.findings[n0:]
    del ctx.findings[n0:]
    out += ["## tamper 的输出（含作者写的理由）", ""]
    out += [("- " + f.line()) for f in tam] or ["（没有被标出的削弱）"]
    out.append("")
    n0 = len(ctx.findings)
    chk_gate_files(ctx, pj)
    chk_docs_sync(ctx, pj)
    chk_rule_edits(ctx, pj)
    sync = ctx.findings[n0:]
    del ctx.findings[n0:]
    out += ["## 门禁文件的改动、该同步没同步的文档、被删改的规矩（只报警，评审要逐条核对）", ""]
    out += [("- " + f.line()) for f in sync] or ["（没有）"]
    out.append("")
    if any(pj.tier_of(s) == "heavy" for s in specs):
        out += ["## 验收矩阵（作者写的，待核对）", ""]
        for s in specs:
            if pj.tier_of(s) == "heavy" and (s.dir + "/plan.md") in pj.files:
                pl = split_lines(sc.read_state(s.dir + "/plan.md"))
                st = None
                for i, l in enumerate(pl):
                    h = heading_of(l)
                    if h and h[0] == 2 and heading_matches("验收矩阵", h[1]):
                        st = i
                        break
                if st is not None:
                    en = len(pl)
                    for j in range(st + 1, len(pl)):
                        hh = heading_of(pl[j])
                        if hh and hh[0] <= 2:
                            en = j
                            break
                    out += pl[st:en] + [""]
    os.makedirs(ctx.local_dir(), exist_ok=True)
    name = "review-pack-%s-%s.md" % ("+".join(re.sub(r"[^\w.-]", "_", s.id) for s in specs), head[:7] or "nohead")
    path = os.path.join(ctx.local_dir(), name)
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print(os.path.relpath(path, ctx.root))
    return 0


def read_hook_input():
    try:
        if sys.stdin is None or sys.stdin.isatty():
            return {}
        r, _, _ = select.select([sys.stdin], [], [], 0.5)
        if not r:
            return {}
        data = sys.stdin.read()
        obj = json.loads(data) if data.strip() else {}
        return obj if isinstance(obj, dict) else {}
    except (OSError, ValueError):
        return {}


def mode_handoff(ctx, args):
    """Stop 钩子用。有警告就写到 stderr、以 2 退出，让模型看到；已经拦过一次（stop_hook_active）就以 0 退出。"""
    hook = read_hook_input()
    try:
        init_project(ctx, False)
        scope = build_scope(ctx, args, "range")
        pj = Project(ctx, scope)
        msgs = handoff_messages(ctx, pj)
    except EnvError as e:
        print("spec-check --handoff：%s（跳过，不拦停下）" % e)
        return 0
    if not msgs:
        return 0
    text = "\n".join("警 handoff plan.md: " + m for m in msgs)
    if hook.get("stop_hook_active"):
        print(text)
        return 0
    sys.stderr.write(text + "\n")
    return 2


def mode_fingerprint(ctx):
    for name, rel, state, note in fingerprint_state(ctx.root):
        print("%s %s: %s%s" % (name, rel, state, "（%s）" % note if note else ""))
    return 0


def mode_stamp(ctx):
    for m in stamp_all(ctx.root, getattr(ctx.args, "tier", None), ctx.cfg_modules()):
        print("已写指纹  " + m)
    return 0


def save_known(ctx):
    path = os.path.join(ctx.root, ".sdd", "config.json")
    raw = {}
    if os.path.exists(path):
        raw = json.loads(read_file(path) or "{}")
    known = [k for k in (raw.get("known") or []) if isinstance(k, dict)]
    have = set((k.get("check"), k.get("file"), norm_msg(k["message"]) if isinstance(k.get("message"), str) else None) for k in known)
    for f in ctx.findings:
        if f.level != BLOCK:
            continue  # 只记「拦」的；警告不用放过
        entry = {"check": f.check, "file": f.file, "message": norm_msg(f.msg)}
        key = (entry["check"], entry["file"], entry["message"])
        if key not in have:
            have.add(key)
            known.append(entry)
    raw["known"] = known
    sha = ctx.git.rev("HEAD")
    if sha:
        raw["baseline_commit"] = sha
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(raw, ensure_ascii=False, indent=2) + "\n")
    return len(known)


# --------------------------------------------------------------------------
# 总调度和输出
# --------------------------------------------------------------------------

def run_checks(ctx, pj, mode):
    sc = pj.scope
    if sc.note:
        ctx.warn("base", "-", sc.note)
    chk_status(ctx, pj)
    chk_approval(ctx, pj)
    chk_pairs(ctx, pj)
    chk_frozen(ctx, pj)
    chk_line_refs(ctx, pj)
    chk_todo_files(ctx, pj)
    chk_leftovers(ctx, pj)
    chk_numbering(ctx, pj)
    chk_shape(ctx, pj)
    chk_codes(ctx, pj)
    chk_notes(ctx, pj)
    if mode != "staged":
        chk_index(ctx, pj)
    if mode == "range":
        chk_handoff(ctx, pj)
        chk_timing(ctx, pj)
        chk_gate_files(ctx, pj)
        chk_docs_sync(ctx, pj)
        chk_later(ctx, pj)
        chk_rule_edits(ctx, pj)
    chk_trace(ctx, pj)
    if mode != "staged":
        chk_tamper(ctx, pj)
        chk_special_case(ctx, pj)
        chk_review(ctx, pj)
        if mode == "range":
            chk_rerun(ctx, pj)


def emit(ctx, tier_label):
    fs = sorted(ctx.findings, key=lambda f: 0 if f.level == BLOCK else 1)
    for f in fs:
        print(f.line())
    nb = len([f for f in fs if f.level == BLOCK])
    nw = len(fs) - nb
    extra = "；已知不合规 %d 条已跳过" % ctx.suppressed if ctx.suppressed else ""
    print("spec-check 汇总 · 档位 %s · 拦 %d 条 · 警 %d 条%s" % (tier_label, nb, nw, extra))
    return nb


def tier_label(ctx, pj):
    """汇总行里的档位。tamper 跑了的话，写明它实际按哪一档（它取本 PR 的档位和项目默认档里更高的那个）。"""
    label = pj.pr_tier or "lite（没动 spec，按 lite 列检查；项目默认 %s）" % ctx.proj_tier
    if ctx.tamper_tier:
        label += " · tamper 按 %s 档" % ctx.tamper_tier
    return label


# --------------------------------------------------------------------------
# --red-on-base 和 --mutants：在临时 worktree 里跑测试
# --------------------------------------------------------------------------

class TempWorktree(object):
    def __init__(self, ctx, rev):
        self.ctx, self.rev = ctx, rev
        self.tmp = None
        self.path = None
        self.git = Git(ctx.root, keep_env=False)

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="sdd-wt-")
        self.path = os.path.join(self.tmp, "wt")
        rc, _, err = self.git.run("worktree", "add", "--detach", self.path, self.rev)
        if rc != 0:
            shutil.rmtree(self.tmp, ignore_errors=True)
            raise EnvError("建不了临时 worktree：%s" % err.decode("utf-8", errors="replace").strip())
        return self

    def __exit__(self, *exc):
        self.git.run("worktree", "remove", "--force", self.path)
        shutil.rmtree(self.tmp, ignore_errors=True)
        self.git.run("worktree", "prune")
        return False


GATE_TIMEOUT = 1800


def gate_env():
    return clean_env()


def prepare_worktree(ctx, wt):
    """在临时 worktree 里跑 install 门禁。"""
    cmd = gate_cmd(ctx, "install", wt.path)
    if cmd:
        rc, secs, to, out = exec_cmd(cmd, wt.path, timeout=GATE_TIMEOUT, env=gate_env())
        if rc != 0 or to:
            raise EnvError("临时 worktree 里 install 失败：%s" % short(out.strip().splitlines()[-1] if out.strip() else "无输出", 80))


def unit_gates(ctx, wt_path):
    gs = [g for g in ("test:unit", "test:integration") if gate_cmd(ctx, g, wt_path)]
    return gs or ["test"]


def report_path(ctx, gate, root):
    conf = ctx.cfg.get("test_reports") or {}
    rel = conf.get(gate) if isinstance(conf, dict) else None
    return os.path.join(root, rel) if rel else None


def file_matches(case_file, paths):
    if not case_file:
        return None
    return [p for p in paths if case_file.endswith(p) or p.endswith(case_file)] or []


def new_repro_names(sc, paths):
    """新增行里名字带「复现」的用例。"""
    names = []
    for p in paths:
        for _, l in sc.added(p):
            m = re.search(r"""\b(?:it|test)\s*(?:\.\w+)?\s*\(\s*(['"`])(.*?复现.*?)\1""", l)
            if m:
                names.append((p, m.group(2)))
                continue
            m = re.search(r"def\s+(test_\w*复现\w*)", l)
            if m:
                names.append((p, m.group(1)))
    return names


def mode_red_on_base(ctx, args):
    if ctx.is_push:
        print("这是 push 事件（不经 PR），--red-on-base 不跑（直接通过）。")
        return 0
    scope = build_scope(ctx, args, "range")
    pj = Project(ctx, scope)
    if pj.pr_tier != "heavy":
        print("这个 PR 所属的 spec 不是 heavy，--red-on-base 不跑（直接通过）。")
        return 0
    if scope.doc_only():
        print("只改了文档，--red-on-base 不跑（直接通过）。")
        return 0
    if scope.base is None or scope.base == ctx.git.rev("HEAD") and not scope.paths():
        print("没有改动，--red-on-base 不跑。")
        return 0
    tests = sorted(p for p, fc in scope.changes.items() if fc.status in ("A", "M", "R") and ctx.is_test_file(p))
    if not tests:
        print("本 PR 没有新增或改动的测试，--red-on-base 不跑。")
        return 0
    findings_start = len(ctx.findings)
    with TempWorktree(ctx, scope.base) as wt:
        prepare_worktree(ctx, wt)
        gates = unit_gates(ctx, wt.path)
        for g in gates:
            cmd = gate_cmd(ctx, g, wt.path)
            rc, secs, to, out = exec_cmd(cmd, wt.path, timeout=GATE_TIMEOUT, env=gate_env())
            if rc != 0 or to:
                raise EnvError("目标分支的旧代码上 %s 就不绿（退出码 %s），--red-on-base 中止，免得把偶发失败当成「变红」" % (g, "超时" if to else rc))
        for p in tests:
            dst = os.path.join(wt.path, p)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "w", encoding="utf-8", newline="") as f:
                f.write(scope.read_after(p) or "")
        cases, all_out, any_fail_rc = [], "", False
        for g in gates:
            rp = report_path(ctx, g, wt.path)
            if rp and os.path.exists(rp):
                os.remove(rp)
            cmd = gate_cmd(ctx, g, wt.path)
            rc, secs, to, out = exec_cmd(cmd, wt.path, timeout=GATE_TIMEOUT, env=gate_env())
            all_out += out
            any_fail_rc = any_fail_rc or rc != 0
            if rp and os.path.exists(rp):
                try:
                    cases += parse_report_data(json.loads(read_file(rp) or "{}"))
                except ValueError:
                    pass
    own = []
    for c in cases:
        if c.level == "file" and not c.file:
            own.append(c)
        elif file_matches(c.file, tests):
            own.append(c)
    have_report = bool(cases)
    failing = [c for c in own if c.status == "failed"]
    imp = [c for c in failing if c.level == "file" or IMPORT_FAIL_RE.search(c.message or "")]
    red = [c for c in failing if c not in imp]
    if not have_report and any_fail_rc:
        if IMPORT_FAIL_RE.search(all_out):
            imp = [Case("(输出)", "", "failed", all_out, "file")]
        else:
            red = [Case("(输出)", "", "failed", all_out)]
    for p, name in new_repro_names(scope, tests):
        hit = [c for c in own if name in c.name]
        ok = False
        if hit:
            c = hit[0]
            if c.status == "failed" and c not in imp:
                ok = True
            elif c.status == "passed":
                ctx.add("red-on-base", p, "「%s」在旧代码上是绿的，说明它没有复现 bug" % short(name, 40), tier="heavy")
                continue
        if not ok:
            ctx.add("red-on-base", p, "「%s」在旧代码上不是断言失败的红（导入失败、被跳过或没跑出结果）" % short(name, 40), tier="heavy")
    if not red:
        if imp:
            ctx.warn("red-on-base", tests[0], "新测试在旧代码上全是导入失败（新功能的测试多半如此），不算断言失败的红")
        else:
            ctx.warn("red-on-base", tests[0], "新测试在旧代码上没有一条是红的；先看到红再写实现，请对照评审记录")
    new = ctx.findings[findings_start:]
    for f in sorted(new, key=lambda f: 0 if f.level == BLOCK else 1):
        print(f.line())
    nb = len([f for f in new if f.level == BLOCK])
    print("--red-on-base 汇总 · 新测试文件 %d 个 · 旧代码上断言失败的用例 %d 条 · 拦 %d 条 · 警 %d 条" % (len(tests), len(red), nb, len(new) - nb))
    return 1 if nb else 0


def mode_mutants(ctx, args):
    if ctx.is_push:
        print("这是 push 事件（不经 PR），--mutants 不跑（直接通过）。")
        return 0
    scope = build_scope(ctx, args, "range")
    pj = Project(ctx, scope)
    heavy = [s for s in pj.owners if pj.tier_of(s) == "heavy"]
    if not heavy:
        print("这个 PR 所属的 spec 不是 heavy，--mutants 不跑（直接通过）。")
        return 0
    if scope.doc_only():
        print("只改了文档，--mutants 不跑（直接通过）。")
        return 0
    todo = []
    for s in heavy:
        lp = s.dir + "/log.md"
        if lp not in pj.files:
            continue
        log = Log(scope.read_state(lp))
        revoked = log.revoked()
        for m in log.mutants():
            if m.id not in revoked:
                todo.append((s, lp, m))
    if not todo:
        print("log.md 里没有登记（或都已撤销）的突变，--mutants 不跑。")
        return 0
    head = ctx.git.rev("HEAD")
    start = len(ctx.findings)
    killed = survived = stale = 0
    timeouts = []
    with TempWorktree(ctx, head) as wt:
        prepare_worktree(ctx, wt)
        base_secs = {}
        for _, _, m in todo:
            if m.gate in base_secs:
                continue
            cmd = gate_cmd(ctx, m.gate, wt.path)
            if not cmd:
                raise EnvError("突变 %s 登记的门禁「%s」没配" % (m.id, m.gate))
            rc, secs, to, out = exec_cmd(cmd, wt.path, timeout=GATE_TIMEOUT, env=gate_env())
            if rc != 0 or to:
                raise EnvError("基线上门禁 %s 就不绿（退出码 %s），--mutants 中止，免得把偶发失败当成「杀死了突变」" % (m.gate, "超时" if to else rc))
            base_secs[m.gate] = secs
        for s, lp, m in todo:
            where = lp
            if not (m.path and m.original is not None and m.replacement is not None):
                ctx.add("mutants", where, "突变 %s 的块不完整（要有「文件：」「原文：」「改成：」）" % m.id, tier="heavy")
                stale += 1
                continue
            fpath = os.path.join(wt.path, m.path)
            if not os.path.isfile(fpath):
                ctx.add("mutants", where, "突变 %s 过期：文件 %s 不存在；要评审追加一行「撤销突变 %s：理由」，或用新编号重新登记" % (m.id, m.path, m.id), tier="heavy")
                stale += 1
                continue
            with open(fpath, "rb") as f:
                raw = f.read()
            text = raw.decode("utf-8", errors="replace")
            crlf = "\r\n" in text
            norm = norm_nl(text)
            n = norm.count(m.original) if m.original else 0
            if n == 0:
                ctx.add("mutants", where, "突变 %s 过期：%s 里找不到原文片段；要评审追加一行「撤销突变 %s：理由」，或用新编号重新登记" % (m.id, m.path, m.id), tier="heavy")
                stale += 1
                continue
            if n > 1:
                ctx.add("mutants", where, "突变 %s 的原文片段在 %s 里出现 %d 次，必须正好一次" % (m.id, m.path, n), tier="heavy")
                stale += 1
                continue
            new = norm.replace(m.original, m.replacement, 1)
            if crlf:
                new = new.replace("\n", "\r\n")
            try:
                with open(fpath, "wb") as f:
                    f.write(new.encode("utf-8"))
                limit = max(base_secs[m.gate] * 3, 5.0)
                rc, secs, to, out = exec_cmd(gate_cmd(ctx, m.gate, wt.path), wt.path, timeout=limit, env=gate_env())
            finally:
                with open(fpath, "wb") as f:
                    f.write(raw)
            if to:
                killed += 1
                timeouts.append(m.id)
            elif rc == 0:
                survived += 1
                ctx.add("mutants", where, "突变 %s（%s）打上之后门禁 %s 仍然全绿：存活，说明这一处没被测到；补测试杀掉它，或写一句理由说明它是等价突变" %
                        (m.id, short(m.spec_ref, 20), m.gate), tier="heavy")
            else:
                killed += 1
    if timeouts:
        ctx.warn("mutants", "-", "超时算杀死，但单独列出：%s" % "、".join(timeouts))
    new_f = ctx.findings[start:]
    for f in sorted(new_f, key=lambda f: 0 if f.level == BLOCK else 1):
        print(f.line())
    nb = len([f for f in new_f if f.level == BLOCK])
    print("--mutants 汇总 · 共 %d 个 · 变红（杀死）%d · 存活 %d · 过期或不合格 %d · 拦 %d 条" % (len(todo), killed, survived, stale, nb))
    return 1 if nb else 0


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------

def build_parser():
    p = argparse.ArgumentParser(prog="spec-check.py", description="sdd 检查脚本：不带模式时按整个 PR 的范围跑全部检查。",
                                epilog="退出码：0 没有拦；1 有拦；2 用法或环境错误（--handoff 例外：环境错误也退出 0）。")
    p.add_argument("--staged", action="store_true", help="提交时用：只看暂存的文件")
    p.add_argument("--run", metavar="门禁名", help="经本脚本跑项目的门禁，并把耗时记进 .sdd/local/timing.jsonl")
    p.add_argument("--measure", action="store_true", help="实测快检查和全量测试要多久，给出建议和一段 config JSON")
    p.add_argument("--status", action="store_true", help="开工规则选中了哪份 spec；等 owner 验收时列出待办；「以后再说」的条数；「要你做的」")
    p.add_argument("--index", action="store_true", help="重新生成入口页 docs/README.md")
    p.add_argument("--review-pack", action="store_true", help="生成评审包，写到 .sdd/local/ 并打印路径")
    p.add_argument("--red-on-base", action="store_true", help="heavy：新测试在目标分支的旧代码上必须红")
    p.add_argument("--mutants", action="store_true", help="heavy：把 log.md 里登记的突变逐个打上，确认变红")
    p.add_argument("--all", action="store_true", help="和 --report 一起用：全量体检，不区分新旧内容")
    p.add_argument("--report", action="store_true", help="只打印，退出码恒为 0")
    p.add_argument("--save", action="store_true", help="和 --all --report 一起用：把结果记进 config 的 known，并记 baseline_commit")
    p.add_argument("--handoff", action="store_true", help="Stop 钩子用：plan 有没有跟着代码改")
    p.add_argument("--fingerprint", action="store_true", help="列出三样受管内容的状态：clean / modified / missing")
    p.add_argument("--stamp", action="store_true", help="重算三样受管内容的指纹，写回各自的标记")
    p.add_argument("--base", metavar="分支", help="对比的目标分支（优先级最高）")
    p.add_argument("--tier", choices=TIERS, help="指定档位（接入前从 skill 路径跑 --all --report / --measure 时用；--stamp 也用它填 tier）")
    p.add_argument("--scenario", choices=["pre-commit", "stop", "manual"], help="--run 记耗时时的场景（默认看是不是在 git 钩子里）")
    p.add_argument("--version", action="store_true", help="打印版本")
    return p


def find_root():
    p = subprocess.run(["git", "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if p.returncode == 0 and p.stdout.strip():
        return p.stdout.decode("utf-8", errors="replace").strip()
    return None


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.version:
        print("spec-check %s" % VERSION)
        return 0
    chosen = [n for n in ("staged", "run", "measure", "status", "index", "review_pack", "red_on_base", "mutants",
                          "all", "handoff", "fingerprint", "stamp") if getattr(args, n)]
    if len(chosen) > 1:
        parser.error("一次只能选一个模式（现在选了：%s）" % "、".join(chosen))
    if args.all != args.report:
        parser.error("--all 和 --report 要一起用（全量体检，只打印）")
    if args.save and not args.all:
        parser.error("--save 要和 --all --report 一起用")
    mode = chosen[0] if chosen else "default"
    root = find_root()
    tolerant = mode in ("measure", "all", "fingerprint", "stamp")
    try:
        if root is None:
            if not tolerant:
                raise EnvError("当前目录不在 git 仓库里")
            root = os.getcwd()
        ctx = Ctx(root, load_config(root), args)
        if mode == "fingerprint":
            return mode_fingerprint(ctx)
        if mode == "stamp":
            return mode_stamp(ctx)
        if mode == "run":
            init_project(ctx, False)
            return mode_run(ctx, args.run)
        if mode == "measure":
            init_project(ctx, True)
            return mode_measure(ctx)
        if mode == "handoff":
            return mode_handoff(ctx, args)
        if mode == "red_on_base":
            init_project(ctx, False)
            return mode_red_on_base(ctx, args)
        if mode == "mutants":
            init_project(ctx, False)
            return mode_mutants(ctx, args)
        if mode == "all":
            init_project(ctx, True)
            scope = build_scope(ctx, args, "all")
            pj = Project(ctx, scope)
            run_checks(ctx, pj, "all")
            emit(ctx, tier_label(ctx, pj))
            if args.save:
                n = save_known(ctx)
                print("已写入 .sdd/config.json：known %d 项，baseline_commit 记为当前 HEAD" % n)
            return 0
        init_project(ctx, False)
        if mode == "staged":
            t0 = time.time()
            scope = build_scope(ctx, args, "staged")
            pj = Project(ctx, scope)
            run_checks(ctx, pj, "staged")
            nb = emit(ctx, tier_label(ctx, pj))
            append_timing(ctx, "staged", time.time() - t0, 1 if nb else 0, scenario_of(ctx), current_tree(ctx))
            return 1 if nb else 0
        scope = build_scope(ctx, args, "all" if mode in ("status", "index") else "range")
        pj = Project(ctx, scope)
        if mode == "status":
            return mode_status(ctx, pj)
        if mode == "index":
            return mode_index(ctx, pj)
        if mode == "review_pack":
            return mode_review_pack(ctx, pj)
        run_checks(ctx, pj, "range")
        return 1 if emit(ctx, tier_label(ctx, pj)) else 0
    except EnvError as e:
        if mode == "handoff":
            print("spec-check --handoff：%s（跳过，不拦停下）" % e)
            return 0
        sys.stderr.write("spec-check 环境错误：%s\n" % e)
        return 2
    except Exception as e:  # 脚本自己的毛病，不能冒充「有拦」（退出码 1）
        if mode == "handoff":
            print("spec-check --handoff：内部错误（%s: %s），跳过，不拦停下" % (type(e).__name__, e))
            return 0
        sys.stderr.write("spec-check 内部错误（脚本的毛病，不是你的文档有问题）：%s: %s\n%s" % (type(e).__name__, e, traceback.format_exc()))
        return 2


if __name__ == "__main__":
    sys.exit(main())
