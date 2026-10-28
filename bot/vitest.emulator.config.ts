import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),test:{include:['tests/*.emulator.test.ts'],fileParallelism:false,testTimeout:20000,hookTimeout:20000}});
