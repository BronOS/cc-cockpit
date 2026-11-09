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

// ../../src/shared/slots.ts
var SLOT_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
var MAX_PROVIDER_SLOTS = 10;
var MAX_PANEL_SLOT_TYPES = 4;
var SLOT_HEIGHT_MIN = 24;
var SLOT_HEIGHT_MAX = 600;
var MAX_SLOT_PARAMS_BYTES = 4 * 1024;

// ../../src/shared/manifest.ts
var PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z][a-z0-9-]*$/;
var PLUGIN_ID_MAX_LENGTH = 100;
var RESERVED_PLUGIN_ID_PREFIX = "cockpit.";
var RESERVED_PLUGIN_ID_MESSAGE = "ids starting with cockpit. are reserved for plugins that ship with the app";
function isReservedPluginId(id) {
  return id.normalize("NFKC").trim().toLowerCase().startsWith(RESERVED_PLUGIN_ID_PREFIX);
}
var PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
var CONTRIBUTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
var MAX_SKILLS = 10;
var CLI_NAME_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
var CORE_CLI_COMMANDS = ["open", "hook", "statusline", "session", "overlay", "sessions", "notify", "guide", "plugin", "panel", "help"];
var RESERVED_CLI_NAMES = [...CORE_CLI_COMMANDS, "app", "config", "version"];
var MAX_CLI_COMMANDS = 10;
var SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
var SERVICE_VERSION_MIN = 1;
var SERVICE_VERSION_MAX = 9999;
var MAX_SERVICES = 32;
var SETTINGS_PAGE_SCOPES = ["app", "project"];
var MAX_PATH_LENGTH = 260;
var MAX_LIST = 100;
var relativePath = { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH };
var title = { type: "string", minLength: 1, maxLength: 100 };
var contributionId = { type: "string", pattern: CONTRIBUTION_ID_PATTERN.source };
var settingsSchema = { type: "object" };
var slotType = { type: "string", pattern: SLOT_TYPE_PATTERN.source };
var slotHeight = { type: "integer", minimum: SLOT_HEIGHT_MIN, maximum: SLOT_HEIGHT_MAX };
var serviceMap = {
  type: "object",
  maxProperties: MAX_SERVICES,
  propertyNames: { pattern: SERVICE_NAME_PATTERN.source },
  additionalProperties: { type: "integer", minimum: SERVICE_VERSION_MIN, maximum: SERVICE_VERSION_MAX }
};
var MANIFEST_SCHEMA = {
  type: "object",
  required: ["id", "name", "version", "api"],
  properties: {
    id: { type: "string", maxLength: PLUGIN_ID_MAX_LENGTH, pattern: PLUGIN_ID_PATTERN.source },
    name: title,
    version: { type: "string", maxLength: 64, pattern: PLUGIN_VERSION_PATTERN.source },
    api: { type: "integer" },
    main: relativePath,
    // Strict inside, unlike the top level: a key the app does not know here (`description`, a
    // misspelt `provide`) is a declaration that silently does nothing, and the plugin host reads
    // only these two.
    // `collects`: the names this plugin reads from every provider (`ctx.services.useAll`); each must
    // also be in `uses` (validate.ts). Unknown to apps before 0.9.7, whose strict schema refuses it.
    services: {
      type: "object",
      additionalProperties: false,
      properties: {
        provides: serviceMap,
        uses: serviceMap,
        collects: { type: "array", maxItems: MAX_SERVICES, uniqueItems: true, items: { type: "string", pattern: SERVICE_NAME_PATTERN.source } }
      }
    },
    // Strict inside like `services`: a misspelt key (`session`) or value would be a declaration that
    // silently grants nothing, and the person reads this on the Plugins page.
    access: {
      type: "object",
      additionalProperties: false,
      properties: { sessions: { enum: ["all-windows"] } }
    },
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
              defaultZone: { enum: ["left", "right", "bottom"] },
              // App slot types are refused in validate.ts, with the reason.
              slots: { type: "array", maxItems: MAX_PANEL_SLOT_TYPES, uniqueItems: true, items: slotType }
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
          properties: {
            project: settingsSchema,
            app: settingsSchema,
            // The `.html` entry and `main` are checked in validate.ts, with the reason.
            page: {
              type: "object",
              required: ["entry", "scopes"],
              additionalProperties: false,
              properties: {
                entry: relativePath,
                scopes: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: [...SETTINGS_PAGE_SCOPES] } }
              }
            }
          }
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
              stdin: { type: "boolean" },
              stdinDash: { type: "boolean" }
            }
          }
        },
        // An object, not `true`: the title is what the person reads when picking the plugin that
        // opens files, and a later field (file kinds, say) has room here.
        openFile: { type: "object", required: ["title"], properties: { title } },
        // Duplicate types, `min > max`, the `.html` entry and `main` are checked in validate.ts.
        slots: {
          type: "array",
          maxItems: MAX_PROVIDER_SLOTS,
          items: {
            type: "object",
            required: ["type", "entry"],
            properties: { type: slotType, entry: relativePath, title, minHeight: slotHeight, maxHeight: slotHeight }
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
var SHA256_PATTERN = /^[0-9a-f]{64}$/;
var MARKETPLACE_CATEGORIES = ["integrations", "productivity", "ai", "developer", "appearance", "other"];
function isMarketplaceCategory(v) {
  return typeof v === "string" && MARKETPLACE_CATEGORIES.includes(v);
}
var MAX_PREVIEW_BYTES = 512 * 1024;
var PREVIEW_MIN_WIDTH = 640;
var PREVIEW_MIN_HEIGHT = 400;
var PREVIEW_MAX_WIDTH = 1600;
var PREVIEW_MAX_HEIGHT = 1e3;
var PREVIEW_FILE = "preview.png";
var PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
function previewPath(id, commit) {
  return `previews/${id}/${commit}.png`;
}
function hasPngSignature(bytes) {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}
function chunkType(bytes, at) {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}
function uint32(bytes, at) {
  return (bytes[at] << 24 >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}
function previewPngProblem(bytes) {
  if (bytes.length > MAX_PREVIEW_BYTES) return `the preview is over ${MAX_PREVIEW_BYTES / 1024} KiB`;
  if (!hasPngSignature(bytes)) return "the preview is not a PNG";
  if (bytes.length < 33 || uint32(bytes, 8) !== 13 || chunkType(bytes, 12) !== "IHDR") return "the preview has no IHDR chunk first";
  const width = uint32(bytes, 16);
  const height = uint32(bytes, 20);
  if (width < PREVIEW_MIN_WIDTH || width > PREVIEW_MAX_WIDTH || height < PREVIEW_MIN_HEIGHT || height > PREVIEW_MAX_HEIGHT) {
    return `the preview is ${width}x${height}; it must be ${PREVIEW_MIN_WIDTH}x${PREVIEW_MIN_HEIGHT} to ${PREVIEW_MAX_WIDTH}x${PREVIEW_MAX_HEIGHT} (1280x800 recommended)`;
  }
  let at = 8;
  for (; ; ) {
    if (at + 12 > bytes.length) return "the preview is truncated";
    const length = uint32(bytes, at);
    const type = chunkType(bytes, at + 4);
    const next = at + 12 + length;
    if (next > bytes.length) return "the preview is truncated";
    if (type === "acTL") return "the preview is animated (APNG); a still image is required";
    if (type === "IEND") return null;
    at = next;
  }
}
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
  const { id, name, description, author, repo, version, tag, commit, api, category, preview } = raw;
  if (typeof id !== "string" || id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id))
    return bad('"id" is not a valid plugin id');
  if (isReservedPluginId(id)) return bad(`"id": ${RESERVED_PLUGIN_ID_MESSAGE}`);
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
  const sha256 = isPlainObject(preview) && typeof preview.sha256 === "string" && SHA256_PATTERN.test(preview.sha256) ? preview.sha256 : null;
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
      api,
      category: isMarketplaceCategory(category) ? category : "other",
      ...sha256 !== null ? { preview: { sha256 } } : {}
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
var ENTRY_FIELDS = /* @__PURE__ */ new Set(["id", "name", "description", "author", "repo", "version", "tag", "commit", "api", "category", "owners"]);
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
  if (fields.category !== void 0 && !isMarketplaceCategory(fields.category)) {
    return { ok: false, problem: `"category" must be one of ${MARKETPLACE_CATEGORIES.join(", ")}` };
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
function noPreviewMarker(id, commit) {
  return `previews/${id}/${commit}.none`;
}
function failedPreviewMarker(id, commit) {
  return `previews/${id}/${commit}.failed`;
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
var MAX_PREVIEW_FETCHES = 20;
var PREVIEW_CLONE_TIMEOUT_MS = 6e4;
var PREVIEW_FETCH_BUDGET_MS = 10 * 6e4;
var PREVIEW_RETRY_AFTER_MS = 24 * 60 * 6e4;
var MAX_FAILED_MARKER_BYTES = 64;
function readPreview(dir) {
  const path = (0, import_node_path3.join)(dir, PREVIEW_FILE);
  const stats = (0, import_node_fs2.lstatSync)(path, { throwIfNoEntry: false });
  if (stats === void 0) return { missing: true };
  if (!stats.isFile()) return { problem: `${PREVIEW_FILE} is not a regular file` };
  if (stats.size > MAX_PREVIEW_BYTES) return { problem: `${PREVIEW_FILE}: the preview is over ${MAX_PREVIEW_BYTES / 1024} KiB` };
  const bytes = (0, import_node_fs2.readFileSync)(path);
  const problem = previewPngProblem(bytes);
  return problem === null ? { bytes } : { problem: `${PREVIEW_FILE}: ${problem}` };
}
function previewRequired(opts) {
  const from = opts.previewRequiredFrom;
  if (from === void 0 || from === null) return false;
  return (opts.now ?? (() => /* @__PURE__ */ new Date()))().toISOString().slice(0, 10) >= from;
}
function parseRequiredFrom(value) {
  if (value === void 0 || value === "none") return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(value) ? /* @__PURE__ */ new Date(`${value}T00:00:00Z`) : null;
  if (day === null || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
    throw new ToolError("check-entry: --preview-required-from must be YYYY-MM-DD or none");
  }
  return value;
}
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
async function inspectEntry(entry, opts = {}) {
  const parent = (0, import_node_fs2.mkdtempSync)((0, import_node_path3.join)((0, import_node_os.tmpdir)(), "check-entry-"));
  try {
    const dest = (0, import_node_path3.join)(parent, "repo");
    const clone = await runGit(cloneArgs(entry.repo, entry.tag, dest), parent, opts);
    if (clone.code !== 0) {
      return {
        problems: [`could not clone tag ${quoted(entry.tag)} of ${quoted(entry.repo)}: the repo is not public, or the tag does not exist`],
        warnings: [],
        preview: null,
        atCommit: false
      };
    }
    const head = await runGit(["rev-parse", "--verify", "HEAD"], dest, opts);
    const commit = head.stdout.trim();
    const problems = [];
    const warnings = [];
    const atCommit = head.code === 0 && commit === entry.commit;
    if (!atCommit) problems.push(`the tag is at commit ${quoted(commit)}, the entry says ${quoted(entry.commit)}`);
    problems.push(...await manifestProblems(dest, entry));
    const preview = readPreview(dest);
    if ("problem" in preview) problems.push(preview.problem);
    else if ("missing" in preview) {
      if (previewRequired(opts)) problems.push(`there is no ${PREVIEW_FILE} at the tag: one is required since ${String(opts.previewRequiredFrom)}`);
      else {
        const when = opts.previewRequiredFrom ? `from ${opts.previewRequiredFrom}` : "soon";
        warnings.push(`there is no ${PREVIEW_FILE} at the tag: the listing shows a placeholder, and one will be required ${when}`);
      }
    }
    return { problems, warnings, preview: "bytes" in preview ? preview.bytes : null, atCommit };
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
  const refused = (problem) => ({ problems: [problem], warnings: [] });
  const parsed = parseSourceEntry(readRegularFile(path, MAX_ENTRY_BYTES), indexUrl);
  if (!parsed.ok) return refused(parsed.problem);
  if (expectedName !== void 0 && expectedName !== `${parsed.entry.id}.json`) return refused("the file name must be the id plus .json");
  const retag = basePath === void 0 ? null : retagProblem(basePath, parsed.entry, indexUrl);
  if (retag !== null) return refused(retag);
  const { problems, warnings } = await inspectEntry(parsed.entry, opts);
  return { problems, warnings };
}
function recentlyFailed(path, now) {
  if (!(0, import_node_fs2.existsSync)(path)) return false;
  let at;
  try {
    at = Date.parse(readRegularFile(path, MAX_FAILED_MARKER_BYTES).trim());
  } catch {
    return false;
  }
  const age = now.getTime() - at;
  return !Number.isNaN(at) && age >= 0 && age < PREVIEW_RETRY_AFTER_MS;
}
async function fetchPreviews(root, out, indexUrl, opts = {}) {
  const log = [];
  const now = opts.now ?? (() => /* @__PURE__ */ new Date());
  const cloneOpts = { ...opts, timeoutMs: opts.timeoutMs ?? PREVIEW_CLONE_TIMEOUT_MS };
  const budgetMs = opts.budgetMs ?? PREVIEW_FETCH_BUDGET_MS;
  const started = now().getTime();
  let fetched = 0;
  for (const name of listEntryFiles((0, import_node_path3.join)(root, "plugins"))) {
    let parsed;
    try {
      parsed = parseSourceEntry(readRegularFile(entryPath(root, name), MAX_ENTRY_BYTES), indexUrl);
    } catch {
      continue;
    }
    if (!parsed.ok || name !== `${parsed.entry.id}.json`) continue;
    const { id, commit } = parsed.entry;
    if ((0, import_node_fs2.existsSync)((0, import_node_path3.join)(root, previewPath(id, commit))) || (0, import_node_fs2.existsSync)((0, import_node_path3.join)(root, noPreviewMarker(id, commit)))) continue;
    if (recentlyFailed((0, import_node_path3.join)(root, failedPreviewMarker(id, commit)), now())) continue;
    if (fetched >= MAX_PREVIEW_FETCHES) {
      log.push(`more than ${MAX_PREVIEW_FETCHES} previews to fetch: the rest wait for the next run`);
      break;
    }
    if (now().getTime() - started >= budgetMs) {
      log.push(`out of time for this run: the rest wait for the next run`);
      break;
    }
    fetched++;
    const seen = await inspectEntry(parsed.entry, cloneOpts);
    if (!seen.atCommit) {
      const marker = (0, import_node_path3.join)(out, failedPreviewMarker(id, commit));
      (0, import_node_fs2.mkdirSync)((0, import_node_path3.join)(marker, ".."), { recursive: true });
      (0, import_node_fs2.writeFileSync)(marker, `${now().toISOString()}
`);
      log.push(`${quoted(name)}: not fetched, the tag is not at the pinned commit or could not be cloned; retried in a day`);
      continue;
    }
    const target = (0, import_node_path3.join)(out, seen.preview !== null ? previewPath(id, commit) : noPreviewMarker(id, commit));
    (0, import_node_fs2.mkdirSync)((0, import_node_path3.join)(target, ".."), { recursive: true });
    (0, import_node_fs2.writeFileSync)(target, seen.preview ?? "");
    log.push(`${quoted(name)}: ${seen.preview !== null ? "preview fetched" : "no usable preview at this commit"}`);
  }
  return log;
}
async function main(argv, opts = {}) {
  const flags = parseFlags(argv, ["--entry", "--base", "--head", "--index-url", "--preview-required-from", "--fetch-previews", "--out"]);
  const indexUrl = flags.get("--index-url") ?? DEFAULT_MARKETPLACE_URL;
  const file = flags.get("--entry");
  const base = flags.get("--base");
  const head = flags.get("--head");
  const fetchRoot = flags.get("--fetch-previews");
  const out = flags.get("--out");
  const checkOpts = { ...opts, previewRequiredFrom: parseRequiredFrom(flags.get("--preview-required-from")) };
  const problems = [];
  const warnings = [];
  if (fetchRoot !== void 0 && out !== void 0) {
    for (const line of await fetchPreviews(fetchRoot, out, indexUrl, opts)) console.log(`check-entry: ${line}`);
    return;
  } else if (file !== void 0) {
    const found = await checkFile(file, indexUrl, checkOpts);
    problems.push(...found.problems.map((p) => `check-entry: ${p}`));
    warnings.push(...found.warnings);
  } else if (base !== void 0 && head !== void 0) {
    const names = changedEntryFiles(base, head);
    if (names.length > MAX_CHANGED_ENTRIES) throw new ToolError(`check-entry: a PR may change at most ${MAX_CHANGED_ENTRIES} entries`);
    for (const name of names) {
      const found = await checkFile(entryPath(head, name), indexUrl, checkOpts, name, entryPath(base, name));
      problems.push(...found.problems.map((p) => `check-entry: ${quoted(name)}: ${p}`));
      warnings.push(...found.warnings.map((w) => `${quoted(name)}: ${w}`));
    }
  } else {
    throw new ToolError(
      "usage: check-entry --entry <file> | --base <dir> --head <dir> [--preview-required-from <YYYY-MM-DD|none>] | --fetch-previews <dir> --out <dir> [--index-url <url>]"
    );
  }
  for (const warning of warnings) console.log(`::warning::check-entry: ${warning}`);
  if (problems.length > 0) throw new ToolError(problems.join("\n"));
  console.log("check-entry: ok");
}

// <stdin>
runCli(main);
