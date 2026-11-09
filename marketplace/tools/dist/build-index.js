// src/build-index.ts
var import_node_crypto = require("node:crypto");
var import_node_fs2 = require("node:fs");
var import_node_path2 = require("node:path");

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

// ../../src/shared/marketplace.ts
var DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/BronOS/cc-cockpit-marketplace/main/index.json";
var MARKETPLACE_SCHEMA = 1;
var STALE_AFTER_MS = 60 * 6e4;
var MAX_INDEX_BYTES = 5 * 1024 * 1024;
var INDEX_TOO_LARGE = "the index is too large";
var MAX_INDEX_PLUGINS = 2e3;
var MAX_INDEX_REVOCATIONS = 2e3;
var MAX_NAME_LENGTH = 100;
var MAX_AUTHOR_LENGTH = 100;
var MAX_DESCRIPTION_LENGTH = 1e3;
var MAX_REASON_LENGTH = 1e3;
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
function parseRevocation(raw) {
  const bad = (problem) => ({ ok: false, problem });
  if (!isPlainObject(raw)) return bad("the row is not a JSON object");
  const { id, commit, reason } = raw;
  if (typeof id !== "string" || id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id))
    return bad('"id" is not a valid plugin id');
  if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit))
    return bad('"commit" must be the full 40-character lower-case hash');
  if (!boundedString(reason, MAX_REASON_LENGTH, true))
    return bad(`"reason" must be a text of at most ${MAX_REASON_LENGTH} characters`);
  return {
    ok: true,
    revocation: { id, commit, reason: reason.replace(UNSAFE_TEXT_ALL, " ") }
  };
}
function describeSchema(v) {
  if (v === void 0) return "missing";
  return typeof v === "number" ? String(v) : `of type ${typeof v}`;
}
function parseMarketplaceIndex(text, opts) {
  if (text.length > MAX_INDEX_BYTES)
    return { ok: false, error: INDEX_TOO_LARGE };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "the index is not valid JSON" };
  }
  if (!isPlainObject(data))
    return { ok: false, error: "the index is not a JSON object" };
  if (data.schema !== MARKETPLACE_SCHEMA) {
    return {
      ok: false,
      error: `unsupported index schema ${describeSchema(data.schema)}`
    };
  }
  if (!Array.isArray(data.plugins))
    return { ok: false, error: 'the index has no "plugins" list' };
  const rawRevoked = data.revoked === void 0 ? [] : data.revoked;
  if (!Array.isArray(rawRevoked))
    return { ok: false, error: 'the "revoked" field is not a list' };
  if (data.plugins.length > MAX_INDEX_PLUGINS)
    return { ok: false, error: `more than ${MAX_INDEX_PLUGINS} plugins` };
  if (rawRevoked.length > MAX_INDEX_REVOCATIONS) {
    return {
      ok: false,
      error: `more than ${MAX_INDEX_REVOCATIONS} revocations`
    };
  }
  const valid = [];
  let skippedEntries = 0;
  const counts = /* @__PURE__ */ new Map();
  for (const raw of data.plugins) {
    if (isPlainObject(raw) && typeof raw.id === "string")
      counts.set(raw.id, (counts.get(raw.id) ?? 0) + 1);
  }
  for (const raw of data.plugins) {
    const parsed = parseEntry(raw, opts.indexUrl);
    if (parsed.ok) valid.push(parsed.entry);
    else skippedEntries++;
  }
  const plugins = valid.filter((e) => counts.get(e.id) === 1);
  skippedEntries += valid.length - plugins.length;
  const revoked = [];
  let skippedRevocations = 0;
  for (const raw of rawRevoked) {
    const parsed = parseRevocation(raw);
    if (parsed.ok) revoked.push(parsed.revocation);
    else skippedRevocations++;
  }
  return {
    ok: true,
    index: { schema: MARKETPLACE_SCHEMA, plugins, revoked },
    skippedEntries,
    skippedRevocations
  };
}

