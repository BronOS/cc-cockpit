// Fixture provider for the plugin-services e2e: offers service "greet" v1. Its answers carry
// "one" so a test can tell which of two providers answered. `greet` also emits a "greeted" event.
exports.activate = (ctx) => {
  ctx.services.provide('greet', {
    greet: (name) => {
      ctx.services.emit('greet', 'greeted', { name, by: 'one' })
      // Feed-shaped events (inbox-feed v2): item, gone and sync, each carrying the sender's marker.
      ctx.services.emit('greet', 'item', { id: 'x-one', by: 'one' })
      ctx.services.emit('greet', 'gone', { id: 'x-one', by: 'one' })
      ctx.services.emit('greet', 'sync', { by: 'one' })
      return 'hello ' + name + ' from one'
    }
  })
}
