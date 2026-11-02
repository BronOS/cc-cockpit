// Fixture consumer for the plugin-services e2e: uses service "greet" v1. It only declares and
// holds the handle; the e2e for calls and events extends it to report what it gets.
exports.activate = (ctx) => {
  const greet = ctx.services.use('greet')
  ctx.log.info('consumer ready ' + typeof greet.greet)
}
