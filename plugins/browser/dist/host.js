var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/host.ts
var host_exports = {};
__export(host_exports, {
  activate: () => activate,
  resolveTarget: () => resolveTarget
});
module.exports = __toCommonJS(host_exports);
var PANEL = "view";
var BARE_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[::1\]):\d+([/?#]|$)/i;
function resolveTarget(raw, cwd) {
  const text = raw.trim();
  if (text === "") return { error: "usage: browser open <url|file>" };
  if (/^https?:\/\//i.test(text)) return { target: text };
  if (BARE_HOST.test(text)) return { target: `http://${text}` };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    return { error: `only http(s) URLs and file paths can be shown, not ${text.slice(0, text.indexOf(":"))}: (give a file as a path)` };
  }
  if (text.startsWith("/")) return { target: text };
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return { target: `${base}${text}` };
}
var failure = (err) => ({
  stderr: `${err instanceof Error ? err.message : String(err)}
`,
  code: 1
});
var isHttp = (text) => /^https?:\/\//i.test(text);
function activate(ctx) {
  const home = String(ctx.settings.app.home ?? "").trim();
  if (home !== "") {
    if (isHttp(home)) void ctx.webview.navigate(PANEL, home).catch((err) => ctx.log.warn("home page:", String(err)));
    else ctx.log.warn("the home setting must be an http(s) URL; ignored");
  }
  ctx.cli.register("browser", async (argv, call) => {
    const [sub, ...rest] = argv;
    if (sub === "open") {
      const [raw] = rest;
      if (rest.length !== 1 || raw === void 0) return { stderr: "usage: browser open <url|file>\n", code: 2 };
      const resolved = resolveTarget(raw, call.cwd);
      if ("error" in resolved) return { stderr: `${resolved.error}
`, code: 2 };
      try {
        await ctx.webview.navigate(PANEL, resolved.target);
      } catch (err) {
        const page = await ctx.webview.current(PANEL).catch(() => void 0);
        if (page?.error !== void 0) ctx.panels.show(PANEL);
        return failure(err);
      }
      ctx.panels.show(PANEL);
      return { stdout: "ok\n" };
    }
    if (sub === "url") {
      try {
        const page = await ctx.webview.current(PANEL);
        if (page.url === "") return { stdout: "blank\n" };
        if (page.error !== void 0) return { stdout: `${page.url}	failed to load: ${page.error}
` };
        return { stdout: `${page.url}	${page.title}
` };
      } catch (err) {
        return failure(err);
      }
    }
    if (sub === "reload") {
      try {
        await ctx.webview.reload(PANEL);
        return { stdout: "ok\n" };
      } catch (err) {
        return failure(err);
      }
    }
    return { stderr: "usage: browser open <url|file> | browser url | browser reload\n", code: 2 };
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  resolveTarget
});
