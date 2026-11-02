// src/check-entry.ts
var import_node_child_process = require("node:child_process");
var import_node_fs2 = require("node:fs");
var import_node_os = require("node:os");
var import_node_path3 = require("node:path");

// ../../src/shared/git-source.ts
var MAX_URL_LENGTH = 2e3;
var MAX_TAG_LENGTH = 200;
var GIT_TAG_PATTERN = /^[A-Za-z0-9._/-]+$/;
var SCP_URL = /^git@[A-Za-z0-9][A-Za-z0-9.-]*:(?!-)\S+$/;
function gitUrlProblem(url) {
  if (typeof url !== "string" || url === "") return "the URL is empty";
  if (url.length > MAX_URL_LENGTH) return `the URL is longer than ${MAX_URL_LENGTH} characters`;
  if (url.startsWith("-")) return 'the URL must not start with "-"';
  if (url.toLowerCase().startsWith("ext::")) return "ext:: URLs are not allowed";
  if (/[\s\x00-\x1f\x7f]/.test(url)) return "the URL must not contain whitespace or control characters";
  if (url.includes("\\")) return "the URL must not contain a backslash";
  if (url.startsWith("https://")) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return "the URL is not a valid https URL";
    }
    if (parsed.hostname === "") return "the URL has no host";
    if (parsed.username !== "" || parsed.password !== "") return "the URL must not contain credentials";
    return null;
  }
  if (url.startsWith("git@")) {
    return SCP_URL.test(url) ? null : "an ssh URL must look like git@host:owner/repo";
  }
  if (url.startsWith("file://")) {
    if (!url.startsWith("file:///")) return "a file URL must be file:///absolute/path";
    return null;
  }
  return "the URL must be https://\u2026, git@host:path or file:///path";
}
function gitTagProblem(tag) {
  if (typeof tag !== "string" || tag === "") return "the tag is empty";
  if (tag.length > MAX_TAG_LENGTH) return `the tag is longer than ${MAX_TAG_LENGTH} characters`;
  if (!GIT_TAG_PATTERN.test(tag)) return 'the tag may only contain letters, digits, ".", "_", "/" and "-"';
  if (tag.startsWith("-")) return 'the tag must not start with "-"';
  if (tag.includes("..")) return 'the tag must not contain ".."';
  return null;
}
function cloneArgs(url, tag, dest) {
  const transport = url.startsWith("https://") ? "https" : url.startsWith("file://") ? "file" : "ssh";
  return [
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.ext.allow=never",
    "-c",
    `protocol.file.allow=${transport === "file" ? "always" : "never"}`,
    "-c",
    `protocol.${transport}.allow=always`,
    "-c",
    "core.hooksPath=/dev/null",
    "clone",
    "--depth",
    "1",
    "--branch",
    tag,
    "--",
    url,
    dest
  ];
}
var GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_COMMON_DIR"
];
function gitEnv(base) {
  const env = { ...base };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  delete env.GIT_ALLOW_PROTOCOL;
  env.GIT_LFS_SKIP_SMUDGE = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

// ../../src/shared/guards.ts
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ../../src/shared/manifest.ts
var PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z][a-z0-9-]*$/;
var PLUGIN_ID_MAX_LENGTH = 100;
var PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
var CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
var MAX_SKILLS = 10;
var CLI_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
var CORE_CLI_COMMANDS = ["open", "hook", "session", "overlay", "sessions", "notify", "guide", "plugin", "help"];
var RESERVED_CLI_NAMES = [...CORE_CLI_COMMANDS, "app", "config", "version"];
var MAX_CLI_COMMANDS = 10;
var MAX_PATH_LENGTH = 260;
var MAX_LIST = 100;
var relativePath = { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH };
var title = { type: "string", minLength: 1, maxLength: 100 };
var contributionId = { type: "string", pattern: CONTRIBUTION_ID_PATTERN.source };
var settingsSchema = { type: "object" };
var MANIFEST_SCHEMA = {
  type: "object",
  required: ["id", "name", "version", "api"],
  properties: {
    id: { type: "string", maxLength: PLUGIN_ID_MAX_LENGTH, pattern: PLUGIN_ID_PATTERN.source },
    name: title,
    version: { type: "string", maxLength: 64, pattern: PLUGIN_VERSION_PATTERN.source },
    api: { type: "integer" },
    main: relativePath,
    contributes: {
      type: "object",
      properties: {
        panels: {
          type: "array",
          maxItems: MAX_LIST,
          items: {
            type: "object",
            required: ["id", "title"],
            properties: {
              id: contributionId,
              title,
              kind: { enum: ["html", "webview"] },
              icon: relativePath,
              entry: relativePath,
              defaultZone: { enum: ["left", "right", "bottom"] }
            },
            // A conditional, not `entry` dropped from `required`: an html panel (kind absent or
            // "html") still must name its page. The `if` needs `required: ['kind']`: `properties`
            // alone holds vacuously when `kind` is absent, which would forbid `entry` on every
            // existing manifest. validate.ts repeats both rules with readable messages.
            if: { required: ["kind"], properties: { kind: { const: "webview" } } },
            then: { not: { required: ["entry"] } },
            else: { required: ["entry"] }
          }
        },
        settings: {
          type: "object",
          properties: { project: settingsSchema, app: settingsSchema }
        },
        commands: {
          type: "array",
          maxItems: MAX_LIST,
          items: {
            type: "object",
            required: ["id", "title"],
            properties: { id: contributionId, title, key: { type: "string", minLength: 1, maxLength: 50 } }
          }
        },
        themes: {
          type: "array",
          maxItems: MAX_LIST,
          items: {
            type: "object",
            required: ["id", "file"],
            properties: { id: contributionId, file: relativePath }
          }
        },
        skills: {
          type: "array",
          maxItems: MAX_SKILLS,
          items: {
            type: "object",
            required: ["id", "dir"],
            properties: { id: { type: "string", pattern: SKILL_ID_PATTERN.source }, dir: relativePath }
          }
        },
        cli: {
          type: "array",
          maxItems: MAX_CLI_COMMANDS,
          items: {
            type: "object",
            required: ["name", "summary"],
            properties: {
              name: { type: "string", pattern: CLI_NAME_PATTERN.source },
              summary: { type: "string", minLength: 1, maxLength: 200 },
              usage: { type: "string", minLength: 1, maxLength: 500 },
              stdin: { type: "boolean" }
            }
          }
        }
      }
    }
  }
};
function relativePathProblem(p) {
  if (p === "") return "is empty";
  if (p.includes("\0")) return "contains a NUL byte";
  if (p.includes("\\")) return 'must use "/" separators';
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "must be relative to the plugin folder";
  const segments = p.split("/");
  if (segments.includes("..")) return 'must not contain ".." segments';
  if (segments.every((s) => s === "" || s === ".")) return "does not name a file";
  return null;
}

