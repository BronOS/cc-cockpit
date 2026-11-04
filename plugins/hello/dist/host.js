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
  deactivate: () => deactivate
});
module.exports = __toCommonJS(host_exports);
var PANEL = "hello";
var isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
var errorText = (err) => err instanceof Error ? err.message : String(err);
var dispose = [];
function activate(ctx) {
  const state = {
    greeting: "",
    ticks: 0,
    visits: 0,
    sessions: [],
    git: null,
    lastSend: "",
    lastOverlay: "",
    tokenSet: false,
    bumps: null,
    secretKeys: [],
    secretError: ""
  };
  const greetingOf = (settings) => {
    const text = String(settings.project.greeting ?? "Hello");
    return settings.app.shout === true ? text.toUpperCase() : text;
  };
  state.greeting = greetingOf(ctx.settings);
  const tokenSetOf = (settings) => typeof settings.app.apiToken === "string" && settings.app.apiToken !== "";
  state.tokenSet = tokenSetOf(ctx.settings);
  const MAX_GIT_LINES = 200;
  const push = () => ctx.panels.post(PANEL, { type: "state", ...state });
  let stopTicking;
  const startTicking = (seconds) => {
    stopTicking?.();
    stopTicking = ctx.schedule(seconds, () => {
      state.ticks += 1;
      ctx.badge(PANEL, state.ticks);
      push();
    });
  };
  startTicking(Number(ctx.settings.project.tickSeconds ?? 10));
  dispose.push(() => stopTicking?.());
  let lastTick = Number(ctx.settings.project.tickSeconds ?? 10);
  dispose.push(
    ctx.onSettingsChange((settings) => {
      state.greeting = greetingOf(settings);
      state.tokenSet = tokenSetOf(settings);
      const seconds = Number(settings.project.tickSeconds ?? 10);
      if (seconds !== lastTick) {
        lastTick = seconds;
        startTicking(seconds);
      }
      push();
    })
  );
  const loadVisits = async () => {
    state.visits = (await ctx.storage.get("visits") ?? 0) + 1;
    await ctx.storage.set("visits", state.visits);
  };
  const BUMPS = "bumps";
  let bumping = false;
  const loadSecrets = async () => {
    try {
      const raw = await ctx.secrets.get(BUMPS);
      const n = raw === null ? NaN : Number(raw);
      state.bumps = Number.isInteger(n) && n >= 0 ? n : null;
      state.secretKeys = await ctx.secrets.keys();
      state.secretError = "";
    } catch (err) {
      state.secretError = errorText(err);
    }
  };
  const changeSecret = async (change) => {
    try {
      await change();
    } catch (err) {
      state.secretError = errorText(err);
      return;
    }
    await loadSecrets();
  };
  const refreshGit = async () => {
    try {
      const result = await ctx.exec(["git", "status", "--short"], { timeoutMs: 15e3 });
      const all = result.stdout.split("\n").filter(Boolean);
      const lines = all.length > MAX_GIT_LINES ? [...all.slice(0, MAX_GIT_LINES), `... ${all.length - MAX_GIT_LINES} more`] : all;
      state.git = result.code === 0 ? { lines } : { error: result.stderr.trim() || `git exited with ${result.code}` };
    } catch (err) {
      state.git = { error: errorText(err) };
    }
  };
  const setSessions = (list) => {
    state.sessions = list.map((s) => ({ tabId: s.tabId, status: s.status, lastPrompt: s.lastPrompt ?? "" }));
  };
  dispose.push(
    ctx.sessions.onChange((list) => {
      setSessions(list);
      push();
    })
  );
  const describe = (result) => {
    switch (result.kind) {
      case "exit":
        return `terminal overlay exited with ${result.code}`;
      case "value":
        return `html overlay answered ${JSON.stringify(result.value)}`;
      case "dismissed":
        return "overlay dismissed";
      case "discussed":
        return "overlay discussed with Claude";
    }
  };
  const openOverlay = async (kind) => {
    state.lastOverlay = `${kind} overlay open...`;
    push();
    try {
      const result = kind === "terminal" ? (
        // The program is a fixed script and the overlay closes when it ends, so it waits for Enter.
        // Never interpolate a file name or branch into this script: that is shell injection and
        // CLAUDE.md says exec is argv-only. Pass values as extra argv and read them as "$1".
        await ctx.overlay.open({
          kind: "terminal",
          argv: ["sh", "-c", 'git --no-pager status; printf "\\nPress Enter to close. "; read _'],
          title: "git status"
        })
      ) : await ctx.overlay.open({ kind: "html", file: "panels/pick.html", title: "Pick a colour" });
      state.lastOverlay = describe(result);
    } catch (err) {
      state.lastOverlay = `overlay failed: ${errorText(err)}`;
    }
    push();
  };
  dispose.push(
    ctx.panels.onMessage(PANEL, (message) => {
      if (!isObject(message)) return;
      switch (message.type) {
        case "ready":
          void (async () => {
            setSessions(await ctx.sessions.list());
            push();
          })().catch((err) => ctx.log.error("ready:", errorText(err)));
          break;
        case "git":
          void refreshGit().then(push);
          break;
        case "bump":
          if (bumping) break;
          bumping = true;
          void changeSecret(() => ctx.secrets.set(BUMPS, String((state.bumps ?? 0) + 1))).finally(() => {
            bumping = false;
          }).then(push);
          break;
        case "forget-bumps":
          void changeSecret(() => ctx.secrets.delete(BUMPS)).then(push);
          break;
        case "overlay":
          if (message.kind === "terminal" || message.kind === "html") void openOverlay(message.kind);
          break;
        case "reset":
          state.ticks = 0;
          ctx.badge(PANEL, null);
          push();
          break;
        case "send":
          if (typeof message.tabId === "string" && typeof message.text === "string") {
            ctx.sessions.send(message.tabId, message.text).then(
              (res) => {
                state.lastSend = "delivered" in res ? "delivered" : "queued";
                push();
              },
              (err) => {
                state.lastSend = `refused: ${errorText(err)}`;
                push();
              }
            );
          }
          break;
      }
    })
  );
  dispose.push(
    ctx.commands.register("say-hello", () => {
      return ctx.notify(`${state.greeting} from ${ctx.pluginId}`);
    })
  );
  void Promise.all([loadVisits(), loadSecrets(), refreshGit(), ctx.sessions.list().then(setSessions)]).then(push).catch((err) => ctx.log.error("startup:", errorText(err)));
}
function deactivate() {
  for (const d of dispose) d();
  dispose = [];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
