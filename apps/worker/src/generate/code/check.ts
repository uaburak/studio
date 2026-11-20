/**
 * The code engine's static pre-check in TypeScript (docs/URETIM-RESIM.md, Faz 4): the same
 * allow-list as `code-engine/run.py` (which checks the program's syntax tree inside the sandbox),
 * applied before anything is spawned so an obviously unsafe program never reaches Python. The
 * sandbox stays the real fence; this is the second (and third) layer.
 */

/** Modules a post program may import (`os` only as `os.path`). Kept equal to run.py. */
export const ALLOWED_MODULES = [
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
  "collections",
  "statistics",
  "textwrap",
  "unicodedata",
  "string",
  "re",
  "enum",
  "copy",
] as const;

const FORBIDDEN_SUBMODULES = [
  "numpy.ctypeslib",
  "numpy.distutils",
  "numpy.f2py",
  "numpy.testing",
  "PIL.ImageShow",
  "PIL.ImageGrab",
  "PIL.ImageTk",
  "PIL.ImageQt",
];

/** Calls that are never needed to draw (built-ins, not methods: `Image.open` is fine). */
const FORBIDDEN_CALLS = [
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
];

const FORBIDDEN_TOKENS: [RegExp, string][] = [
  [
    /\b__(?:class|bases|base|mro|subclasses|globals|builtins|code|closure|dict|getattribute|loader|spec|self|func|wrapped)__\b/,
    "dunder escapes",
  ],
  [/\bsubprocess\b/, "subprocess"],
  [/\bctypes(?:lib)?\b/, "ctypes"],
  [/\bsocket(?:server)?\b/, "sockets"],
  [/\bos\s*\.\s*(?!path\b)[A-Za-z_]\w*/, "os (only os.path)"],
  [
    /\.(?:system|popen|fork|forkpty|kill|killpg|execv|execve|execvp|execl|spawn\w*|posix_spawnp?)\s*\(/,
    "processes",
  ],
  [/\.(?:VideoCapture|VideoWriter|imshow|namedWindow|waitKey|show)\s*\(/, "devices and viewers"],
  [/\.(?:listen|bind|accept|serve_forever)\s*\(/, "servers"],
];

function allowedModule(name: string): boolean {
  if (FORBIDDEN_SUBMODULES.some((m) => name === m || name.startsWith(`${m}.`))) return false;
  if (name === "os.path" || name.startsWith("os.path.")) return true;
  return (ALLOWED_MODULES as readonly string[]).includes(name.split(".")[0] ?? "");
}

/** Strings and comments blanked out (so a word in a headline is not an import). */
function codeOnly(source: string): string {
  return source.replace(
    /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|#[^\n]*)/g,
    (m) => (m.startsWith("#") ? "" : m.replace(/[^\n]/g, " ")),
  );
}

/** Problems of a program (English, for the model); [] when it may go to the sandbox. */
export function precheckProgram(source: string): string[] {
  const problems: string[] = [];
  if (Buffer.byteLength(source, "utf8") > 200_000)
    return ["the program is longer than 200000 bytes"];
  const code = codeOnly(source);
  const lines = code.split("\n");
  for (const [i, line] of lines.entries()) {
    const n = i + 1;
    const imp = /^\s*import\s+(.+)$/.exec(line);
    if (imp?.[1]) {
      for (const part of imp[1].split(",")) {
        const name =
          part
            .trim()
            .split(/\s+as\s+/)[0]
            ?.trim() ?? "";
        if (name && !allowedModule(name))
          problems.push(`line ${n}: import of '${name}' is not allowed`);
      }
    }
    const from = /^\s*from\s+(\S+)\s+import\s+(.+)$/.exec(line);
    if (from?.[1]) {
      const module = from[1];
      if (module.startsWith(".")) problems.push(`line ${n}: relative imports are not allowed`);
      else if (module === "os") {
        if (!/^\(?\s*path\b/.test(from[2] ?? ""))
          problems.push(`line ${n}: from os import … is not allowed (only os.path)`);
      } else if (!allowedModule(module))
        problems.push(`line ${n}: import from '${module}' is not allowed`);
    }
    for (const call of FORBIDDEN_CALLS) {
      if (new RegExp(`(?<![.\\w])${call}\\s*\\(`).test(line))
        problems.push(`line ${n}: '${call}' is not allowed`);
    }
    for (const [re, what] of FORBIDDEN_TOKENS) {
      if (re.test(line)) problems.push(`line ${n}: ${what} are not allowed`);
    }
  }
  return [...new Set(problems)].slice(0, 40);
}
