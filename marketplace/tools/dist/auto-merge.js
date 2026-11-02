// src/auto-merge.ts
var import_node_fs = require("node:fs");
var import_node_util = require("node:util");

// ../../src/shared/guards.ts
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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
var CORE_CLI_COMMANDS = ["open", "hook", "session", "overlay", "sessions", "notify", "guide", "plugin", "panel", "help"];
var RESERVED_CLI_NAMES = [...CORE_CLI_COMMANDS, "app", "config", "version"];
var MAX_CLI_COMMANDS = 10;
var SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
var SERVICE_VERSION_MIN = 1;
var SERVICE_VERSION_MAX = 9999;
var MAX_SERVICES = 32;
var MAX_PATH_LENGTH = 260;
var MAX_LIST = 100;
var relativePath = { type: "string", minLength: 1, maxLength: MAX_PATH_LENGTH };
var title = { type: "string", minLength: 1, maxLength: 100 };
var contributionId = { type: "string", pattern: CONTRIBUTION_ID_PATTERN.source };
var settingsSchema = { type: "object" };
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
    services: { type: "object", additionalProperties: false, properties: { provides: serviceMap, uses: serviceMap } },
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
        },
        // An object, not `true`: the title is what the person reads when picking the plugin that
        // opens files, and a later field (file kinds, say) has room here.
        openFile: { type: "object", required: ["title"], properties: { title } }
      }
    }
  }
};

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

// ../../src/shared/marketplace.ts
var DEFAULT_MARKETPLACE_URL = "https://raw.githubusercontent.com/BronOS/cc-cockpit-marketplace/main/index.json";
var STALE_AFTER_MS = 60 * 6e4;
var MAX_INDEX_BYTES = 5 * 1024 * 1024;
var MAX_INDEX_REVOCATIONS = 2e3;
var MAX_NAME_LENGTH = 100;
var MAX_AUTHOR_LENGTH = 100;
var MAX_DESCRIPTION_LENGTH = 1e3;
var MAX_REASON_LENGTH = 1e3;
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
function compareDigits(p, q) {
  const a = p.replace(/^0+(?=\d)/, "");
  const b = q.replace(/^0+(?=\d)/, "");
  if (a === b) return 0;
  return a.length !== b.length ? a.length < b.length ? -1 : 1 : a < b ? -1 : 1;
}
function compareVersions(a, b) {
  const parse = (v) => {
    const [core = "", pre] = v.split("+")[0].split(/-(.*)/s);
    return { nums: core.split("."), pre: pre === void 0 || pre === "" ? [] : pre.split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const p = x.nums[i] || "0";
    const q = y.nums[i] || "0";
    if (!/^\d+$/.test(p) || !/^\d+$/.test(q)) return 0;
    const d = compareDigits(p, q);
    if (d !== 0) return d;
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === void 0) return -1;
    if (q === void 0) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const d = compareDigits(p, q);
      if (d === 0) continue;
      return d;
    }
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

// src/common.ts
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
function runCli(main2) {
  main2(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof ToolError ? err.message : err);
    process.exitCode = 1;
  });
}

