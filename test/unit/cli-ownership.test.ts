// The plugin command ownership rule (plugins/cli-ownership.ts) on its own; installer.test.ts and
// bundled-plugins.test.ts cover how the installer feeds it (clash order, install/link refusals).
import { describe, expect, it } from 'vitest'
import { cliLossReason, settleCliNames } from '../../src/main/plugins/cli-ownership'

describe('settleCliNames', () => {
  it('gives each name to the first plugin that claims it', () => {
    const { owners, lost } = settleCliNames([
      { id: 'a.one', names: ['todo', 'notes'] },
      { id: 'b.two', names: ['mail'] }
    ])
    expect([...owners]).toEqual([
      ['todo', 'a.one'],
      ['notes', 'a.one'],
      ['mail', 'b.two']
    ])
    expect(lost.size).toBe(0)
  })

  it('makes a plugin with any taken name lose all of its names, naming the first one taken', () => {
    const { owners, lost } = settleCliNames([
      { id: 'a.one', names: ['todo'] },
      { id: 'b.two', names: ['mail', 'todo'] }
    ])
    expect(owners.get('mail')).toBeUndefined()
    expect(lost.get('b.two')).toEqual({ name: 'todo', owner: 'a.one' })
  })

  it('lets a loser block nobody: a later plugin gets a name only the loser had', () => {
    const { owners, lost } = settleCliNames([
      { id: 'a.one', names: ['todo'] },
      { id: 'b.two', names: ['todo', 'mail'] },
      { id: 'c.three', names: ['mail'] }
    ])
    expect(owners.get('mail')).toBe('c.three')
    expect([...lost.keys()]).toEqual(['b.two'])
  })

  it('ignores a plugin without names', () => {
    expect(settleCliNames([{ id: 'a.one', names: [] }]).lost.size).toBe(0)
  })
})

describe('cliLossReason', () => {
  it('names the command and the plugin to unlink', () => {
    expect(cliLossReason({ name: 'todo', owner: 'a.one' })).toBe('cli command "todo" is already provided by plugin a.one')
  })
})
