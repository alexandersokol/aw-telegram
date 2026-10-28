import {Firestore} from 'firebase-admin/firestore';

export const projectId = 'demo-aw-telegram';
export function emulatorAddress(): {host: string; port: number} {
  const address = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  const match = /^(127\.0\.0\.1|localhost):([0-9]+)$/.exec(address);
  if (!match || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
    throw new Error('Tests require exact demo-aw-telegram and explicit loopback emulator without credentials');
  return {host: match[1]!, port: Number(match[2])};
}
export function fixtureDb(): Firestore {
  emulatorAddress();
  return new Firestore({projectId});
}
export async function resetFixture(): Promise<void> {
  const {host, port} = emulatorAddress();
  const response = await fetch(`http://${host}:${port}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    {method: 'DELETE', signal: AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error('Local fixture reset failed');
}
