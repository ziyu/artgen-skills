import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skill = resolve(root, 'skills/artgen');
const text = await readFile(resolve(skill, 'SKILL.md'), 'utf8');
const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
assert.ok(match, 'SKILL.md must start with YAML frontmatter');
const name = /^name:\s*([a-z0-9-]+)\s*$/m.exec(match[1])?.[1];
assert.equal(name, basename(skill));
assert.ok(name.length <= 64 && !name.includes('--'));
const description = /^description:\s*(.+)$/m.exec(match[1])?.[1];
assert.ok(description && description.length <= 1024, 'Use a nonempty single-line description');
assert.ok(text.split('\n').length < 500, 'Keep core skill instructions short');
for (const relative of ['scripts/artgen.mjs', 'references/api.md']) {
  assert.ok((await stat(resolve(skill, relative))).isFile(), `Missing bundled resource: ${relative}`);
  assert.ok(text.includes(relative), `SKILL.md must reference ${relative}`);
}
for (const file of ['README.md', 'README.zh-CN.md', 'LICENSE']) assert.ok((await stat(resolve(root, file))).isFile());
console.log('Skill structure, required metadata and bundled references validated.');
