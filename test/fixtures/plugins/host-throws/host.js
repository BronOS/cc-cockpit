// Fixture plugin for the plugin-host e2e: activation fails, which must mark only this plugin.
exports.activate = () => {
  throw new Error('fixture boom')
}
