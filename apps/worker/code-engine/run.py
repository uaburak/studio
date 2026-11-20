"""Runs one post program of Studio's code engine (docs/URETIM-RESIM.md, Faz 4).

    python -I -B run.py <lib dir> <input.json> <program.py>
    python -I -B run.py --check <program.py>          # the static check only (JSON on stdout)

The worker starts this inside a macOS sandbox (sandbox-exec: reads only the virtualenv, Python,
the job's input folder and system fonts/libraries; writes only the job's output and temp
folders). Before the program runs, a static check (the second fence) refuses anything beyond
drawing: imports outside the allow-list, `subprocess`, `os.system`, `ctypes`, sockets, `eval`,
`exec`, `open`, `getattr`, dunder escapes… Exit codes: 0 done, 1 the program raised (its
traceback on stderr), 3 the static check refused it (a `@@STUDIO_CHECK@@ {json}` line on stderr).
"""

import ast
import json
import os
import sys
import traceback

ALLOWED_MODULES = {
    "PIL",
    "skia",
    "numpy",
    "cv2",
    "math",
    "random",
    "json",
    "pathlib",
    "studio_brand",
    "colorsys",
    "typing",
    "dataclasses",
    "functools",
    "itertools",
    "__future__",
    # pure, side-effect free standard modules
    "collections",
    "statistics",
    "textwrap",
    "unicodedata",
    "string",
    "re",
    "enum",
    "copy",
}
# `os` only as `os.path`.
OS_PATH = "os.path"
FORBIDDEN_SUBMODULES = {
    "numpy.ctypeslib",
    "numpy.distutils",
    "numpy.f2py",
    "numpy.testing",
    "PIL.ImageShow",
    "PIL.ImageGrab",
    "PIL.ImageTk",
    "PIL.ImageQt",
}
FORBIDDEN_NAMES = {
    "eval",
    "exec",
    "compile",
    "__import__",
    "open",
    "globals",
    "locals",
    "vars",
    "getattr",
    "setattr",
    "delattr",
    "breakpoint",
    "input",
    "exit",
    "quit",
    "help",
    "__builtins__",
    "__loader__",
    "__spec__",
}
FORBIDDEN_ATTRIBUTES = {
    # escapes through the object model
    "__class__",
    "__bases__",
    "__base__",
    "__mro__",
    "__subclasses__",
    "__globals__",
    "__builtins__",
    "__code__",
    "__closure__",
    "__dict__",
    "__getattribute__",
    "__import__",
    "__loader__",
    "__spec__",
    "__reduce__",
    "__reduce_ex__",
    "__self__",
    "__func__",
    "__wrapped__",
    "f_globals",
    "f_locals",
    "f_back",
    "f_builtins",
    "gi_frame",
    "cr_frame",
    "tb_frame",
    # processes, native code, devices, servers, viewers
    "system",
    "popen",
    "fork",
    "forkpty",
    "kill",
    "killpg",
    "execv",
    "execve",
    "execl",
    "execle",
    "execlp",
    "execlpe",
    "execvp",
    "execvpe",
    "spawnl",
    "spawnle",
    "spawnlp",
    "spawnlpe",
    "spawnv",
    "spawnve",
    "spawnvp",
    "spawnvpe",
    "posix_spawn",
    "posix_spawnp",
    "ctypeslib",
    "load_library",
    "VideoCapture",
    "VideoWriter",
    "imshow",
    "namedWindow",
    "waitKey",
    "show",
    "listen",
    "bind",
    "accept",
    "serve_forever",
}
MAX_PROGRAM_BYTES = 200_000


