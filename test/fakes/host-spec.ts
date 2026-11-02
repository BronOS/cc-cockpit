// A HostPluginSpec for host-side tests: what main sends per plugin, with inert defaults.
import { join } from 'node:path'
import type { HostPluginSpec } from '../../src/host/loader'

export function hostSpec(
  fields: Pick<HostPluginSpec, 'id' | 'dir' | 'main'> & Partial<HostPluginSpec>
): HostPluginSpec {
  const dataDir = fields.dataDir ?? join(fields.dir, '.data')
  return {
    projectDir: fields.dir,
    dataDir,
    appDataDir: join(fields.dir, '.app-data'),
    storageFile: join(dataDir, 'storage.json'),
    commands: [],
    panels: [],
    settings: { project: {}, app: {} },
    ...fields
  }
}
