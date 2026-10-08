/*
 * What a room is used for: the advice on its air follows it (a shower in a bathroom, sleep
 * in a bedroom). Chosen for a room in the app; until then it is guessed from the name, in
 * English or German.
 */

export type RoomKind = 'living' | 'bedroom' | 'bathroom' | 'kitchen' | 'office' | 'other';

export const ROOM_KINDS: Record<RoomKind, string> = {
    living: 'Living room',
    bedroom: 'Bedroom',
    bathroom: 'Bathroom',
    kitchen: 'Kitchen',
    office: 'Office',
    other: 'Other',
};

export function isRoomKind(v: unknown): v is RoomKind {
    return typeof v === 'string' && v in ROOM_KINDS;
}

const GUESSES: [RegExp, RoomKind][] = [
    [/bath|shower|toilet|\bwc\b|\bbad\b|badezimmer|dusch/i, 'bathroom'],
    [/bed|sleep|nursery|schlaf|kinderzimmer/i, 'bedroom'],
    [/kitchen|k(ü|ue)che/i, 'kitchen'],
    [/office|study|b(ü|ue)ro|arbeitszimmer/i, 'office'],
    [/living|lounge|wohn/i, 'living'],
];

// the kind chosen for the room, else the one its name suggests
export function roomKind(room: { name: string; kind?: string | null } | null | undefined): RoomKind | undefined {
    if (!room) return undefined;
    if (isRoomKind(room.kind)) return room.kind;
    return GUESSES.find(([re]) => re.test(room.name))?.[1] ?? 'other';
}
