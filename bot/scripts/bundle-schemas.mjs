import { cpSync, mkdirSync } from 'node:fs';
const source = new URL('../../contracts/v2/', import.meta.url);
const destination = new URL('../dist/schemas/', import.meta.url);
mkdirSync(destination, {recursive: true});
cpSync(source, destination, {recursive: true});
