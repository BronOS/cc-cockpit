"use strict";
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
  activate: () => activate
});
module.exports = __toCommonJS(host_exports);
var PANEL = "main";
var CLICKS_KEY = "clicks";
function activate(ctx) {
  let clicks = 0;
  let greeting = readGreeting(ctx);
  const publish = () => {
    ctx.panels.post(PANEL, { type: "state", greeting, clicks });
  };
  const setClicks = async (value) => {
    clicks = value;
    ctx.badge(PANEL, clicks > 0 ? clicks : null);
    publish();
    await ctx.storage.set(CLICKS_KEY, clicks);
  };
  const loaded = ctx.storage.get(CLICKS_KEY).then((saved) => setClicks(saved ?? 0)).catch((err) => ctx.log.error("could not read the saved count", err));
  ctx.panels.onMessage(PANEL, (message) => {
    const type = typeof message === "object" && message !== null && !Array.isArray(message) ? message.type : void 0;
    void loaded.then(() => {
      if (type === "ready") publish();
      if (type === "click") return setClicks(clicks + 1);
      if (type === "reset") return setClicks(0);
      return void 0;
    }).catch((err) => ctx.log.error("could not save the count", err));
  });
  ctx.onSettingsChange(() => {
    greeting = readGreeting(ctx);
    publish();
  });
  ctx.commands.register("say-hello", () => ctx.notify(`${greeting}! ${clicks} clicks so far.`));
}
function readGreeting(ctx) {
  const value = ctx.settings.project.greeting;
  return typeof value === "string" ? value : "Hello";
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate
});
