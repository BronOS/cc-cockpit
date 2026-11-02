// Fixture provider for the plugin-services e2e: offers service "greet" v1. Its answers carry
// "two" so a test can tell which of two providers answered. `greet` also emits a "greeted" event.
exports.activate = (ctx) => {
  ctx.services.provide('greet', {
    greet: (name) => {
      ctx.services.emit('greet', 'greeted', { name, by: 'two' })
      return 'hello ' + name + ' from two'
    }
  })
}