// ../../src/shared/marketplace.ts
var DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/BronOS/cc-cockpit-marketplace/main/index.json";
var STALE_AFTER_MS = 60 * 6e4;
var MAX_INDEX_BYTES = 5 * 1024 * 1024;
var MAX_NAME_LENGTH = 100;
var MAX_AUTHOR_LENGTH = 100;
var MAX_DESCRIPTION_LENGTH = 1e3;
var MAX_VERSION_LENGTH = 64;
var COMMIT_PATTERN = /^[0-9a-f]{40}$/;
var UNSAFE_TEXT = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
var UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, "g");
function label(v, max) {
  return boundedString(v, max) && v.trim() !== "" && !UNSAFE_TEXT.test(v);
}
function boundedString(v, max, allowEmpty = false) {
  return typeof v === "string" && v.length <= max && (allowEmpty || v !== "");
}
function marketplaceRepoProblem(repo, indexUrl) {
  const problem = gitUrlProblem(repo);
  if (problem !== null) return problem;
  const url = repo;
  if (url.startsWith("git@"))
    return "an ssh repo is not allowed in a marketplace";
  if (url.startsWith("file://") && !indexUrl.startsWith("file:"))
    return "a file: repo needs a file: index";
  if (!/^[\x21-\x7e]+$/.test(url))
    return "the repo URL must be plain ASCII (write an international host as xn--)";
  return null;
}
function parseEntry(raw, indexUrl) {
  const bad = (problem) => ({ ok: false, problem });
  if (!isPlainObject(raw)) return bad("the entry is not a JSON object");
  const { id, name, description, author, repo, version, tag, commit, api } = raw;
  if (typeof id !== "string" || id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id))
    return bad('"id" is not a valid plugin id');
  if (!label(name, MAX_NAME_LENGTH))
    return bad(
      `"name" must be 1 to ${MAX_NAME_LENGTH} characters, not blank, with no control or bidi characters`
    );
  if (!boundedString(description, MAX_DESCRIPTION_LENGTH, true) || UNSAFE_TEXT.test(description.replaceAll("\n", "")))
    return bad(
      `"description" must be at most ${MAX_DESCRIPTION_LENGTH} characters, with no control or bidi characters`
    );
  if (!label(author, MAX_AUTHOR_LENGTH))
    return bad(
      `"author" must be 1 to ${MAX_AUTHOR_LENGTH} characters, not blank, with no control or bidi characters`
    );
  const repoProblem = marketplaceRepoProblem(repo, indexUrl);
  if (repoProblem !== null) return bad(`"repo": ${repoProblem}`);
  if (typeof version !== "string" || version.length > MAX_VERSION_LENGTH || !PLUGIN_VERSION_PATTERN.test(version))
    return bad('"version" is not a valid plugin version');
  const tagProblem = gitTagProblem(tag);
  if (tagProblem !== null) return bad(`"tag": ${tagProblem}`);
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit))
    return bad('"commit" must be the full 40-character lower-case hash');
  if (typeof api !== "number" || !Number.isInteger(api) || api < 1)
    return bad('"api" must be a positive integer');
  return {
    ok: true,
    entry: {
      id,
      name,
      description,
      author,
      repo,
      version,
      tag,
      commit,
      api
    }
  };
}

