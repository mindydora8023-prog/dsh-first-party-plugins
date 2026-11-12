import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const pluginRoot = path.join(root, 'plugins');
const names = fs.readdirSync(pluginRoot).filter((name) => fs.existsSync(path.join(pluginRoot, name, 'package.json'))).sort();
const normal = (p) => p.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
function covered(files, rel) {
  // npm always includes the manifest, regardless of its files allow-list.
  if (normal(rel) === 'package.json') return true;
  return files.some((file) => {
    const entry = normal(file);
    const pattern = new RegExp('^' + entry.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    return normal(rel) === entry || normal(rel).startsWith(entry + '/') || pattern.test(normal(rel));
  });
}
function walk(dir, callback) {
  for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
    if (['.git', 'node_modules', '.host-checkout'].includes(item.name)) continue;
    const file = path.join(dir, item.name);
    if (item.isSymbolicLink()) { problems.push('Unexpected symlink: ' + path.relative(root, file)); continue; }
    if (item.isDirectory()) walk(file, callback);
    else callback(file);
  }
}
for (const name of names) {
  const dir = path.join(pluginRoot, name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const required = ['README.md', 'LICENSE', pkg.dsh?.bundle?.patch];
  if (fs.existsSync(path.join(dir, 'THIRD_PARTY_NOTICES.md'))) required.push('THIRD_PARTY_NOTICES.md');
  function pathsOf(value) {
    if (typeof value === 'string') { if (value.startsWith('./') && !value.includes('*')) required.push(value); }
    else if (value && typeof value === 'object') for (const entry of Object.values(value)) pathsOf(entry);
  }
  pathsOf(pkg.exports);
  if (pkg.main) required.push(pkg.main);
  if (pkg.license !== 'MIT') problems.push(name + ': expected declared MIT license');
  for (const rel of required.filter(Boolean)) {
    if (!fs.existsSync(path.join(dir, rel))) problems.push(name + ': missing ' + rel);
    if (!covered(pkg.files || [], rel)) problems.push(name + ': omitted from package files: ' + rel);
  }
  walk(dir, (file) => {
    const rel = normal(path.relative(dir, file));
    if (rel.startsWith('licenses/') && !covered(pkg.files || [], rel)) problems.push(name + ': omitted license: ' + rel);
    if (rel.startsWith('lib/') && !covered(pkg.files || [], rel)) problems.push(name + ': omitted runtime module: ' + rel);
    if (rel.startsWith('assets/') && !covered(pkg.files || [], rel)) problems.push(name + ': omitted runtime asset: ' + rel);
  });
}
walk(root, (file) => {
  const rel = normal(path.relative(root, file));
  if (/\.(js|mjs|json|md|py|yml|svg|txt)$/.test(file)) {
    const text = fs.readFileSync(file, 'utf8');
    if (/[CE]:[\\/](?:Users[\\/]\d{5}|Dsh web)/i.test(text)) problems.push('Local personal path: ' + rel);
    if (!rel.includes('/test/') && /gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) problems.push('Potential runtime secret: ' + rel);
  }
});
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log('PASS: ' + names.length + ' plugin manifests, entrypoints, license files and release text checks');
