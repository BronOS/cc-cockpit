// Fixture plugin for the plugin CLI e2e (plan B Task 5): `ccc demo …` and `ccc demo-in` are routed
// by main to the handlers below, and their output and exit code come back to the caller.
exports.activate = (ctx) => {
  ctx.cli.register('demo', (argv, call) => {
    const [sub, ...rest] = argv
    if (sub === 'echo') return { stdout: `${rest.join(' ')}\n` }
    if (sub === 'fail') return { stderr: 'demo failed on purpose\n', code: 3 }
    if (sub === 'cwd') return { stdout: `${call.cwd}\n` }
    if (sub === 'throw') throw new Error('fixture boom')
    // Both streams larger than a pipe's buffer: the CLI must write them out before it exits.
    if (sub === 'big') return { stdout: 'o'.repeat(200000), stderr: 'e'.repeat(200000), code: 4 }
    return { stderr: `unknown: ${sub}\n`, code: 2 }
  })
  ctx.cli.register('demo-in', (_argv, call) => ({ stdout: call.stdin }))
}
