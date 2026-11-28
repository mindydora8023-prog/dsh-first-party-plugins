import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const pluginRoot = path.join(root, 'plugins');

export function discoverPlugins() {
  return fs.readdirSync(pluginRoot)
    .filter((id) => fs.existsSync(path.join(pluginRoot, id, 'package.json')))
    .sort()
    .map((id) => {
      const directory = path.join(pluginRoot, id);
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
      return { id, directory, manifest };
    });
}
