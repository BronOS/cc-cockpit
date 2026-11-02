// Renders build/icon.svg to PNGs with Electron's own Chromium (no image tools needed), then the
// macOS .icns via iconutil. Run: `npx electron scripts/render-icon.cjs`.
// Outputs: build/icon.png (1024, also used for Linux and the dev dock), build/icon.icns.
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('node:child_process')
const { mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const svg = readFileSync(join(root, 'build', 'icon.svg'), 'utf8')
// iconutil's iconset: each size at 1x and 2x.
const SIZES = [16, 32, 128, 256, 512]

// Draws the SVG as an image onto a canvas inside the page and exports the canvas, so no window
// ever has to paint (capturePage on a hidden window fails with UnknownVizError).
async function render(win, size) {
  const src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  const dataUrl = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = c.height = ${size}
      const g = c.getContext('2d')
      g.imageSmoothingQuality = 'high'
      g.drawImage(img, 0, 0, ${size}, ${size})
      resolve(c.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('svg did not load'))
    img.src = ${JSON.stringify(src)}
  })`)
  return Buffer.from(dataUrl.split(',')[1], 'base64')
}

async function main() {
  const win = new BrowserWindow({ show: false })
  await win.loadURL('about:blank')
  const set = join(root, 'build', 'icon.iconset')
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set, { recursive: true })
  for (const s of SIZES) {
    writeFileSync(join(set, `icon_${s}x${s}.png`), await render(win, s))
    writeFileSync(join(set, `icon_${s}x${s}@2x.png`), await render(win, s * 2))
  }
  writeFileSync(join(root, 'build', 'icon.png'), await render(win, 1024))
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'build', 'icon.icns')])
  rmSync(set, { recursive: true, force: true })
}

app.whenReady().then(() =>
  main().then(
    () => app.quit(),
    (err) => {
      console.error(err)
      app.exit(1)
    }
  )
)