// ../../src/main/path-within.ts
var import_node_path = require("node:path");
function within(parent, child) {
  const rel = (0, import_node_path.relative)(parent, child);
  return rel === "" || !rel.startsWith(`..${import_node_path.sep}`) && rel !== ".." && !(0, import_node_path.isAbsolute)(rel);
}

// src/common.ts
var import_node_fs = require("node:fs");
var import_node_path2 = require("node:path");
var MAX_ENTRY_BYTES = 64 * 1024;
var MAX_OWNERS = 50;
var ENTRY_FIELDS = /* @__PURE__ */ new Set(["id", "name", "description", "author", "repo", "version", "tag", "commit", "api", "owners"]);
var ToolError = class extends Error {
};
var MAX_QUOTED = 200;
function quoted(value) {
  const text = JSON.stringify(value) ?? "undefined";
  return text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)}\u2026` : text;
}
function parseSourceEntry(text, indexUrl) {
  if (text.length > MAX_ENTRY_BYTES) return { ok: false, problem: "the file is too large" };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "the file is not valid JSON" };
  }
  if (!isPlainObject(raw)) return { ok: false, problem: "the file is not a JSON object" };
  const unknown = Object.keys(raw).filter((key) => !ENTRY_FIELDS.has(key));
  if (unknown.length > 0) return { ok: false, problem: `unknown fields: ${quoted(unknown)}` };
  const { owners, ...fields } = raw;
  if (!Array.isArray(owners) || owners.length === 0 || owners.length > MAX_OWNERS || !owners.every((o) => Number.isSafeInteger(o) && o > 0)) {
    return { ok: false, problem: `"owners" must list 1 to ${MAX_OWNERS} numeric GitHub user ids` };
  }
  const parsed = parseEntry(fields, indexUrl);
  if (!parsed.ok) return parsed;
  return { ok: true, entry: parsed.entry, owners, raw };
}
function readRegularFile(path, maxBytes) {
  const stats = (0, import_node_fs.lstatSync)(path);
  if (!stats.isFile()) throw new ToolError(`${quoted(path)} is not a regular file`);
  if (stats.size > maxBytes) throw new ToolError(`${quoted(path)} is too large`);
  return (0, import_node_fs.readFileSync)(path, "utf8");
}
function listEntryFiles(pluginsDir) {
  if (!(0, import_node_fs.existsSync)(pluginsDir)) return [];
  return (0, import_node_fs.readdirSync)(pluginsDir).filter((name) => name.endsWith(".json")).sort();
}
function entryPath(root, name) {
  return (0, import_node_path2.join)(root, "plugins", name);
}
function sameEntryFile(base, head, name) {
  const basePath = entryPath(base, name);
  const headPath = entryPath(head, name);
  const before = (0, import_node_fs.lstatSync)(basePath, { throwIfNoEntry: false });
  const after = (0, import_node_fs.lstatSync)(headPath, { throwIfNoEntry: false });
  if (!before || !after || (before.mode & import_node_fs.constants.S_IFMT) !== (after.mode & import_node_fs.constants.S_IFMT)) return false;
  if (after.isSymbolicLink()) return (0, import_node_fs.readlinkSync)(basePath) === (0, import_node_fs.readlinkSync)(headPath);
  if (after.isFile()) return before.size === after.size && (0, import_node_fs.readFileSync)(basePath).equals((0, import_node_fs.readFileSync)(headPath));
  return true;
}
function parseFlags(argv, allowed) {
  const flags = /* @__PURE__ */ new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (!allowed.includes(name) || value === void 0) throw new ToolError(`usage: ${allowed.map((a) => `${a} <value>`).join(" ")}`);
    flags.set(name, value);
  }
  return flags;
}
function runCli(main2) {
  main2(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof ToolError ? err.message : err);
    process.exitCode = 1;
  });
}

// src/check-entry.ts
var GIT_TIMEOUT_MS = 12e4;
var MAX_MANIFEST_BYTES = 256 * 1024;
var MAX_CHANGED_ENTRIES = 20;
function runGit(args, cwd, opts) {
  return new Promise((done) => {
    (0, import_node_child_process.execFile)(
      "git",
      args,
      // `as` because gitEnv keeps the login-env shape, undefined values included, which execFile ignores.
      { cwd, env: gitEnv(opts.env ?? process.env), timeout: opts.timeoutMs ?? GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
        done({ code, stdout, stderr: err !== null && stderr === "" ? err.message : stderr });
      }
    );
  });
}
async function manifestProblems(dir, entry) {
  let manifest;
  try {
    manifest = JSON.parse(readRegularFile((0, import_node_path3.join)(dir, "plugin.json"), MAX_MANIFEST_BYTES));
  } catch {
    return ["plugin.json is missing, too large, a symlink or not valid JSON"];
  }
  if (!isPlainObject(manifest)) return ["plugin.json is not a JSON object"];
  const problems = [];
  for (const field of ["id", "version", "api"]) {
    if (manifest[field] !== entry[field]) {
      problems.push(`plugin.json ${field} is ${quoted(manifest[field])}, the entry says ${quoted(entry[field])}`);
    }
  }
  const main2 = manifest.main;
  if (main2 !== void 0) {
    const problem = typeof main2 === "string" ? relativePathProblem(main2) : "is not a string";
    if (problem !== null) problems.push(`plugin.json main ${problem}`);
    else if (main2.split(/[\\/]/)[0] === ".git") problems.push(`plugin.json main ${quoted(main2)} is inside .git, which is not installed`);
    else if (!await isFileInside(dir, main2)) problems.push(`plugin.json main ${quoted(main2)} is not a file in the repo at this tag`);
  }
  return problems;
}
async function isFileInside(dir, rel) {
  try {
    const root = await import_node_fs2.promises.realpath(dir);
    const real = await import_node_fs2.promises.realpath((0, import_node_path3.resolve)(root, rel));
    return within(root, real) && (await import_node_fs2.promises.stat(real)).isFile();
  } catch {
    return false;
  }
}
async function checkEntry(entry, opts = {}) {
  const parent = (0, import_node_fs2.mkdtempSync)((0, import_node_path3.join)((0, import_node_os.tmpdir)(), "check-entry-"));
  try {
    const dest = (0, import_node_path3.join)(parent, "repo");
    const clone = await runGit(cloneArgs(entry.repo, entry.tag, dest), parent, opts);
    if (clone.code !== 0) return [`could not clone tag ${quoted(entry.tag)} of ${quoted(entry.repo)}: the repo is not public, or the tag does not exist`];
    const head = await runGit(["rev-parse", "--verify", "HEAD"], dest, opts);
    const commit = head.stdout.trim();
    const problems = [];
    if (head.code !== 0 || commit !== entry.commit) problems.push(`the tag is at commit ${quoted(commit)}, the entry says ${quoted(entry.commit)}`);
    problems.push(...await manifestProblems(dest, entry));
    return problems;
  } finally {
    (0, import_node_fs2.rmSync)(parent, { recursive: true, force: true });
  }
}
function changedEntryFiles(base, head) {
  return listEntryFiles((0, import_node_path3.join)(head, "plugins")).filter((name) => !sameEntryFile(base, head, name));
}
function retagProblem(basePath, entry, indexUrl) {
  if (!(0, import_node_fs2.existsSync)(basePath)) return null;
  let text;
  try {
    text = readRegularFile(basePath, MAX_ENTRY_BYTES);
  } catch {
    return null;
  }
  const before = parseSourceEntry(text, indexUrl);
  if (!before.ok || before.entry.commit === entry.commit || before.entry.version.toLowerCase() !== entry.version.toLowerCase()) return null;
  return "a new commit needs a new version: installed copies cannot update to the version they already have";
}
async function checkFile(path, indexUrl, opts, expectedName, basePath) {
  const parsed = parseSourceEntry(readRegularFile(path, MAX_ENTRY_BYTES), indexUrl);
  if (!parsed.ok) return [parsed.problem];
  if (expectedName !== void 0 && expectedName !== `${parsed.entry.id}.json`) return ["the file name must be the id plus .json"];
  const retag = basePath === void 0 ? null : retagProblem(basePath, parsed.entry, indexUrl);
  if (retag !== null) return [retag];
  return checkEntry(parsed.entry, opts);
}
async function main(argv, opts = {}) {
  const flags = parseFlags(argv, ["--entry", "--base", "--head", "--index-url"]);
  const indexUrl = flags.get("--index-url") ?? DEFAULT_MARKETPLACE_URL;
  const file = flags.get("--entry");
  const base = flags.get("--base");
  const head = flags.get("--head");
  const problems = [];
  if (file !== void 0) {
    problems.push(...(await checkFile(file, indexUrl, opts)).map((p) => `check-entry: ${p}`));
  } else if (base !== void 0 && head !== void 0) {
    const names = changedEntryFiles(base, head);
    if (names.length > MAX_CHANGED_ENTRIES) throw new ToolError(`check-entry: a PR may change at most ${MAX_CHANGED_ENTRIES} entries`);
    for (const name of names) {
      const found = await checkFile(entryPath(head, name), indexUrl, opts, name, entryPath(base, name));
      problems.push(...found.map((p) => `check-entry: ${quoted(name)}: ${p}`));
    }
  } else {
    throw new ToolError("usage: check-entry --entry <file> | --base <dir> --head <dir> [--index-url <url>]");
  }
  if (problems.length > 0) throw new ToolError(problems.join("\n"));
  console.log("check-entry: ok");
}

// <stdin>
runCli(main);