// src/common.ts
var import_node_fs = require("node:fs");
var import_node_path = require("node:path");
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
function parseRevoked(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: "revoked.json is not valid JSON" };
  }
  if (!Array.isArray(raw)) return { ok: false, problem: "revoked.json is not a list" };
  if (raw.length > MAX_INDEX_REVOCATIONS) return { ok: false, problem: `revoked.json: more than ${MAX_INDEX_REVOCATIONS} revocations` };
  const revoked = [];
  for (const [i, row] of raw.entries()) {
    const parsed = parseRevocation(row);
    if (!parsed.ok) return { ok: false, problem: `revoked.json has an invalid row (${i + 1}): ${parsed.problem}` };
    revoked.push(parsed.revocation);
  }
  return { ok: true, revoked };
}
function readRegularFile(path, maxBytes) {
  const stats = (0, import_node_fs.lstatSync)(path);
  if (!stats.isFile()) throw new ToolError(`${quoted(path)} is not a regular file`);
  if (stats.size > maxBytes) throw new ToolError(`${quoted(path)} is too large`);
  return (0, import_node_fs.readFileSync)(path, "utf8");
}
function readRegularBytes(path, maxBytes) {
  const stats = (0, import_node_fs.lstatSync)(path);
  if (!stats.isFile()) throw new ToolError(`${quoted(path)} is not a regular file`);
  if (stats.size > maxBytes) throw new ToolError(`${quoted(path)} is too large`);
  return (0, import_node_fs.readFileSync)(path);
}
function listEntryFiles(pluginsDir) {
  if (!(0, import_node_fs.existsSync)(pluginsDir)) return [];
  return (0, import_node_fs.readdirSync)(pluginsDir).filter((name) => name.endsWith(".json")).sort();
}
function entryPath(root, name) {
  return (0, import_node_path.join)(root, "plugins", name);
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

// src/build-index.ts
var MAX_REVOKED_BYTES = MAX_INDEX_BYTES;
var PARTIAL_EXIT = 2;
function withPreview(root, bare) {
  const entry = bare;
  const path = (0, import_node_path2.join)(root, previewPath(entry.id, entry.commit));
  if (!(0, import_node_fs2.existsSync)(path)) return { entry: bare, warning: `${quoted(entry.id)}: no preview published for this commit` };
  let bytes;
  try {
    bytes = readRegularBytes(path, MAX_PREVIEW_BYTES);
  } catch (err) {
    return { entry: bare, warning: `${quoted(entry.id)}: the preview is not usable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const problem = previewPngProblem(bytes);
  if (problem !== null) return { entry: bare, warning: `${quoted(entry.id)}: the preview is not usable: ${problem}` };
  return { entry: { ...bare, preview: { sha256: (0, import_node_crypto.createHash)("sha256").update(bytes).digest("hex") } }, warning: null };
}
function publishedEntries(root, indexUrl) {
  const file = (0, import_node_path2.join)(root, "index.json");
  if (!(0, import_node_fs2.existsSync)(file)) return [];
  try {
    const parsed = parseMarketplaceIndex(readRegularFile(file, MAX_INDEX_BYTES), { indexUrl });
    return parsed.ok ? parsed.index.plugins : [];
  } catch {
    return [];
  }
}
function buildIndex(root, indexUrl = DEFAULT_MARKETPLACE_URL, base) {
  const revoked = parseRevoked(readRegularFile((0, import_node_path2.join)(root, "revoked.json"), MAX_REVOKED_BYTES));
  if (!revoked.ok) throw new ToolError(`build-index: ${revoked.problem}`);
  const problems = [];
  const inherited = [];
  const warnings = [];
  const plugins = [];
  const published = publishedEntries(root, indexUrl);
  for (const name of listEntryFiles((0, import_node_path2.join)(root, "plugins"))) {
    const label2 = `plugins/${quoted(name)}`;
    const refuse = (problem) => {
      const previous = published.find((e) => `${e.id}.json` === name);
      const line = `build-index: ${label2}: ${problem} (${previous ? "the published listing stays" : "not listed"})`;
      if (base !== void 0 && sameEntryFile(base, root, name)) inherited.push(line);
      else problems.push(line);
      if (previous) plugins.push(previous);
    };
    let text2;
    try {
      text2 = readRegularFile(entryPath(root, name), MAX_ENTRY_BYTES);
    } catch (err) {
      refuse(err instanceof Error ? err.message : String(err));
      continue;
    }
    const parsed = parseSourceEntry(text2, indexUrl);
    if (!parsed.ok) refuse(parsed.problem);
    else if (name !== `${parsed.entry.id}.json`) refuse("the file name must be the id plus .json");
    else {
      const listed = withPreview(root, parsed.entry);
      if (listed.warning !== null) warnings.push(`build-index: ${listed.warning}`);
      plugins.push(listed.entry);
    }
  }
  const text = `${JSON.stringify({ schema: MARKETPLACE_SCHEMA, plugins, revoked: revoked.revoked }, null, 2)}
`;
  if (Buffer.byteLength(text) > MAX_INDEX_BYTES) throw new ToolError("build-index: the index is over the size cap");
  const check = parseMarketplaceIndex(text, { indexUrl });
  if (!check.ok) throw new ToolError(`build-index: ${check.error}`);
  return { text, problems, inherited, warnings };
}
async function main(argv) {
  const flags = parseFlags(argv, ["--root", "--out", "--index-url", "--base"]);
  const root = flags.get("--root");
  const out = flags.get("--out");
  if (root === void 0 || out === void 0) throw new ToolError("usage: build-index --root <repo> --out <file> [--index-url <url>] [--base <checkout>]");
  const built = buildIndex(root, flags.get("--index-url"), flags.get("--base"));
  (0, import_node_fs2.writeFileSync)(out, built.text);
  if (built.warnings.length > 0) console.error(built.warnings.join("\n"));
  if (built.inherited.length > 0) console.error(built.inherited.map((line) => `already on the base, not failing: ${line}`).join("\n"));
  if (built.problems.length > 0) {
    console.error(built.problems.join("\n"));
    process.exitCode = PARTIAL_EXIT;
  }
}

// <stdin>
runCli(main);
