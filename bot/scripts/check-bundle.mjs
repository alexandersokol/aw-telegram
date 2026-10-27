// Import an isolated package copy: a source-tree fallback cannot hide missing assets.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';
const root = new URL('../', import.meta.url);
const temporary = mkdtempSync(new URL('.bundle-check-', root));
try {
  const directory = pathToFileURL(temporary + '/');
  cpSync(new URL('dist/', root), new URL('dist/', directory), {recursive: true});
  writeFileSync(new URL('package.json', directory), '{"type":"module"}\n');
  const {validateContract, defaultSettings} = await import(new URL('dist/contracts.js', directory));
  assert.deepEqual(validateContract('settings', defaultSettings()), {
    revision: 0, selectedPaths: [], selectedUncategorized: false, defaultLimitMs: 14400000,
    todayOverride: null, freeUseDate: null, suppressedDate: null,
  });
  const {dayBounds} = await import(new URL('dist/clock.js', directory));
  assert.deepEqual(dayBounds('2026-10-25'), {start: '2026-10-24T21:00:00.000Z', end: '2026-10-25T22:00:00.000Z'});
  process.stdout.write('Isolated compiled package: schemas and Kyiv time helper passed.\n');
} finally {
  if (!resolve(temporary).startsWith(resolve(fileURLToPath(root)) + sep))
    throw new Error('Refusing cleanup outside bot workspace');
  rmSync(temporary, {recursive: true, force: true});
}
