// The plugin settings form's own templates (plugin-form-templates.tsx) on a schema shaped like a
// real plugin's (the jev-triage one): an array of objects, an array of strings, a nested object,
// `"format": "multiline"` strings and a `"format": "sound"` picker. rjsf's default templates drew the array buttons as empty
// glyphicon squares, hid every title, gave array items a narrower field column, and listed a
// save's refusal at the top of a long form, out of view, so Save looked like it did nothing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

const FIXTURE = join(__dirname, '..', 'fixtures', 'plugins', 'settings-form')

test('settings: a plugin form with arrays, groups and multi-line fields', async ({ cockpit }) => {
  const { page, app } = cockpit
  // Wide enough for the label / field rows; a narrow form stacks them (checked at the end).
  await page.setViewportSize({ width: 1100, height: 900 })
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await page.keyboard.press('ControlOrMeta+,')
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: 'Plugins' }).click()
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
  }, FIXTURE)
  await settings.getByRole('button', { name: 'Link folder…' }).click()
  const plugin = settings.locator('[data-plugin="test.settingsform"]')
  await expect(plugin).toContainText('Settings form fixture')
  await plugin.getByRole('button', { name: 'Settings' }).click()
  const form = plugin.locator('.settings-plugin-form')

  // Titles of arrays and nested objects are headings (the groups' names), over their descriptions.
  const rules = form.getByRole('group', { name: 'Rules' })
  await expect(form.getByText('Rules', { exact: true })).toBeVisible()
  await expect(form.getByText('Priority choices', { exact: true })).toBeVisible()
  await expect(form.getByRole('group', { name: 'Priority choices' })).toBeVisible()

  // "format": "multiline" is a text area, at top level and in a nested object, and it grows.
  const profile = form.getByLabel('Profile')
  expect(await profile.evaluate((el) => el.tagName)).toBe('TEXTAREA')
  expect(await form.getByLabel('action').evaluate((el) => el.tagName)).toBe('TEXTAREA')
  expect(await form.getByLabel('urgent').evaluate((el) => el.tagName)).toBe('INPUT')
  const before = (await profile.boundingBox())?.height ?? 0
  const text = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
  await profile.fill(text)
  await expect.poll(async () => (await profile.boundingBox())?.height ?? 0).toBeGreaterThan(before)

  // "format": "sound" is the app's sound dropdown with "App default" first (stored as ""), then the
  // built-ins in their own group, and a Play button for the pick ("" plays the app's sound).
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('notification sound')) errors.push(msg.text())
  })
  const alertSound = form.getByRole('combobox', { name: 'Alert sound' })
  await expect(alertSound).toHaveValue('')
  expect(await alertSound.locator('option').first().textContent()).toBe('App default')
  expect(await alertSound.locator('optgroup[label="Built-in"] option').allTextContents()).toEqual([
    'Chime',
    'Bell',
    'Ping',
    'Soft pop',
    'Two-tone',
    'Marimba'
  ])
  const playAlert = form.getByRole('button', { name: 'Play Alert sound' })
  await playAlert.click()
  await alertSound.selectOption('builtin:ping')
  await expect(alertSound).toHaveValue('builtin:ping')
  await page.waitForTimeout(500)
  await playAlert.click()
  // Beside each other in the field column, like a secret field's buttons.
  const selectBox = await alertSound.boundingBox()
  const playBox = await playAlert.boundingBox()
  expect(playBox?.x ?? 0).toBeGreaterThan((selectBox?.x ?? Infinity) + (selectBox?.width ?? 0) - 1)
  // A long description stays in the label column, left of the control: a CSS specificity slip once
  // spread every description over the full row, under the field's control (2026-11-03).
  const descBox = await form.locator('.field-description', { hasText: 'a long description on purpose' }).boundingBox()
  expect((descBox?.x ?? 0) + (descBox?.width ?? Infinity)).toBeLessThanOrEqual((selectBox?.x ?? 0) + 1)

  // The array buttons have names and text, not empty squares.
  const addRule = rules.getByRole('button', { name: 'Add to Rules' })
  await expect(addRule).toHaveText('Add')
  await addRule.click()
  await addRule.click()
  await expect(rules.locator('.settings-form-item')).toHaveCount(2)
  await expect(rules.getByRole('button', { name: 'Move Rules item 1 up' })).toBeDisabled()
  await expect(rules.getByRole('button', { name: 'Move Rules item 2 down' })).toBeDisabled()
  await expect(rules.getByRole('button', { name: 'Remove Rules item 2' })).toBeEnabled()

  // One field column at every level: a rule's field, a nested object's field and a top-level
  // select are as wide.
  const width = async (l: ReturnType<typeof form.getByLabel>): Promise<number> => (await l.boundingBox())?.width ?? 0
  const ruleField = rules.getByLabel('Field').first()
  expect(await width(ruleField)).toBeCloseTo(await width(form.getByLabel('urgent')), 0)

  // A refused save lists the reasons by Save, in view and focused (the first rule has no field).
  await rules.getByLabel('Field').nth(1).fill('from')
  await rules.getByLabel('Contains').nth(1).fill('boss')
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  const alert = plugin.getByRole('alert')
  await expect(alert).toContainText("/rules/0 must have required property 'field'")
  await expect(alert).toBeInViewport()
  await expect(alert).toBeFocused()
  await expect(plugin.getByRole('button', { name: 'Save settings' })).toBeInViewport()
  // Below the form's fields, by the button: the list follows the last field.
  const alertTop = (await alert.boundingBox())?.y ?? 0
  expect(alertTop).toBeGreaterThan((await form.getByLabel('Limit').boundingBox())?.y ?? Infinity)

  // Move the good rule up, remove the empty one, save.
  await rules.getByRole('button', { name: 'Move Rules item 2 up' }).click()
  await expect(rules.getByLabel('Field').first()).toHaveValue('from')
  await rules.getByRole('button', { name: 'Remove Rules item 2' }).click()
  await expect(rules.locator('.settings-form-item')).toHaveCount(1)
  await form.getByLabel('action').fill('Someone asks me\nto do something')
  await plugin.getByRole('button', { name: 'Save settings' }).click()
  await expect(plugin.getByRole('status')).toHaveText('Saved.')
  await expect(plugin.getByRole('alert')).toHaveCount(0)
  // A narrow form (a small window) puts each label over its field instead of squeezing the labels.
  await page.setViewportSize({ width: 640, height: 900 })
  const limitLabel = await form.locator('label', { hasText: 'Limit' }).boundingBox()
  const limitField = await form.getByLabel('Limit').boundingBox()
  expect(limitField?.y ?? 0).toBeGreaterThan((limitLabel?.y ?? Infinity) + (limitLabel?.height ?? 0) - 1)

  const stored = (): unknown =>
    (JSON.parse(readFileSync(join(cockpit.dataDir, 'app.json'), 'utf8')) as { pluginSettings?: Record<string, unknown> })
      .pluginSettings?.['test.settingsform']
  await expect.poll(stored, { timeout: 5_000 }).toMatchObject({
    profile: text,
    rules: [{ field: 'from', contains: 'boss', priority: 'fyi' }],
    criteria: { action: 'Someone asks me\nto do something' },
    alert: 'builtin:ping'
  })
  expect(errors).toEqual([])
})
