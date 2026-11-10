import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { rootAbsoluteUrls, rootAbsoluteUrlWarnings } from '../../src/shared/root-absolute-urls'

describe('rootAbsoluteUrls', () => {
  it('flags root-absolute src and href in HTML, quoted or bare', () => {
    const html = `<script src="/dist/x.js"></script><link href='/a.css'><img src=/i.png><script src=" /sp.js">`
    expect(rootAbsoluteUrls('html', html)).toEqual(['"/dist/x.js" (src)', '"/a.css" (href)', '"/i.png" (src)', '"/sp.js" (src)'])
  })

  it('flags srcset, poster, form action and entity-encoded slashes', () => {
    expect(rootAbsoluteUrls('html', '<img srcset="a.png 1x, /b.png 2x"><img imagesrcset=\'/c.png\'>')).toEqual(['"/b.png" (srcset)', '"/c.png" (srcset)'])
    const html = [
      '<video poster="/p.png">',
      '<form action="/submit">',
      '<script src="&#47;dist/e.js">',
      '<script src="&#x2F;dist/f.js">',
      '<script src="&sol;dist/g.js">'
    ].join('')
    const found = rootAbsoluteUrls('html', html)
    expect(found).toContain('"/p.png" (poster)')
    expect(found).toContain('"/submit" (action)')
    expect(found.filter((f) => f.includes('(src)'))).toHaveLength(3)
  })

  it('passes relative, protocol-relative, absolute and fragment URLs', () => {
    const html = `<script src="../__sdk/panel.js"></script><script src="./x.js"></script><script src="main.js"></script>
      <a href="#top"></a><a href="https://example.com/x"></a><img src="//cdn.example.com/x.png"><img srcset="a.png 1x, b.png 2x">`
    expect(rootAbsoluteUrls('html', html)).toEqual([])
  })

  it('flags a JS string that looks like an asset path, not other strings', () => {
    expect(rootAbsoluteUrls('js', `import('/dist/x.js'); fetch("/__sdk/panel.js")`)).toEqual(['"/dist/x.js" (script string)', '"/__sdk/panel.js" (script string)'])
    expect(rootAbsoluteUrls('js', `import('./x.js'); fetch('../data.json'); const re = /a\\/b.js/; const s = '/'; '//x.js'`)).toEqual([])
  })

  it('flags url() and @import in CSS', () => {
    expect(rootAbsoluteUrls('css', `a { background: url(/i.png) } b { background: url("/j.png") } @import "/x.css"; c { background: url(./k.png) url(//h/x.png) }`)).toEqual([
      '"/i.png" (css url())',
      '"/j.png" (css url())',
      '"/x.css" (css @import)'
    ])
  })

  it('looks at inline script in HTML for script strings', () => {
    expect(rootAbsoluteUrls('html', `<script>import('/dist/x.js')</script><p title="/dist/y.js"></p>`)).toEqual(['"/dist/x.js" (script string)'])
  })

  it('anchors an attribute at its start: data-href and data-srcset are not URLs the page loads', () => {
    expect(rootAbsoluteUrls('html', `<a data-href="/x" data-srcset="/y.png 1x" title="z"href="/ok"><img/src="/i.png"><b data-src="/d.png">`)).toEqual([
      '"/ok" (href)',
      '"/i.png" (src)',
      '"/d.png" (data-src)'
    ])
  })

  it('drops control characters from a reported URL (it reaches a workflow command)', () => {
    const found = rootAbsoluteUrls('js', `const u = '/x.js?\n::stop-commands::abc\r\n'`)
    expect(found).toEqual(['"/x.js?::stop-commands::abc" (script string)'])
  })

  it('finds inline scripts in linear time, with many openings and no closer', () => {
    // The old regex took about a minute on 2 MB of `<script>` (review finding).
    const started = Date.now()
    expect(rootAbsoluteUrls('html', '<script>'.repeat(256 * 1024))).toEqual([])
    expect(rootAbsoluteUrls('html', '<script '.repeat(256 * 1024))).toEqual([])
    expect(rootAbsoluteUrls('html', '<scripts>'.repeat(64 * 1024) + '<script>"/a.js"</script>')).toEqual(['"/a.js" (script string)'])
    expect(Date.now() - started).toBeLessThan(2000)
    expect(rootAbsoluteUrls('html', `<SCRIPT type="module">import '/m.js'</Script><script>'/n.js'`)).toEqual(['"/m.js" (script string)'])
  })

  it('reports at most five per file', () => {
    expect(rootAbsoluteUrls('html', Array.from({ length: 9 }, (_, i) => `<img src="/i${i}.png">`).join(''))).toHaveLength(5)
  })
})