def check_program(source):
    """Problems of a program (English, one per finding); [] when it may run."""
    problems = []
    if len(source.encode("utf-8")) > MAX_PROGRAM_BYTES:
        return ["the program is longer than %d bytes" % MAX_PROGRAM_BYTES]
    try:
        tree = ast.parse(source, filename="program.py")
    except SyntaxError as e:
        return ["syntax error at line %s: %s" % (e.lineno, e.msg)]
    os_names = set()

    def allowed(module):
        if module in FORBIDDEN_SUBMODULES or any(module.startswith(m + ".") for m in FORBIDDEN_SUBMODULES):
            return False
        if module == OS_PATH or module.startswith(OS_PATH + "."):
            return True
        return module.split(".")[0] in ALLOWED_MODULES

    for node in ast.walk(tree):
        line = getattr(node, "lineno", "?")
        if isinstance(node, ast.Import):
            for alias in node.names:
                if not allowed(alias.name):
                    problems.append("line %s: import of %r is not allowed" % (line, alias.name))
                elif alias.name.startswith("os.") and alias.asname is None:
                    os_names.add("os")
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            if node.level:
                problems.append("line %s: relative imports are not allowed" % line)
            elif module == "os":
                for alias in node.names:
                    if alias.name != "path":
                        problems.append("line %s: from os import %s is not allowed (only os.path)" % (line, alias.name))
            elif not allowed(module):
                problems.append("line %s: import from %r is not allowed" % (line, module))
            else:
                for alias in node.names:
                    if alias.name == "*" and module.split(".")[0] not in ("math", "studio_brand"):
                        problems.append("line %s: from %s import * is not allowed" % (line, module))
                    full = module + "." + alias.name
                    if full in FORBIDDEN_SUBMODULES:
                        problems.append("line %s: import of %r is not allowed" % (line, full))
                    if alias.name in FORBIDDEN_ATTRIBUTES or alias.name in FORBIDDEN_NAMES:
                        problems.append("line %s: importing %r is not allowed" % (line, alias.name))
        elif isinstance(node, ast.Name):
            if node.id in FORBIDDEN_NAMES:
                problems.append("line %s: %r is not allowed" % (line, node.id))
        elif isinstance(node, ast.Attribute):
            if node.attr in FORBIDDEN_ATTRIBUTES:
                problems.append("line %s: .%s is not allowed" % (line, node.attr))
            if isinstance(node.value, ast.Name) and node.value.id in os_names and node.attr != "path":
                problems.append("line %s: os.%s is not allowed (only os.path)" % (line, node.attr))
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            pass
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            if "__" in node.value and any(a in node.value for a in ("__class__", "__subclasses__", "__globals__", "__builtins__", "__import__")):
                problems.append("line %s: dunder names in strings are not allowed" % line)
    # One finding per line and kind is enough for the model.
    seen = []
    for p in problems:
        if p not in seen:
            seen.append(p)
    return seen[:40]


def _limit_resources():
    try:
        import resource

        mb = 1024 * 1024
        resource.setrlimit(resource.RLIMIT_FSIZE, (64 * mb, 64 * mb))
        cpu = int(os.environ.get("STUDIO_CODE_CPU_S", "90"))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 5))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        # No child processes (the sandbox refuses them too).
        resource.setrlimit(resource.RLIMIT_NPROC, (0, 0))
    except (ImportError, ValueError, OSError):
        pass


def main(argv):
    if len(argv) == 3 and argv[1] == "--check":
        with open(argv[2], "r", encoding="utf-8") as fh:
            problems = check_program(fh.read())
        sys.stdout.write(json.dumps({"ok": not problems, "problems": problems}) + "\n")
        return 0
    if len(argv) != 4:
        sys.stderr.write("usage: run.py <lib dir> <input.json> <program.py>\n")
        return 2
    lib_dir, input_path, program_path = argv[1], argv[2], argv[3]
    with open(program_path, "r", encoding="utf-8") as fh:
        source = fh.read()
    problems = check_program(source)
    if problems:
        sys.stderr.write("@@STUDIO_CHECK@@ " + json.dumps({"problems": problems}) + "\n")
        return 3
    _limit_resources()
    os.environ["STUDIO_CODE_INPUT"] = input_path
    sys.path.insert(0, lib_dir)
    sys.argv = ["program.py"]
    code = compile(source, "program.py", "exec")
    scope = {"__name__": "__main__", "__file__": "program.py"}
    try:
        exec(code, scope)
    except SystemExit as e:
        return int(e.code or 0) if isinstance(e.code, int) else 1
    except BaseException:
        etype, value, tb = sys.exc_info()
        # Only the program's frames (and the helper's) matter to the model.
        frames = [
            f
            for f in traceback.extract_tb(tb)
            if f.filename in ("program.py",) or f.filename.endswith("studio_brand.py")
        ]
        lines = ["Traceback (most recent call last):\n"]
        lines += traceback.format_list(frames[-12:])
        lines += traceback.format_exception_only(etype, value)
        sys.stderr.write("".join(lines))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
