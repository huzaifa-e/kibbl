import crypto from 'node:crypto';
import type { HomeRoom } from '../../../shared/heating';
import { Device, Room, TadoLink } from './db';

/*
 * The rooms of an account's home. A device (a kibbl. air, a camera) and a room of tado stand
 * in one; a kibbl. air in the same room as a tado room shows tado's temperature and humidity
 * (its CO2 stays its own), in a room without one it measures them itself. Moving a device is
 * choosing another room.
 */

export const ROOM_NAME_MAX = 40;

export async function listRooms(ownerID: string): Promise<HomeRoom[]> {
    const rooms = await Room.find({ ownerID }, { name: 1 }).sort({ name: 1 }).lean();
    return rooms.map((r) => ({ _id: r._id, name: r.name }));
}

export async function createRoom(ownerID: string, name: string) {
    const doc = { _id: crypto.randomUUID(), ownerID, name: name.trim().slice(0, ROOM_NAME_MAX), createdAt: Date.now() };
    await Room.create(doc);
    return { _id: doc._id, name: doc.name };
}

// the room of this name (any case), made when there is none: for the rooms tado brings
export async function roomByName(ownerID: string, name: string) {
    const existing = (await Room.find({ ownerID }).lean()).find((r) => r.name.toLowerCase() === name.trim().toLowerCase());
    return existing ? existing._id : (await createRoom(ownerID, name))._id;
}

export async function renameRoom(ownerID: string, roomId: string, name: string) {
    const res = await Room.updateOne({ _id: roomId, ownerID }, { name: name.trim().slice(0, ROOM_NAME_MAX) });
    return res.matchedCount > 0;
}

// what stood in it is in no room then
export async function deleteRoom(ownerID: string, roomId: string) {
    const res = await Room.deleteOne({ _id: roomId, ownerID });
    if (!res.deletedCount) return false;
    await Device.updateMany({ ownerID, roomId }, { $unset: { roomId: 1 } });
    await TadoLink.updateOne({ _id: ownerID }, { $unset: { 'rooms.$[r].roomId': 1 } }, { arrayFilters: [{ 'r.roomId': roomId }] });
    return true;
}

export async function ownRoom(ownerID: string, roomId: string | null) {
    return roomId === null || !!(await Room.exists({ _id: roomId, ownerID }));
}

export async function moveDevice(ownerID: string, deviceId: string, roomId: string | null) {
    const res = await Device.updateOne({ _id: deviceId, ownerID }, roomId ? { roomId } : { $unset: { roomId: 1 } });
    return res.matchedCount > 0;
}