describe('rootAbsoluteUrlWarnings', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  function plugin(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'url-check-'))
    dirs.push(dir)
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    return dir
  }

  it('flags /dist/x.js in a page and in the page script, with the file named', async () => {
    const dir = plugin({
      'plugin.json': '{"main":"dist/host.js"}',
      'panels/a.html': '<script src="/dist/x.js"></script>',
      'panels/a.js': `loadScript('/dist/y.js')`,
      'dist/host.js': `require('/opt/z.js'); const p = '/usr/lib/x.json'`
    })
    const warnings = await rootAbsoluteUrlWarnings(dir)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/^"panels\/a\.html": root-absolute URL "\/dist\/x\.js" \(src\)/)
    expect(warnings[1]).toMatch(/^"panels\/a\.js": .*"\/dist\/y\.js" \(script string\)/)
  })

  it('passes relative URLs, skips backend files, node_modules and symlinks', async () => {
    const dir = plugin({
      'plugin.json': '{"main":"host.js"}',
      'host.js': `const p = '/usr/lib/x.json'`,
      'lib/util.js': `const p = '/usr/lib/x.json'`,
      'panels/a.html': '<script src="../__sdk/panel.js"></script><script src="a.js"></script>',
      'panels/a.js': `fetch('./data.json')`,
      'panels/node_modules/m/i.js': `x('/dist/x.js')`
    })
    symlinkSync('/etc/hosts', join(dir, 'panels', 'link.js'))
    expect(await rootAbsoluteUrlWarnings(dir)).toEqual([])
  })

  it('a page at the plugin root counts only the root files, not every folder under it', async () => {
    const dir = plugin({
      'plugin.json': '{"main":"dist/host.js"}',
      'index.html': '<p></p>',
      'page.js': `load('/dist/y.js')`,
      'lib/backend.js': `read('/usr/lib/x.json')`,
      'test/a.test.js': `read('/fixtures/x.json')`
    })
    expect(await rootAbsoluteUrlWarnings(dir)).toEqual([expect.stringMatching(/^"page\.js": .*"\/dist\/y\.js"/)])
  })

  it('quotes the file name as JSON, a newline in it included', async () => {
    const dir = plugin({ 'panels/a\nb.html': '<img src="/i.png">' })
    expect(await rootAbsoluteUrlWarnings(dir)).toEqual([expect.stringMatching(/^"panels\/a\\nb\.html": root-absolute URL "\/i\.png" \(src\)/)])
  })

  it('walks a bounded number of folders, files counted or not', async () => {
    const dir = plugin({})
    for (let i = 0; i < 10_050; i++) mkdirSync(join(dir, `d${i}`))
    writeFileSync(join(dir, 'zz.html'), '<img src="/i.png">')
    // Stops before it reaches every entry; what it saw it still reports, and it never throws.
    const warnings = await rootAbsoluteUrlWarnings(dir)
    expect(warnings.length).toBeLessThanOrEqual(1)
  })

  it('never throws on a missing folder', async () => {
    expect(await rootAbsoluteUrlWarnings('/nonexistent/plugin-dir')).toEqual([])
  })
})
