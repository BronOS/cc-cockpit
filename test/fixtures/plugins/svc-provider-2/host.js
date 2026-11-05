// Fixture provider for the plugin-services e2e: offers service "greet" v1. Its answers carry
// "two" so a test can tell which of two providers answered. `greet` also emits a "greeted" event.
exports.activate = (ctx) => {
  ctx.services.provide('greet', {
    greet: (name) => {
      ctx.services.emit('greet', 'greeted', { name, by: 'two' })
      // Feed-shaped events (inbox-feed v2): item, gone and sync, each carrying the sender's marker.
      ctx.services.emit('greet', 'item', { id: 'x-two', by: 'two' })
      ctx.services.emit('greet', 'gone', { id: 'x-two', by: 'two' })
      ctx.services.emit('greet', 'sync', { by: 'two' })
      return 'hello ' + name + ' from two'
    }
  })
}
