import { Device, Meter, User } from './db';
import { logger } from './logger';

/*
 * Every device and meter belongs to one account: its owner sees it, streams it, gets its
 * events and changes it; nobody else does. A device set up over USB belongs to whoever
 * set it up; one that belongs to somebody already can be set up only by them, until they
 * remove it. One that connected without a setup waits, without an owner, for the admin
 * (ADMIN_EMAIL) to approve it.
 */

const log = logger('owners');

let adminCache: { id: string | null; at: number } | undefined;
const ADMIN_CACHE_MS = 60_000;

// the admin's account: ADMIN_EMAIL, or the oldest account when it is not set
export async function adminID() {
    if (adminCache && Date.now() - adminCache.at < ADMIN_CACHE_MS) return adminCache.id;
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const user = (email ? await User.findOne({ email }, { _id: 1 }).lean() : null) ?? (await User.findOne({}, { _id: 1 }).sort({ createdAt: 1 }).lean());
    adminCache = { id: user?._id ?? null, at: Date.now() };
    return adminCache.id;
}

export async function isAdmin(userID: string) {
    return (await adminID()) === userID;
}

/* Devices and meters from before there were owners belong to the admin; pending devices
 * stay without one. Runs on every start, does nothing once all have one. */
export async function assignUnowned() {
    const admin = await adminID();
    if (!admin) return;
    const [devices, meters] = await Promise.all([
        Device.updateMany({ ownerID: { $exists: false }, status: 'approved' }, { $set: { ownerID: admin } }),
        Meter.updateMany({ ownerID: { $exists: false } }, { $set: { ownerID: admin } }),
    ]);
    if (devices.modifiedCount || meters.modifiedCount) {
        log.info('devices and meters without owner given to the admin', { devices: devices.modifiedCount, meters: meters.modifiedCount });
    }
}

/* ----------------------------------------------------------------------- */

// who a device belongs to, for the live updates; kept in memory, dropped when it changes
const owners = new Map<string, string | null>();

export async function deviceOwner(deviceId: string) {
    if (owners.has(deviceId)) return owners.get(deviceId) ?? null;
    const doc = await Device.findById(deviceId, { ownerID: 1 }).lean();
    owners.set(deviceId, doc?.ownerID ?? null);
    return doc?.ownerID ?? null;
}

export function forgetOwner(deviceId: string) {
    owners.delete(deviceId);
}

/* What a user may do with a device: its owner everything; the admin may approve or
 * reject a pending device nobody owns. */
export async function canUse(userID: string, doc: Pick<DeviceDoc, 'ownerID' | 'status'> | null | undefined) {
    if (!doc) return false;
    if (doc.ownerID) return doc.ownerID === userID;
    return doc.status === 'pending' && (await isAdmin(userID));
}

// what a user sees: their own devices, and for the admin the pending ones nobody owns
export async function visibleDeviceFilter(userID: string) {
    return (await isAdmin(userID)) ? { $or: [{ ownerID: userID }, { ownerID: { $exists: false }, status: 'pending' }] } : { ownerID: userID };
}

export async function ownedDeviceIds(userID: string) {
    return (await Device.find({ ownerID: userID }, { _id: 1 }).lean()).map((d) => d._id);
}

// whether this user may set the device up over USB: one nobody owns yet, or their own
export async function maySetUp(userID: string, deviceId: string) {
    const doc = await Device.findById(deviceId, { ownerID: 1 }).lean();
    return !doc?.ownerID || doc.ownerID === userID;
}
