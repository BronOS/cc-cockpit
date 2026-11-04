// Fixture plugin for the slots e2e (design-next §2): its panel "board" places one `agenda` slot above
// the panel's own page, with params only the provider sees. Placed again on every start (the host
// restarts when a plugin is enabled or disabled).
exports.activate = (ctx) => {
  ctx.panels.slots('board', [{ type: 'agenda', position: 'top', height: 90, params: { day: 'mon' } }])
}
