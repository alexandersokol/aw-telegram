import {canonicalSecret,digest,unauthorized,type DeviceIdentity,type FirestoreRepository} from './repository.js';
export async function authorizeDevice(request: {authorization?: unknown}, repository: FirestoreRepository): Promise<DeviceIdentity> {
  const header=request.authorization;
  if(typeof header!=='string' || !header.startsWith('Bearer ')) return unauthorized();
  const secret=header.slice(7); if(!canonicalSecret(secret,32)) return unauthorized();
  return repository.resolveDevice(digest(secret));
}