// src/auto-merge.ts
var BUMP_FIELDS = /* @__PURE__ */ new Set(["version", "tag", "commit", "api"]);
var DEFAULT_BRANCH = "main";
function resolvePullRequest(open, headSha, headRepo) {
  const matches = open.filter((pr) => pr.headSha === headSha && pr.headRepo === headRepo);
  return matches.length === 1 ? matches[0] : null;
}
function bumpedId(files) {
  const file = files[0];
  if (files.length !== 1 || file === void 0 || file.status !== "modified") return null;
  const match = /^plugins\/(.+)\.json$/.exec(file.filename);
  const id = match?.[1];
  if (id === void 0 || id.length > PLUGIN_ID_MAX_LENGTH || !PLUGIN_ID_PATTERN.test(id)) return null;
  return id;
}
function no(reason) {
  return { merge: false, reason };
}
function decideAutoMerge(input) {
  const { pr, files } = input;
  if (pr.draft) return no("the PR is a draft");
  if (pr.baseRef !== DEFAULT_BRANCH) return no("the PR does not target main");
  const id = bumpedId(files);
  if (id === null) return no("the PR is not a change to exactly one existing plugins/<id>.json");
  if (input.mainEntryText === null) return no("the entry does not exist on main");
  if (input.headEntryText === null) return no("the entry could not be read at the PR head");
  const onMain = parseSourceEntry(input.mainEntryText, DEFAULT_MARKETPLACE_URL);
  if (!onMain.ok) return no(`the entry on main is invalid: ${onMain.problem}`);
  const atHead = parseSourceEntry(input.headEntryText, DEFAULT_MARKETPLACE_URL);
  if (!atHead.ok) return no(`the entry in the PR is invalid: ${atHead.problem}`);
  if (onMain.entry.id !== id || atHead.entry.id !== id) return no("the id does not match the file name");
  if (!onMain.owners.includes(pr.authorId)) return no("the author is not an owner of this entry");
  const keys = /* @__PURE__ */ new Set([...Object.keys(onMain.raw), ...Object.keys(atHead.raw)]);
  for (const key of keys) {
    if (!BUMP_FIELDS.has(key) && !(0, import_node_util.isDeepStrictEqual)(onMain.raw[key], atHead.raw[key])) {
      return no(`the PR changes "${key}", which is not a version bump`);
    }
  }
  if (compareVersions(atHead.entry.version, onMain.entry.version) <= 0) return no("the version does not increase");
  if (input.revokedText === null) return no("revoked.json is missing on main");
  const revoked = parseRevoked(input.revokedText);
  if (!revoked.ok) return no(`revoked.json on main is invalid: ${revoked.problem}`);
  if (revoked.revoked.some((r) => r.commit === atHead.entry.commit)) return no("the commit is revoked");
  return { merge: true, id };
}
var API_BASE = "https://api.github.com";
var PER_PAGE = 100;
var MAX_PAGES = 100;
var COMPARE_FILE_CAP = 300;
var SHA_PATTERN = /^[0-9a-f]{40}$/;
function headers(gh, accept) {
  return { accept, authorization: `Bearer ${gh.token}`, "x-github-api-version": "2022-11-28", "user-agent": "cc-cockpit-marketplace" };
}
async function listAll(gh, path) {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}${path}${sep}per_page=${PER_PAGE}&page=${page}`, {
      headers: headers(gh, "application/vnd.github+json")
    });
    if (!res.ok) throw new ToolError(`auto-merge: GET ${path} answered ${res.status}`);
    const items = await res.json();
    if (!Array.isArray(items)) throw new ToolError(`auto-merge: GET ${path} did not answer a list`);
    all.push(...items);
    if (items.length < PER_PAGE) return all;
  }
  throw new ToolError(`auto-merge: GET ${path} has more than ${MAX_PAGES} pages`);
}
async function fileAt(gh, path, ref) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, {
    headers: headers(gh, "application/vnd.github.raw+json")
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new ToolError(`auto-merge: GET contents answered ${res.status}`);
  return res.text();
}
async function openPulls(gh) {
  const raw = await listAll(gh, `/pulls?state=open&base=${DEFAULT_BRANCH}`);
  return raw.flatMap((item) => toPullSummary(item) ?? []);
}
async function mainCommit(gh) {
  const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}/git/ref/heads/${DEFAULT_BRANCH}`, {
    headers: headers(gh, "application/vnd.github+json")
  });
  if (!res.ok) throw new ToolError(`auto-merge: GET the ${DEFAULT_BRANCH} ref answered ${res.status}`);
  const body = await res.json();
  const sha = isPlainObject(body) && isPlainObject(body.object) ? body.object.sha : void 0;
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) throw new ToolError(`auto-merge: the ${DEFAULT_BRANCH} ref has no commit`);
  return sha;
}
async function comparedFiles(gh, base, head) {
  if (!SHA_PATTERN.test(head)) throw new ToolError("auto-merge: the head is not a full commit hash");
  const res = await gh.fetch(`${API_BASE}/repos/${gh.repo}/compare/${base}...${head}`, {
    headers: headers(gh, "application/vnd.github+json")
  });
  if (!res.ok) throw new ToolError(`auto-merge: GET compare answered ${res.status}`);
  const body = await res.json();
  if (!isPlainObject(body) || !Array.isArray(body.files) || !Array.isArray(body.commits)) {
    throw new ToolError("auto-merge: GET compare did not answer a comparison");
  }
  if (body.files.length >= COMPARE_FILE_CAP || body.total_commits !== body.commits.length) return null;
  return body.files.map((item) => {
    const row = isPlainObject(item) ? item : {};
    return { filename: String(row.filename), status: String(row.status) };
  });
}
function toPullSummary(raw) {
  if (!isPlainObject(raw) || !isPlainObject(raw.user) || !isPlainObject(raw.head) || !isPlainObject(raw.base)) return null;
  const { number, draft } = raw;
  const authorId = raw.user.id;
  const headSha = raw.head.sha;
  const baseRef = raw.base.ref;
  if (typeof number !== "number" || typeof authorId !== "number" || typeof headSha !== "string" || typeof baseRef !== "string") return null;
  const repo = raw.head.repo;
  const headRepo = isPlainObject(repo) && typeof repo.full_name === "string" ? repo.full_name : null;
  return { number, draft: draft === true, authorId, headSha, headRepo, baseRef };
}
async function run(gh, headSha, headRepo) {
  const pr = resolvePullRequest(await openPulls(gh), headSha, headRepo);
  if (pr === null) return no("no single open PR has this head commit");
  const base = await mainCommit(gh);
  const files = await comparedFiles(gh, base, pr.headSha);
  if (files === null) return no("the comparison with main is too large to read whole");
  const id = bumpedId(files);
  const path = id === null ? null : `plugins/${id}.json`;
  const mainEntryText = path === null ? null : await fileAt(gh, path, base);
  const headEntryText = path === null ? null : await fileAt(gh, path, pr.headSha);
  const revokedText = path === null ? null : await fileAt(gh, "revoked.json", base);
  const decision = decideAutoMerge({ pr, files, mainEntryText, headEntryText, revokedText });
  return decision.merge ? { ...decision, number: pr.number, headEntryText, base } : decision;
}
function required(env, name) {
  const value = env[name];
  if (value === void 0 || value === "") throw new ToolError(`auto-merge: ${name} is not set`);
  return value;
}
async function main(_argv, env = process.env, fetchFn = fetch) {
  const gh = { repo: required(env, "GITHUB_REPOSITORY"), token: required(env, "GH_TOKEN"), fetch: fetchFn };
  const output = required(env, "GITHUB_OUTPUT");
  const result = await run(gh, required(env, "HEAD_SHA"), required(env, "HEAD_REPO"));
  if (!result.merge) {
    console.log(`auto-merge: left for a human: ${result.reason}`);
    (0, import_node_fs.appendFileSync)(output, "merge=false\n");
    return;
  }
  (0, import_node_fs.writeFileSync)(required(env, "ENTRY_FILE"), result.headEntryText);
  console.log(`auto-merge: PR ${String(result.number)} is a routine bump of ${result.id}`);
  (0, import_node_fs.appendFileSync)(output, `merge=true
number=${String(result.number)}
base=${result.base}
`);
}

// <stdin>
runCli(main);
