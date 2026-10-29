/** Owner-only deletion of one device's data: its document tree and every top-level document that names it.
 * Run through scripts/purge.ts with owner IAM; never from the laptop or a request handler. Irreversible. */
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface PurgeReport { indexDocuments: number; }

export async function purgeDevice(db: Firestore, deviceId: string, options: { confirm: string }): Promise<PurgeReport> {
    if (!UUID.test(deviceId))
        throw new Error('Invalid device ID');
    if (options.confirm !== deviceId)
        throw new Error('Purge needs confirmation: --confirm must repeat the device ID');
    // A live laptop would keep writing (and in-flight tasks recreating) data while it is deleted.
    const device = await db.doc('devices/' + deviceId).get();
    if (device.exists && device.data()?.status !== 'revoked')
        throw new Error('Revoke the device first (enroll.ts revoke-device)');
    // Index documents outside the device tree: pairing keys, Telegram bindings (freeing those accounts to pair a
    // replacement laptop), parent events and messages, task intents, action locations and the enrollment.
    const named = await Promise.all([
        db.collection('pairKeys').where('deviceId', '==', deviceId).get(),
        db.collection('telegramUsers').where('deviceId', '==', deviceId).get(),
        db.collection('events').where('deviceId', '==', deviceId).get(),
        db.collection('actionLocations').where('deviceId', '==', deviceId).get(),
        db.collection('enrollments').where('deviceId', '==', deviceId).get(),
        db.collection('taskIntents').where('kind', '==', 'deadline').where('resourceId', '>=', deviceId + ':').where('resourceId', '<', deviceId + ';').get(),
    ]);
    const outbox = await db.collection('outbox').where('recipient.deviceId', '==', deviceId).get();
    const refs: DocumentReference[] = [...named.flatMap(q => q.docs.map(d => d.ref)), ...outbox.docs.map(d => d.ref)];
    const ids = outbox.docs.map(d => d.id);
    for (let i = 0; i < ids.length; i += 30) {
        const intents = await db.collection('taskIntents').where('kind', '==', 'outbox').where('resourceId', 'in', ids.slice(i, i + 30)).get();
        refs.push(...intents.docs.map(d => d.ref));
    }
    const writer = db.bulkWriter();
    let failed = 0;
    for (const ref of refs)
        writer.delete(ref).catch(() => { failed++; });
    await writer.close();
    if (failed)
        throw new Error(`${failed} related documents could not be deleted; run the purge again`);
    await db.recursiveDelete(db.doc('devices/' + deviceId));
    return { indexDocuments: refs.length };
}
