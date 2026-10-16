/*
 * The gym: the muscles, the exercises that train them, workouts as they are logged (in the app or
 * imported from Strong) and what the sets say about progress. Shared by the server (storage,
 * import, the assistant's tools) and the page (logging, charts, the drawings of the muscles).
 */

/* ----------------------------------------------------------------------- */
/* Muscles                                                                  */

export const MUSCLES = {
    chest_upper: { label: 'Upper chest', group: 'chest' },
    chest_mid: { label: 'Mid chest', group: 'chest' },
    chest_lower: { label: 'Lower chest', group: 'chest' },
    delts_front: { label: 'Front delts', group: 'shoulders' },
    delts_side: { label: 'Side delts', group: 'shoulders' },
    delts_rear: { label: 'Rear delts', group: 'shoulders' },
    traps: { label: 'Traps', group: 'back' },
    lats: { label: 'Lats', group: 'back' },
    upper_back: { label: 'Upper back', group: 'back' },
    lower_back: { label: 'Lower back', group: 'back' },
    biceps: { label: 'Biceps', group: 'biceps' },
    triceps: { label: 'Triceps', group: 'triceps' },
    forearms: { label: 'Forearms', group: 'forearms' },
    abs: { label: 'Abs', group: 'core' },
    obliques: { label: 'Obliques', group: 'core' },
    glutes: { label: 'Glutes', group: 'glutes' },
    abductors: { label: 'Abductors', group: 'glutes' },
    quads: { label: 'Quads', group: 'quads' },
    adductors: { label: 'Adductors', group: 'quads' },
    hamstrings: { label: 'Hamstrings', group: 'hamstrings' },
    calves: { label: 'Calves', group: 'calves' },
} as const;

export type Muscle = keyof typeof MUSCLES;
export const MUSCLE_IDS = Object.keys(MUSCLES) as Muscle[];
export const isMuscle = (v: unknown): v is Muscle => typeof v === 'string' && v in MUSCLES;

/* The groups the charts and the advice speak of. `sets` is the range of hard sets a week that
 * grows a muscle for most people who train: about 10 to 20 for a large group (the dose-response
 * of Schoenfeld, Ogborn & Krieger 2017 and Pelland et al. 2024), less for the small ones that the
 * compound lifts already train. Below the range growth is slower, far above it recovery suffers. */
export type MuscleGroup = (typeof MUSCLES)[Muscle]['group'];

export const GROUPS: Record<MuscleGroup, { label: string; sets: [number, number] }> = {
    chest: { label: 'Chest', sets: [10, 20] },
    back: { label: 'Back', sets: [10, 20] },
    shoulders: { label: 'Shoulders', sets: [8, 18] },
    biceps: { label: 'Biceps', sets: [6, 14] },
    triceps: { label: 'Triceps', sets: [6, 14] },
    forearms: { label: 'Forearms', sets: [0, 10] },
    core: { label: 'Core', sets: [4, 12] },
    quads: { label: 'Quads', sets: [10, 20] },
    hamstrings: { label: 'Hamstrings', sets: [6, 16] },
    glutes: { label: 'Glutes', sets: [6, 16] },
    calves: { label: 'Calves', sets: [6, 16] },
};

export const GROUP_IDS = Object.keys(GROUPS) as MuscleGroup[];
export const groupOf = (m: Muscle): MuscleGroup => MUSCLES[m].group;

/* ----------------------------------------------------------------------- */
/* Exercises                                                                */

export type Equipment = 'barbell' | 'dumbbell' | 'cable' | 'machine' | 'smith' | 'bodyweight' | 'kettlebell' | 'band' | 'plate' | 'mat' | 'reformer' | 'other';
/* weight: weight × reps; bodyweight: reps, extra weight optional; assisted: the weight helps;
 * duration: seconds (a plank); cardio: seconds and distance, no muscles counted */
export type ExerciseKind = 'weight' | 'bodyweight' | 'assisted' | 'duration' | 'mobility' | 'cardio';
// mobility: a stretch or flow held for seconds; it shows its muscles but counts no hard sets

/* What a workout is. One place for all of them: lifting, running, riding, Pilates... so the week
 * shows everything that was done, not only what one app knows of. */
export const WORKOUT_KINDS = {
    strength: { label: 'Strength', icon: 'barbell' },
    running: { label: 'Running', icon: 'run' },
    cycling: { label: 'Cycling', icon: 'bike' },
    pilates: { label: 'Pilates', icon: 'stretching-2' },
    yoga: { label: 'Yoga & mobility', icon: 'yoga' },
    hiit: { label: 'HIIT', icon: 'flame' },
    swimming: { label: 'Swimming', icon: 'swimming' },
    walking: { label: 'Walking & hiking', icon: 'walk' },
    cardio: { label: 'Other cardio', icon: 'heartbeat' },
    sport: { label: 'Sport', icon: 'ball-football' },
} as const;

export type WorkoutKind = keyof typeof WORKOUT_KINDS;
export const WORKOUT_KIND_IDS = Object.keys(WORKOUT_KINDS) as WorkoutKind[];
export const isWorkoutKind = (v: unknown): v is WorkoutKind => typeof v === 'string' && v in WORKOUT_KINDS;

/* The kind of a session the fitness tracker recorded (Google Health's exercise types as words);
 * null for what is not training (cleaning, the tracker's guesses of chores). */
export function trackerKind(type: string): WorkoutKind | null {
    const t = type.toLowerCase();
    if (/clean|house|garden|chore/.test(t)) return null;
    if (/strength|weight|lift|crossfit|core training|calisthenics/.test(t)) return 'strength';
    if (/run|treadmill|jog/.test(t)) return 'running';
    if (/bik|cycl|spin/.test(t)) return 'cycling';
    if (/pilates/.test(t)) return 'pilates';
    if (/yoga|stretch|mobility|meditat/.test(t)) return 'yoga';
    if (/hiit|interval|circuit|boot ?camp/.test(t)) return 'hiit';
    if (/swim/.test(t)) return 'swimming';
    if (/walk|hik/.test(t)) return 'walking';
    if (/ball|tennis|soccer|football|basket|badminton|squash|golf|boxing|martial|climb|ski|skat|danc|volley|padel/.test(t)) return 'sport';
    return 'cardio';
}

export interface ExerciseInfo {
    name: string;
    primary: Muscle[];
    secondary: Muscle[];
    equipment: Equipment;
    kind: ExerciseKind;
    custom?: boolean; // made by the user or found in an import, its muscles guessed or set by hand
    activity?: WorkoutKind; // of a cardio exercise: what kind of workout it makes
}

type Row = [string, Muscle[], Muscle[], Equipment, ExerciseKind?, WorkoutKind?];

/* Names as Strong writes them, so an import finds them: "Movement (Equipment)". */
const CATALOG: Row[] = [
    // chest
    ['Bench Press (Barbell)', ['chest_mid'], ['chest_upper', 'chest_lower', 'delts_front', 'triceps'], 'barbell'],
    ['Bench Press (Dumbbell)', ['chest_mid'], ['chest_upper', 'chest_lower', 'delts_front', 'triceps'], 'dumbbell'],
    ['Bench Press (Smith Machine)', ['chest_mid'], ['chest_upper', 'delts_front', 'triceps'], 'smith'],
    ['Bench Press (Cable)', ['chest_mid'], ['delts_front', 'triceps'], 'cable'],
    ['Incline Bench Press (Barbell)', ['chest_upper'], ['chest_mid', 'delts_front', 'triceps'], 'barbell'],
    ['Incline Bench Press (Dumbbell)', ['chest_upper'], ['chest_mid', 'delts_front', 'triceps'], 'dumbbell'],
    ['Incline Bench Press (Smith Machine)', ['chest_upper'], ['chest_mid', 'delts_front', 'triceps'], 'smith'],
    ['Incline Chest Press (Machine)', ['chest_upper'], ['chest_mid', 'delts_front', 'triceps'], 'machine'],
    ['Decline Bench Press (Barbell)', ['chest_lower'], ['chest_mid', 'triceps'], 'barbell'],
    ['Decline Bench Press (Dumbbell)', ['chest_lower'], ['chest_mid', 'triceps'], 'dumbbell'],
    ['Decline Bench Press (Smith Machine)', ['chest_lower'], ['chest_mid', 'triceps'], 'smith'],
    ['Chest Press (Machine)', ['chest_mid'], ['chest_upper', 'delts_front', 'triceps'], 'machine'],
    ['Chest Fly', ['chest_mid'], ['chest_upper', 'chest_lower', 'delts_front'], 'other'],
    ['Chest Fly (Dumbbell)', ['chest_mid'], ['chest_upper', 'chest_lower', 'delts_front'], 'dumbbell'],
    ['Chest Fly (Machine)', ['chest_mid'], ['chest_upper', 'chest_lower', 'delts_front'], 'machine'],
    ['Chest Fly (Band)', ['chest_mid'], ['delts_front'], 'band'],
    ['Incline Chest Fly (Dumbbell)', ['chest_upper'], ['chest_mid', 'delts_front'], 'dumbbell'],
    ['Pec Deck (Machine)', ['chest_mid'], ['chest_upper', 'chest_lower'], 'machine'],
    ['Cable Crossover', ['chest_mid'], ['chest_lower', 'delts_front'], 'cable'],
    ['Low Cable Fly', ['chest_upper'], ['chest_mid', 'delts_front'], 'cable'],
    ['High Cable Fly', ['chest_lower'], ['chest_mid'], 'cable'],
    ['Push Up', ['chest_mid'], ['delts_front', 'triceps', 'abs'], 'bodyweight', 'bodyweight'],
    ['Incline Push Up', ['chest_lower'], ['chest_mid', 'triceps'], 'bodyweight', 'bodyweight'],
    ['Decline Push Up', ['chest_upper'], ['chest_mid', 'delts_front', 'triceps'], 'bodyweight', 'bodyweight'],
    ['Chest Dip', ['chest_lower'], ['triceps', 'delts_front'], 'bodyweight', 'bodyweight'],
    ['Chest Dip (Assisted)', ['chest_lower'], ['triceps', 'delts_front'], 'machine', 'assisted'],
    ['Pullover (Dumbbell)', ['chest_mid'], ['lats', 'triceps'], 'dumbbell'],
    ['Floor Press (Barbell)', ['chest_mid'], ['triceps'], 'barbell'],

    // back
    ['Deadlift (Barbell)', ['lower_back', 'glutes', 'hamstrings'], ['traps', 'quads', 'forearms', 'upper_back'], 'barbell'],
    ['Deadlift (Dumbbell)', ['lower_back', 'glutes', 'hamstrings'], ['traps', 'quads', 'forearms'], 'dumbbell'],
    ['Deadlift (Trap Bar)', ['quads', 'glutes', 'lower_back'], ['hamstrings', 'traps', 'forearms'], 'barbell'],
    ['Sumo Deadlift (Barbell)', ['glutes', 'quads', 'adductors'], ['lower_back', 'hamstrings', 'traps'], 'barbell'],
    ['Rack Pull', ['lower_back', 'traps'], ['glutes', 'hamstrings', 'upper_back', 'forearms'], 'barbell'],
    ['Lat Pulldown (Cable)', ['lats'], ['upper_back', 'biceps', 'delts_rear'], 'cable'],
    ['Lat Pulldown (Machine)', ['lats'], ['upper_back', 'biceps', 'delts_rear'], 'machine'],
    ['Lat Pulldown - Wide Grip (Cable)', ['lats'], ['upper_back', 'biceps'], 'cable'],
    ['Lat Pulldown - Underhand (Cable)', ['lats'], ['biceps', 'upper_back'], 'cable'],
    ['Lat Pulldown - Single Arm (Cable)', ['lats'], ['biceps'], 'cable'],
    ['Close Grip Lat Pulldown (Cable)', ['lats'], ['upper_back', 'biceps'], 'cable'],
    ['Straight Arm Pulldown (Cable)', ['lats'], ['triceps', 'delts_rear'], 'cable'],
    ['Pull Up', ['lats'], ['upper_back', 'biceps', 'forearms'], 'bodyweight', 'bodyweight'],
    ['Pull Up (Assisted)', ['lats'], ['upper_back', 'biceps'], 'machine', 'assisted'],
    ['Pull Up (Band)', ['lats'], ['upper_back', 'biceps'], 'band', 'assisted'],
    ['Pull Up (Weighted)', ['lats'], ['upper_back', 'biceps', 'forearms'], 'other', 'bodyweight'],
    ['Chin Up', ['lats', 'biceps'], ['upper_back'], 'bodyweight', 'bodyweight'],
    ['Chin Up (Assisted)', ['lats', 'biceps'], ['upper_back'], 'machine', 'assisted'],
    ['Seated Row (Cable)', ['upper_back', 'lats'], ['delts_rear', 'biceps', 'traps'], 'cable'],
    ['Seated Row (Machine)', ['upper_back', 'lats'], ['delts_rear', 'biceps', 'traps'], 'machine'],
    ['Seated Wide-Grip Row (Cable)', ['upper_back'], ['delts_rear', 'lats', 'traps'], 'cable'],
    ['Bent Over Row (Barbell)', ['upper_back', 'lats'], ['delts_rear', 'biceps', 'lower_back', 'traps'], 'barbell'],
    ['Bent Over Row (Dumbbell)', ['upper_back', 'lats'], ['delts_rear', 'biceps', 'traps'], 'dumbbell'],
    ['Bent Over One Arm Row (Dumbbell)', ['lats', 'upper_back'], ['delts_rear', 'biceps'], 'dumbbell'],
    ['Pendlay Row (Barbell)', ['upper_back', 'lats'], ['delts_rear', 'biceps', 'lower_back'], 'barbell'],
    ['T Bar Row', ['upper_back', 'lats'], ['delts_rear', 'biceps', 'traps', 'lower_back'], 'barbell'],
    ['Incline Row (Dumbbell)', ['upper_back'], ['lats', 'delts_rear', 'biceps'], 'dumbbell'],
    ['Chest Supported Row (Machine)', ['upper_back'], ['lats', 'delts_rear', 'biceps'], 'machine'],
    ['Iso-Lateral Row (Machine)', ['upper_back', 'lats'], ['delts_rear', 'biceps'], 'machine'],
    ['Iso-Lateral High Row (Machine)', ['lats', 'upper_back'], ['delts_rear', 'biceps'], 'machine'],
    ['Inverted Row (Bodyweight)', ['upper_back'], ['lats', 'biceps', 'delts_rear'], 'bodyweight', 'bodyweight'],
    ['Shrug (Barbell)', ['traps'], ['forearms'], 'barbell'],
    ['Shrug (Dumbbell)', ['traps'], ['forearms'], 'dumbbell'],
    ['Shrug (Machine)', ['traps'], [], 'machine'],
    ['Shrug (Smith Machine)', ['traps'], [], 'smith'],
    ['Back Extension', ['lower_back'], ['glutes', 'hamstrings'], 'bodyweight', 'bodyweight'],
    ['Back Extension (Machine)', ['lower_back'], ['glutes', 'hamstrings'], 'machine'],
    ['Good Morning (Barbell)', ['hamstrings', 'lower_back'], ['glutes'], 'barbell'],
    ['Superman', ['lower_back'], ['glutes'], 'bodyweight', 'bodyweight'],

    // shoulders
    ['Overhead Press (Barbell)', ['delts_front'], ['delts_side', 'triceps', 'chest_upper', 'traps'], 'barbell'],
    ['Overhead Press (Dumbbell)', ['delts_front'], ['delts_side', 'triceps', 'chest_upper'], 'dumbbell'],
    ['Overhead Press (Smith Machine)', ['delts_front'], ['delts_side', 'triceps'], 'smith'],
    ['Seated Overhead Press (Barbell)', ['delts_front'], ['delts_side', 'triceps'], 'barbell'],
    ['Seated Overhead Press (Dumbbell)', ['delts_front'], ['delts_side', 'triceps'], 'dumbbell'],
    ['Shoulder Press (Machine)', ['delts_front'], ['delts_side', 'triceps'], 'machine'],
    ['Shoulder Press (Plate Loaded)', ['delts_front'], ['delts_side', 'triceps'], 'machine'],
    ['Arnold Press (Dumbbell)', ['delts_front'], ['delts_side', 'triceps'], 'dumbbell'],
    ['Push Press', ['delts_front'], ['delts_side', 'triceps', 'quads'], 'barbell'],
    ['Lateral Raise (Dumbbell)', ['delts_side'], ['traps', 'delts_front'], 'dumbbell'],
    ['Lateral Raise (Cable)', ['delts_side'], ['traps'], 'cable'],
    ['Lateral Raise (Machine)', ['delts_side'], ['traps'], 'machine'],
    ['Lateral Raise (Band)', ['delts_side'], [], 'band'],
    ['Seated Lateral Raise (Dumbbell)', ['delts_side'], ['traps'], 'dumbbell'],
    ['Front Raise (Dumbbell)', ['delts_front'], ['chest_upper', 'delts_side'], 'dumbbell'],
    ['Front Raise (Cable)', ['delts_front'], ['chest_upper'], 'cable'],
    ['Front Raise (Barbell)', ['delts_front'], ['chest_upper'], 'barbell'],
    ['Front Raise (Plate)', ['delts_front'], ['chest_upper'], 'plate'],
    ['Upright Row (Barbell)', ['delts_side', 'traps'], ['delts_front', 'biceps'], 'barbell'],
    ['Upright Row (Cable)', ['delts_side', 'traps'], ['delts_front', 'biceps'], 'cable'],
    ['Upright Row (Dumbbell)', ['delts_side', 'traps'], ['delts_front'], 'dumbbell'],
    ['Face Pull (Cable)', ['delts_rear'], ['upper_back', 'traps'], 'cable'],
    ['Reverse Fly (Dumbbell)', ['delts_rear'], ['upper_back', 'traps'], 'dumbbell'],
    ['Reverse Fly (Cable)', ['delts_rear'], ['upper_back'], 'cable'],
    ['Reverse Fly (Machine)', ['delts_rear'], ['upper_back', 'traps'], 'machine'],
    ['Rear Delt Fly (Machine)', ['delts_rear'], ['upper_back'], 'machine'],
    ['Bent Over Lateral Raise (Dumbbell)', ['delts_rear'], ['upper_back'], 'dumbbell'],

    // biceps
    ['Bicep Curl (Barbell)', ['biceps'], ['forearms'], 'barbell'],
    ['Bicep Curl (Dumbbell)', ['biceps'], ['forearms'], 'dumbbell'],
    ['Bicep Curl (Cable)', ['biceps'], ['forearms'], 'cable'],
    ['Bicep Curl (Machine)', ['biceps'], ['forearms'], 'machine'],
    ['Bicep Curl (Band)', ['biceps'], [], 'band'],
    ['EZ Bar Curl', ['biceps'], ['forearms'], 'barbell'],
    ['Hammer Curl (Dumbbell)', ['biceps', 'forearms'], [], 'dumbbell'],
    ['Hammer Curl (Cable)', ['biceps', 'forearms'], [], 'cable'],
    ['Hammer Curl (Band)', ['biceps', 'forearms'], [], 'band'],
    ['Preacher Curl (Barbell)', ['biceps'], ['forearms'], 'barbell'],
    ['Preacher Curl (Dumbbell)', ['biceps'], ['forearms'], 'dumbbell'],
    ['Preacher Curl (Machine)', ['biceps'], [], 'machine'],
    ['Concentration Curl (Dumbbell)', ['biceps'], [], 'dumbbell'],
    ['Incline Curl (Dumbbell)', ['biceps'], ['forearms'], 'dumbbell'],
    ['Spider Curl (Dumbbell)', ['biceps'], [], 'dumbbell'],
    ['Bayesian Curl (Cable)', ['biceps'], [], 'cable'],
    ['Drag Curl (Barbell)', ['biceps'], ['forearms'], 'barbell'],
    ['Reverse Curl (Barbell)', ['forearms', 'biceps'], [], 'barbell'],
    ['Reverse Curl (Dumbbell)', ['forearms', 'biceps'], [], 'dumbbell'],
    ['Reverse Curl (Cable)', ['forearms', 'biceps'], [], 'cable'],

    // triceps
    ['Triceps Pushdown (Cable - Straight Bar)', ['triceps'], [], 'cable'],
    ['Triceps Rope Pushdown', ['triceps'], [], 'cable'],
    ['Triceps Pushdown', ['triceps'], [], 'cable'],
    ['Triceps Extension (Barbell)', ['triceps'], [], 'barbell'],
    ['Triceps Extension (Cable)', ['triceps'], [], 'cable'],
    ['Triceps Extension (Dumbbell)', ['triceps'], [], 'dumbbell'],
    ['Triceps Extension (Machine)', ['triceps'], [], 'machine'],
    ['Overhead Triceps Extension (Cable)', ['triceps'], [], 'cable'],
    ['Overhead Triceps Extension (Dumbbell)', ['triceps'], [], 'dumbbell'],
    ['Skullcrusher (Barbell)', ['triceps'], [], 'barbell'],
    ['Skullcrusher (Dumbbell)', ['triceps'], [], 'dumbbell'],
    ['Bench Press - Close Grip (Barbell)', ['triceps'], ['chest_mid', 'delts_front'], 'barbell'],
    ['Close Grip Bench Press (Barbell)', ['triceps'], ['chest_mid', 'delts_front'], 'barbell'],
    ['Triceps Dip', ['triceps'], ['chest_lower', 'delts_front'], 'bodyweight', 'bodyweight'],
    ['Triceps Dip (Assisted)', ['triceps'], ['chest_lower', 'delts_front'], 'machine', 'assisted'],
    ['Triceps Dip (Weighted)', ['triceps'], ['chest_lower', 'delts_front'], 'other', 'bodyweight'],
    ['Bench Dip', ['triceps'], ['delts_front'], 'bodyweight', 'bodyweight'],
    ['Kickback (Dumbbell)', ['triceps'], [], 'dumbbell'],
    ['Kickback (Cable)', ['triceps'], [], 'cable'],
    ['Diamond Push Up', ['triceps'], ['chest_mid'], 'bodyweight', 'bodyweight'],

    // forearms
    ['Wrist Curl (Barbell)', ['forearms'], [], 'barbell'],
    ['Wrist Curl (Dumbbell)', ['forearms'], [], 'dumbbell'],
    ['Reverse Wrist Curl (Barbell)', ['forearms'], [], 'barbell'],
    ["Farmer's Walk", ['forearms', 'traps'], ['abs'], 'dumbbell'],
    ['Dead Hang', ['forearms'], ['lats'], 'bodyweight', 'duration'],

    // legs
    ['Squat (Barbell)', ['quads', 'glutes'], ['adductors', 'hamstrings', 'lower_back'], 'barbell'],
    ['Squat (Smith Machine)', ['quads', 'glutes'], ['adductors'], 'smith'],
    ['Squat (Bodyweight)', ['quads', 'glutes'], [], 'bodyweight', 'bodyweight'],
    ['Squat (Dumbbell)', ['quads', 'glutes'], ['adductors'], 'dumbbell'],
    ['Front Squat (Barbell)', ['quads'], ['glutes', 'abs', 'upper_back'], 'barbell'],
    ['Goblet Squat (Kettlebell)', ['quads'], ['glutes', 'adductors'], 'kettlebell'],
    ['Goblet Squat (Dumbbell)', ['quads'], ['glutes', 'adductors'], 'dumbbell'],
    ['Hack Squat', ['quads'], ['glutes', 'adductors'], 'machine'],
    ['Hack Squat (Machine)', ['quads'], ['glutes', 'adductors'], 'machine'],
    ['Pendulum Squat (Machine)', ['quads'], ['glutes'], 'machine'],
    ['Belt Squat (Machine)', ['quads', 'glutes'], ['adductors'], 'machine'],
    ['Leg Press', ['quads'], ['glutes', 'adductors'], 'machine'],
    ['Leg Press (Machine)', ['quads'], ['glutes', 'adductors'], 'machine'],
    ['Seated Leg Press (Machine)', ['quads'], ['glutes', 'adductors'], 'machine'],
    ['Leg Extension (Machine)', ['quads'], [], 'machine'],
    ['Lying Leg Curl (Machine)', ['hamstrings'], ['calves'], 'machine'],
    ['Seated Leg Curl (Machine)', ['hamstrings'], [], 'machine'],
    ['Standing Leg Curl (Machine)', ['hamstrings'], [], 'machine'],
    ['Nordic Hamstring Curl', ['hamstrings'], [], 'bodyweight', 'bodyweight'],
    ['Romanian Deadlift (Barbell)', ['hamstrings', 'glutes'], ['lower_back', 'forearms'], 'barbell'],
    ['Romanian Deadlift (Dumbbell)', ['hamstrings', 'glutes'], ['lower_back', 'forearms'], 'dumbbell'],
    ['Stiff Leg Deadlift (Barbell)', ['hamstrings'], ['glutes', 'lower_back'], 'barbell'],
    ['Bulgarian Split Squat', ['quads', 'glutes'], ['adductors', 'hamstrings'], 'dumbbell'],
    ['Split Squat (Dumbbell)', ['quads', 'glutes'], ['adductors'], 'dumbbell'],
    ['Lunge (Barbell)', ['quads', 'glutes'], ['adductors', 'hamstrings'], 'barbell'],
    ['Lunge (Dumbbell)', ['quads', 'glutes'], ['adductors', 'hamstrings'], 'dumbbell'],
    ['Lunge (Bodyweight)', ['quads', 'glutes'], ['adductors'], 'bodyweight', 'bodyweight'],
    ['Walking Lunge (Dumbbell)', ['quads', 'glutes'], ['adductors', 'hamstrings'], 'dumbbell'],
    ['Reverse Lunge (Dumbbell)', ['glutes', 'quads'], ['hamstrings'], 'dumbbell'],
    ['Step-up (Dumbbell)', ['quads', 'glutes'], ['hamstrings'], 'dumbbell'],
    ['Hip Thrust (Barbell)', ['glutes'], ['hamstrings'], 'barbell'],
    ['Hip Thrust (Machine)', ['glutes'], ['hamstrings'], 'machine'],
    ['Hip Thrust (Smith Machine)', ['glutes'], ['hamstrings'], 'smith'],
    ['Glute Bridge', ['glutes'], ['hamstrings'], 'bodyweight', 'bodyweight'],
    ['Glute Kickback (Cable)', ['glutes'], ['hamstrings'], 'cable'],
    ['Glute Kickback (Machine)', ['glutes'], ['hamstrings'], 'machine'],
    ['Cable Pull Through', ['glutes', 'hamstrings'], ['lower_back'], 'cable'],
    ['Kettlebell Swing', ['glutes', 'hamstrings'], ['lower_back', 'delts_front'], 'kettlebell'],
    ['Hip Abductor (Machine)', ['abductors'], ['glutes'], 'machine'],
    ['Hip Adductor (Machine)', ['adductors'], [], 'machine'],
    ['Standing Calf Raise (Machine)', ['calves'], [], 'machine'],
    ['Standing Calf Raise (Dumbbell)', ['calves'], [], 'dumbbell'],
    ['Standing Calf Raise (Smith Machine)', ['calves'], [], 'smith'],
    ['Standing Calf Raise (Bodyweight)', ['calves'], [], 'bodyweight', 'bodyweight'],
    ['Seated Calf Raise (Plate Loaded)', ['calves'], [], 'machine'],
    ['Seated Calf Raise (Machine)', ['calves'], [], 'machine'],
    ['Calf Press on Leg Press', ['calves'], [], 'machine'],
    ['Calf Press (Machine)', ['calves'], [], 'machine'],

    // core
    ['Crunch', ['abs'], [], 'bodyweight', 'bodyweight'],
    ['Crunch (Machine)', ['abs'], [], 'machine'],
    ['Cable Crunch', ['abs'], ['obliques'], 'cable'],
    ['Decline Crunch', ['abs'], ['obliques'], 'bodyweight', 'bodyweight'],
    ['Bicycle Crunch', ['abs', 'obliques'], [], 'bodyweight', 'bodyweight'],
    ['Sit Up', ['abs'], [], 'bodyweight', 'bodyweight'],
    ['Hanging Leg Raise', ['abs'], ['obliques', 'forearms'], 'bodyweight', 'bodyweight'],
    ['Hanging Knee Raise', ['abs'], ['obliques'], 'bodyweight', 'bodyweight'],
    ["Knee Raise (Captain's Chair)", ['abs'], ['obliques'], 'bodyweight', 'bodyweight'],
    ['Leg Raise', ['abs'], [], 'bodyweight', 'bodyweight'],
    ['Lying Leg Raise', ['abs'], [], 'bodyweight', 'bodyweight'],
    ['Toes To Bar', ['abs'], ['lats', 'forearms'], 'bodyweight', 'bodyweight'],
    ['Ab Wheel', ['abs'], ['lats', 'obliques'], 'other', 'bodyweight'],
    ['Plank', ['abs'], ['obliques'], 'bodyweight', 'duration'],
    ['Side Plank', ['obliques'], ['abs'], 'bodyweight', 'duration'],
    ['Russian Twist', ['obliques'], ['abs'], 'bodyweight', 'bodyweight'],
    ['Cable Twist', ['obliques'], ['abs'], 'cable'],
    ['Woodchopper (Cable)', ['obliques'], ['abs'], 'cable'],
    ['Side Bend (Dumbbell)', ['obliques'], [], 'dumbbell'],
    ['Pallof Press (Cable)', ['obliques', 'abs'], [], 'cable'],
    ['Torso Rotation (Machine)', ['obliques'], ['abs'], 'machine'],

    // Pilates: mat and reformer, reps or a hold
    ['The Hundred', ['abs'], ['obliques', 'delts_front'], 'mat', 'bodyweight'],
    ['Roll Up', ['abs'], ['hamstrings'], 'mat', 'bodyweight'],
    ['Roll Over', ['abs'], ['lower_back'], 'mat', 'bodyweight'],
    ['Single Leg Circles', ['abs', 'adductors'], ['quads'], 'mat', 'bodyweight'],
    ['Rolling Like a Ball', ['abs'], [], 'mat', 'bodyweight'],
    ['Single Leg Stretch', ['abs'], ['obliques'], 'mat', 'bodyweight'],
    ['Double Leg Stretch', ['abs'], ['obliques'], 'mat', 'bodyweight'],
    ['Scissors', ['abs'], ['hamstrings'], 'mat', 'bodyweight'],
    ['Criss Cross', ['obliques', 'abs'], [], 'mat', 'bodyweight'],
    ['Spine Stretch Forward', ['lower_back'], ['hamstrings'], 'mat', 'mobility'],
    ['Saw', ['obliques'], ['hamstrings', 'lower_back'], 'mat', 'bodyweight'],
    ['Swan', ['lower_back'], ['glutes', 'upper_back'], 'mat', 'bodyweight'],
    ['Single Leg Kick', ['hamstrings'], ['glutes'], 'mat', 'bodyweight'],
    ['Swimming (Pilates)', ['lower_back', 'glutes'], ['upper_back', 'delts_rear'], 'mat', 'bodyweight'],
    ['Side Kick', ['abductors', 'glutes'], ['obliques'], 'mat', 'bodyweight'],
    ['Clam Shell', ['abductors'], ['glutes'], 'mat', 'bodyweight'],
    ['Teaser', ['abs'], ['quads', 'obliques'], 'mat', 'bodyweight'],
    ['Leg Pull Front', ['abs'], ['delts_front', 'glutes'], 'mat', 'bodyweight'],
    ['Shoulder Bridge', ['glutes'], ['hamstrings', 'lower_back'], 'mat', 'bodyweight'],
    ['Mermaid', ['obliques'], ['lats'], 'mat', 'mobility'],
    ['Footwork (Reformer)', ['quads', 'calves'], ['glutes', 'hamstrings'], 'reformer'],
    ['Feet in Straps (Reformer)', ['hamstrings', 'adductors'], ['abs', 'glutes'], 'reformer'],
    ['Long Stretch (Reformer)', ['abs'], ['delts_front', 'triceps'], 'reformer'],
    ['Elephant (Reformer)', ['abs'], ['hamstrings', 'lats'], 'reformer'],
    ['Rowing (Reformer)', ['upper_back'], ['delts_rear', 'biceps'], 'reformer'],
    ['Chest Expansion (Reformer)', ['lats', 'triceps'], ['upper_back'], 'reformer'],
    ['Knee Stretches (Reformer)', ['abs'], ['quads', 'delts_front'], 'reformer'],

    // yoga and mobility: held for time
    ['Sun Salutation', ['abs'], ['hamstrings', 'delts_front', 'triceps'], 'mat', 'mobility'],
    ['Downward Dog', ['hamstrings', 'calves'], ['delts_front', 'lats'], 'mat', 'mobility'],
    ['Cat-Cow', ['lower_back'], ['abs'], 'mat', 'mobility'],
    ['Pigeon Pose', ['glutes'], ['abductors'], 'mat', 'mobility'],
    ["Child's Pose", ['lower_back', 'lats'], [], 'mat', 'mobility'],
    ["World's Greatest Stretch", ['adductors', 'hamstrings'], ['obliques', 'upper_back'], 'mat', 'mobility'],
    ['Hip Flexor Stretch', ['quads'], [], 'mat', 'mobility'],
    ['Hamstring Stretch', ['hamstrings'], [], 'mat', 'mobility'],
    ['Thoracic Rotation', ['upper_back', 'obliques'], [], 'mat', 'mobility'],
    ['Deep Squat Hold', ['adductors', 'glutes'], ['calves'], 'bodyweight', 'mobility'],
    ['Foam Rolling', [], [], 'other', 'mobility'],

    // HIIT and conditioning
    ['Burpee', ['quads', 'chest_mid'], ['delts_front', 'triceps', 'abs'], 'bodyweight', 'bodyweight'],
    ['Mountain Climber', ['abs'], ['delts_front', 'quads'], 'bodyweight', 'bodyweight'],
    ['Jumping Jack', ['calves'], ['delts_side', 'abductors'], 'bodyweight', 'bodyweight'],
    ['Jump Squat', ['quads', 'glutes'], ['calves'], 'bodyweight', 'bodyweight'],
    ['Box Jump', ['quads', 'glutes'], ['calves'], 'bodyweight', 'bodyweight'],
    ['Battle Ropes', ['delts_front'], ['abs', 'forearms'], 'other', 'duration'],
    ['Thruster (Barbell)', ['quads', 'delts_front'], ['glutes', 'triceps'], 'barbell'],
    ['Thruster (Dumbbell)', ['quads', 'delts_front'], ['glutes', 'triceps'], 'dumbbell'],
    ['Wall Ball', ['quads', 'delts_front'], ['glutes'], 'other'],
    ['Sled Push', ['quads', 'glutes'], ['calves'], 'other'],
    ['Kettlebell Clean & Press', ['delts_front', 'glutes'], ['triceps', 'hamstrings'], 'kettlebell'],

    // cardio: time and distance, no muscles counted
    ['Running', [], [], 'other', 'cardio', 'running'],
    ['Running (Treadmill)', [], [], 'machine', 'cardio', 'running'],
    ['Intervals (Running)', [], [], 'other', 'cardio', 'running'],
    ['Cycling', [], [], 'other', 'cardio', 'cycling'],
    ['Cycling (Indoor)', [], [], 'machine', 'cardio', 'cycling'],
    ['Spinning', [], [], 'machine', 'cardio', 'cycling'],
    ['Swimming', [], [], 'other', 'cardio', 'swimming'],
    ['Walking', [], [], 'other', 'cardio', 'walking'],
    ['Hiking', [], [], 'other', 'cardio', 'walking'],
    ['Rowing (Machine)', [], [], 'machine', 'cardio', 'cardio'],
    ['Elliptical Trainer', [], [], 'machine', 'cardio', 'cardio'],
    ['Stair Climber', [], [], 'machine', 'cardio', 'cardio'],
    ['Ski Erg', [], [], 'machine', 'cardio', 'cardio'],
    ['Assault Bike', [], [], 'machine', 'cardio', 'hiit'],
    ['Jump Rope', [], [], 'other', 'cardio', 'hiit'],
];

export const EXERCISES: ExerciseInfo[] = CATALOG.map(([name, primary, secondary, equipment, kind, activity]) => ({
    name,
    primary,
    secondary,
    equipment,
    kind: kind ?? 'weight',
    ...(activity ? { activity } : {}),
}));

export const exerciseKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');
const BY_KEY = new Map(EXERCISES.map((e) => [exerciseKey(e.name), e]));
export const catalogExercise = (name: string) => BY_KEY.get(exerciseKey(name));

/* An exercise the catalog does not know (a custom one in Strong, a renamed one): its muscles
 * guessed from the words of its name, the first rule that matches. The user can change them. */
const GUESSES: [RegExp, Muscle[], Muscle[], ExerciseKind?][] = [
    [/run|jog|treadmill|cycl|bike|spin|row(ing)? machine|rowing|ellip|stair|walk|hik|swim|jump rope|cardio/i, [], [], 'cardio'],
    [/stretch|pose|yoga|mobility|foam/i, [], [], 'mobility'],
    [/incline.*(press|fly|push)|low.*fly|upper chest/i, ['chest_upper'], ['chest_mid', 'delts_front', 'triceps']],
    [/decline.*(press|fly)|high.*fly|dip.*chest|chest.*dip/i, ['chest_lower'], ['chest_mid', 'triceps']],
    [/close grip.*bench|tricep|skull|pushdown|kickback|dip/i, ['triceps'], []],
    [/bench|chest|pec|fly|push.?up|crossover/i, ['chest_mid'], ['delts_front', 'triceps']],
    [/hammer|reverse curl|wrist|farmer|grip/i, ['forearms', 'biceps'], []],
    [/curl/i, ['biceps'], ['forearms']],
    [/lateral raise|side raise|upright/i, ['delts_side'], ['traps']],
    [/rear delt|reverse fly|face pull/i, ['delts_rear'], ['upper_back']],
    [/front raise/i, ['delts_front'], []],
    [/overhead press|shoulder press|military|arnold|ohp/i, ['delts_front'], ['delts_side', 'triceps']],
    [/shrug/i, ['traps'], []],
    [/pulldown|pull.?up|chin.?up|pullover/i, ['lats'], ['upper_back', 'biceps']],
    [/row/i, ['upper_back', 'lats'], ['delts_rear', 'biceps']],
    [/romanian|rdl|stiff|good morning|leg curl|hamstring|nordic/i, ['hamstrings'], ['glutes']],
    [/deadlift|back extension|hyperextension/i, ['lower_back', 'glutes', 'hamstrings'], []],
    [/hip thrust|glute|bridge|kickback/i, ['glutes'], ['hamstrings']],
    [/abduct/i, ['abductors'], ['glutes']],
    [/adduct/i, ['adductors'], []],
    [/calf|calves/i, ['calves'], []],
    [/squat|leg press|lunge|step.?up|leg extension|split/i, ['quads'], ['glutes', 'adductors']],
    [/twist|oblique|side bend|woodchop|pallof|rotation/i, ['obliques'], ['abs']],
    [/crunch|sit.?up|leg raise|knee raise|plank|ab |abs|core|toes/i, ['abs'], []],
    [/press/i, ['delts_front'], ['triceps']],
];

export function guessExercise(name: string): ExerciseInfo {
    const known = catalogExercise(name);
    if (known) return known;
    const lower = name.toLowerCase();
    const equipment: Equipment = /barbell|ez bar/.test(lower)
        ? 'barbell'
        : /dumbbell/.test(lower)
          ? 'dumbbell'
          : /cable|rope/.test(lower)
            ? 'cable'
            : /smith/.test(lower)
              ? 'smith'
              : /machine|plate loaded/.test(lower)
                ? 'machine'
                : /kettlebell/.test(lower)
                  ? 'kettlebell'
                  : /band/.test(lower)
                    ? 'band'
                    : /bodyweight/.test(lower)
                      ? 'bodyweight'
                      : 'other';
    for (const [re, primary, secondary, kind] of GUESSES) {
        if (re.test(name)) {
            const k = kind ?? (/assisted/i.test(name) ? 'assisted' : 'weight');
            return { name, primary, secondary, equipment, kind: k, custom: true, ...(k === 'cardio' ? { activity: trackerKind(name) ?? 'cardio' } : {}) };
        }
    }
    return { name, primary: [], secondary: [], equipment, kind: 'weight', custom: true };
}

/* ----------------------------------------------------------------------- */
/* Workouts                                                                 */

export type SetKind = 'normal' | 'warmup' | 'drop' | 'failure';
export const SET_KINDS: SetKind[] = ['normal', 'warmup', 'drop', 'failure'];

export interface GymSet {
    kind: SetKind;
    weight?: number | null; // kg; for 'assisted' the help of the machine
    reps?: number | null;
    seconds?: number | null;
    distance?: number | null; // km
    rpe?: number | null;
    done: boolean;
}

export interface GymExerciseLog {
    name: string;
    notes?: string;
    restSeconds?: number;
    sets: GymSet[];
}

export interface GymWorkout {
    _id: string;
    name: string;
    templateId?: string | null;
    start: number; // ms
    end?: number | null; // null while it runs
    notes?: string;
    kind: WorkoutKind;
    /* app: logged here; strong: imported; tracker: only the fitness tracker saw it (not stored,
     * made from Google Health's sessions when they are read) */
    source: 'app' | 'strong' | 'tracker';
    exercises: GymExerciseLog[];
    updatedAt?: number;
    // a session of the fitness tracker that ran at the same time (Google Health)
    tracker?: { type: string; start: number; end: number; calories: number | null; avgHr: number | null; azm: number | null } | null;
}

export interface TemplateExercise {
    name: string;
    sets: number;
    repsLow: number;
    repsHigh: number;
    restSeconds: number;
    seconds?: number; // a hold or a cardio piece: its time per set
    distance?: number; // km per set, for cardio
}

export interface GymTemplate {
    _id: string;
    name: string;
    kind: WorkoutKind;
    exercises: TemplateExercise[];
    order: number;
    source?: 'default' | 'strong' | 'app';
}

/* The templates the section starts with, until there is history to learn the real ones from:
 * a split for the weights and one of each other kind of training. */
const lift = (name: string, sets: number, repsLow: number, repsHigh: number, restSeconds: number): TemplateExercise => ({ name, sets, repsLow, repsHigh, restSeconds });
const hold = (name: string, sets: number, seconds: number, restSeconds = 15): TemplateExercise => ({ name, sets, repsLow: 0, repsHigh: 0, restSeconds, seconds });
const piece = (name: string, sets: number, seconds?: number, distance?: number, restSeconds = 0): TemplateExercise => ({
    name,
    sets,
    repsLow: 0,
    repsHigh: 0,
    restSeconds,
    ...(seconds ? { seconds } : {}),
    ...(distance ? { distance } : {}),
});

export const DEFAULT_TEMPLATES: Omit<GymTemplate, '_id'>[] = [
    {
        name: 'Chest & Triceps',
        kind: 'strength',
        exercises: [
            lift('Bench Press (Barbell)', 4, 6, 10, 150),
            lift('Incline Bench Press (Dumbbell)', 3, 8, 12, 120),
            lift('Chest Fly (Machine)', 3, 10, 15, 90),
            lift('Chest Dip', 3, 8, 12, 90),
            lift('Triceps Rope Pushdown', 3, 10, 15, 75),
            lift('Overhead Triceps Extension (Cable)', 3, 10, 15, 75),
        ],
    },
    {
        name: 'Back & Biceps',
        kind: 'strength',
        exercises: [
            lift('Lat Pulldown (Cable)', 4, 8, 12, 120),
            lift('Bent Over Row (Barbell)', 3, 6, 10, 150),
            lift('Seated Row (Cable)', 3, 8, 12, 90),
            lift('Straight Arm Pulldown (Cable)', 2, 12, 15, 75),
            lift('Bicep Curl (Barbell)', 3, 8, 12, 75),
            lift('Hammer Curl (Dumbbell)', 3, 10, 12, 75),
        ],
    },
    {
        name: 'Legs',
        kind: 'strength',
        exercises: [
            lift('Squat (Barbell)', 4, 5, 8, 180),
            lift('Romanian Deadlift (Barbell)', 3, 6, 10, 150),
            lift('Leg Press', 3, 10, 15, 120),
            lift('Leg Extension (Machine)', 3, 10, 15, 75),
            lift('Seated Leg Curl (Machine)', 3, 10, 15, 75),
            lift('Standing Calf Raise (Machine)', 4, 10, 15, 60),
        ],
    },
    {
        name: 'Shoulders & Abs',
        kind: 'strength',
        exercises: [
            lift('Overhead Press (Dumbbell)', 4, 6, 10, 150),
            lift('Lateral Raise (Dumbbell)', 4, 12, 20, 60),
            lift('Face Pull (Cable)', 3, 12, 15, 60),
            lift('Shrug (Dumbbell)', 3, 10, 15, 60),
            lift('Cable Crunch', 3, 10, 15, 60),
            lift('Hanging Leg Raise', 3, 8, 15, 60),
        ],
    },
    { name: 'Easy run', kind: 'running', exercises: [piece('Running', 1, 30 * 60, 5)] },
    { name: 'Intervals 6 × 400 m', kind: 'running', exercises: [piece('Running', 1, 10 * 60, 1.5), piece('Intervals (Running)', 6, 0, 0.4, 90), piece('Running', 1, 10 * 60, 1.5)] },
    { name: 'Endurance ride', kind: 'cycling', exercises: [piece('Cycling', 1, 60 * 60, 25)] },
    { name: 'Indoor bike intervals', kind: 'cycling', exercises: [piece('Cycling (Indoor)', 1, 10 * 60), piece('Cycling (Indoor)', 5, 3 * 60, 0, 120), piece('Cycling (Indoor)', 1, 5 * 60)] },
    {
        name: 'Pilates: mat core',
        kind: 'pilates',
        exercises: [
            lift('The Hundred', 1, 100, 100, 15),
            lift('Roll Up', 1, 6, 8, 15),
            lift('Single Leg Circles', 2, 5, 8, 15),
            lift('Single Leg Stretch', 1, 8, 10, 15),
            lift('Double Leg Stretch', 1, 8, 10, 15),
            lift('Criss Cross', 1, 10, 12, 15),
            lift('Swimming (Pilates)', 1, 20, 30, 15),
            lift('Side Kick', 2, 8, 10, 15),
            lift('Shoulder Bridge', 2, 6, 8, 15),
            lift('Teaser', 1, 3, 5, 15),
            hold('Mermaid', 2, 30),
        ],
    },
    {
        name: 'Pilates: reformer',
        kind: 'pilates',
        exercises: [
            lift('Footwork (Reformer)', 3, 10, 12, 15),
            lift('The Hundred', 1, 100, 100, 15),
            lift('Feet in Straps (Reformer)', 2, 8, 10, 15),
            lift('Rowing (Reformer)', 2, 8, 10, 15),
            lift('Chest Expansion (Reformer)', 2, 8, 10, 15),
            lift('Elephant (Reformer)', 2, 8, 10, 15),
            lift('Long Stretch (Reformer)', 2, 5, 8, 15),
            lift('Knee Stretches (Reformer)', 2, 8, 10, 15),
        ],
    },
    {
        name: 'Mobility flow',
        kind: 'yoga',
        exercises: [
            hold('Cat-Cow', 1, 60),
            hold("World's Greatest Stretch", 2, 45),
            hold('Downward Dog', 2, 45),
            hold('Hip Flexor Stretch', 2, 45),
            hold('Pigeon Pose', 2, 60),
            hold('Thoracic Rotation', 2, 30),
            hold('Hamstring Stretch', 2, 45),
            hold("Child's Pose", 1, 60),
        ],
    },
    {
        name: 'HIIT circuit',
        kind: 'hiit',
        exercises: [
            lift('Burpee', 4, 10, 15, 20),
            lift('Kettlebell Swing', 4, 15, 20, 20),
            lift('Mountain Climber', 4, 20, 30, 20),
            lift('Jump Squat', 4, 12, 15, 20),
            hold('Battle Ropes', 4, 30, 60),
        ],
    },
].map((t, order) => ({ ...t, kind: t.kind as WorkoutKind, order, source: 'default' as const }));

/* ----------------------------------------------------------------------- */
/* What the sets say                                                        */

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;

// a set that counts: done, not a warm-up, with reps (or seconds for a hold)
export const isWorkSet = (s: GymSet) => s.done && s.kind !== 'warmup' && ((s.reps ?? 0) > 0 || (s.seconds ?? 0) > 0);

/* The weight one could lift once, from a set of several reps (Epley). Past 12 reps it is only a
 * rough guess, so those sets are counted as if 12: high reps never outrank a heavy set. */
export function e1rm(weight: number | null | undefined, reps: number | null | undefined) {
    if (!weight || weight <= 0 || !reps || reps <= 0) return 0;
    if (reps === 1) return weight;
    return weight * (1 + Math.min(reps, 12) / 30);
}

// stretches and cardio are training, but not the hard sets that grow a muscle
export const countsSets = (x: ExerciseInfo) => x.kind !== 'mobility' && x.kind !== 'cardio';

export const setVolume = (s: GymSet) => (s.weight ?? 0) * (s.reps ?? 0);

export interface ExerciseSession {
    workoutId: string;
    at: number;
    sets: GymSet[]; // the work sets
    best: { weight: number; reps: number; e1rm: number } | null; // the set of the highest e1RM
    topWeight: number;
    volume: number;
    reps: number;
}

export function exerciseSessions(workouts: GymWorkout[], name: string): ExerciseSession[] {
    const key = exerciseKey(name);
    const out: ExerciseSession[] = [];
    for (const w of [...workouts].sort((a, b) => a.start - b.start)) {
        const sets = w.exercises.filter((e) => exerciseKey(e.name) === key).flatMap((e) => e.sets.filter(isWorkSet));
        if (!sets.length) continue;
        let best: ExerciseSession['best'] = null;
        for (const s of sets) {
            const v = e1rm(s.weight, s.reps);
            if (v > 0 && (!best || v > best.e1rm)) best = { weight: s.weight!, reps: s.reps!, e1rm: v };
        }
        out.push({
            workoutId: w._id,
            at: w.start,
            sets,
            best,
            topWeight: Math.max(0, ...sets.map((s) => s.weight ?? 0)),
            volume: sets.reduce((v, s) => v + setVolume(s), 0),
            reps: sets.reduce((v, s) => v + (s.reps ?? 0), 0),
        });
    }
    return out;
}

export interface Records {
    e1rm: { value: number; weight: number; reps: number; at: number } | null;
    weight: { value: number; reps: number; at: number } | null;
    volume: { value: number; at: number } | null;
    reps: { value: number; weight: number; at: number } | null;
}

export function records(sessions: ExerciseSession[]): Records {
    const r: Records = { e1rm: null, weight: null, volume: null, reps: null };
    for (const s of sessions) {
        if (s.best && (!r.e1rm || s.best.e1rm > r.e1rm.value)) r.e1rm = { value: s.best.e1rm, weight: s.best.weight, reps: s.best.reps, at: s.at };
        for (const set of s.sets) {
            const w = set.weight ?? 0;
            if (w > 0 && (!r.weight || w > r.weight.value || (w === r.weight.value && (set.reps ?? 0) > r.weight.reps)))
                r.weight = { value: w, reps: set.reps ?? 0, at: s.at };
            if ((set.reps ?? 0) > 0 && (!r.reps || (set.reps ?? 0) > r.reps.value)) r.reps = { value: set.reps ?? 0, weight: w, at: s.at };
        }
        if (s.volume > 0 && (!r.volume || s.volume > r.volume.value)) r.volume = { value: s.volume, at: s.at };
    }
    return r;
}

export type ExerciseLookup = (name: string) => ExerciseInfo;

/* The hard sets each muscle got: 1 for a muscle the exercise trains first, ½ for one it helps. */
export function setsPerMuscle(workouts: GymWorkout[], info: ExerciseLookup) {
    const out = Object.fromEntries(MUSCLE_IDS.map((m) => [m, 0])) as Record<Muscle, number>;
    for (const w of workouts) {
        for (const e of w.exercises) {
            const x = info(e.name);
            const n = countsSets(x) ? e.sets.filter(isWorkSet).length : 0;
            if (!n) continue;
            for (const m of x.primary) out[m] += n;
            for (const m of x.secondary) out[m] += n / 2;
        }
    }
    return out;
}

/* A group's sets: the sets of an exercise once, by the best credit any of its muscles in the
 * group gets (a bench press is 1 set of chest, not 1 + ½ + ½). */
export function setsPerGroup(workouts: GymWorkout[], info: ExerciseLookup) {
    const out = Object.fromEntries(GROUP_IDS.map((g) => [g, 0])) as Record<MuscleGroup, number>;
    for (const w of workouts) {
        for (const e of w.exercises) {
            const x = info(e.name);
            const n = countsSets(x) ? e.sets.filter(isWorkSet).length : 0;
            if (!n) continue;
            const credit = new Map<MuscleGroup, number>();
            for (const m of x.secondary) credit.set(groupOf(m), Math.max(credit.get(groupOf(m)) ?? 0, 0.5));
            for (const m of x.primary) credit.set(groupOf(m), 1);
            for (const [g, c] of credit) out[g] += n * c;
        }
    }
    return out;
}

// Monday 00:00 local of the week a time falls in
export function weekStart(t: number) {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
}

export interface GroupWeek {
    week: number; // weekStart
    sets: Record<MuscleGroup, number>;
    volume: Record<MuscleGroup, number>; // kg × reps of the exercises that train it first
}

export function weeklyGroups(workouts: GymWorkout[], info: ExerciseLookup, weeks: number, now = Date.now()): GroupWeek[] {
    const first = weekStart(now) - (weeks - 1) * WEEK_MS;
    const out: GroupWeek[] = [];
    for (let i = 0; i < weeks; i++) {
        // the start of each week by the calendar: a week across a clock change is not 7 × 24 h
        const week = weekStart(first + i * WEEK_MS + 12 * 3600_000);
        const next = weekStart(week + WEEK_MS + 12 * 3600_000);
        const inWeek = workouts.filter((w) => w.start >= week && w.start < next);
        const volume = Object.fromEntries(GROUP_IDS.map((g) => [g, 0])) as Record<MuscleGroup, number>;
        for (const w of inWeek)
            for (const e of w.exercises) {
                const groups = new Set(info(e.name).primary.map(groupOf));
                const v = e.sets.filter(isWorkSet).reduce((s, set) => s + setVolume(set), 0);
                for (const g of groups) volume[g] += v;
            }
        out.push({ week, sets: setsPerGroup(inWeek, info), volume });
    }
    return out;
}

/* How the strength of a group went: for each exercise that trains it first, its best e1RM of the
 * recent weeks against the weeks before, the change in %, the median over the exercises
 * (weighted by none: a curl counts as much as a row). Exercises done only in one of the two
 * windows say nothing and are left out. */
export function groupStrengthChange(workouts: GymWorkout[], info: ExerciseLookup, group: MuscleGroup, days = 28, now = Date.now()) {
    const recentFrom = now - days * DAY_MS;
    const beforeFrom = now - 2 * days * DAY_MS;
    const names = new Set<string>();
    for (const w of workouts) for (const e of w.exercises) if (info(e.name).primary.some((m) => groupOf(m) === group)) names.add(e.name);
    const changes: { name: string; change: number }[] = [];
    for (const name of names) {
        const sessions = exerciseSessions(workouts, name).filter((s) => s.best);
        const recent = Math.max(0, ...sessions.filter((s) => s.at >= recentFrom).map((s) => s.best!.e1rm));
        const before = Math.max(0, ...sessions.filter((s) => s.at >= beforeFrom && s.at < recentFrom).map((s) => s.best!.e1rm));
        if (recent > 0 && before > 0) changes.push({ name, change: (recent / before - 1) * 100 });
    }
    if (!changes.length) return null;
    const sorted = changes.map((c) => c.change).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return { change: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2, exercises: changes };
}

/* A group's strength over time: per week the mean over its exercises of the week's best e1RM
 * relative to that exercise's first one (100 = where it started), so exercises of different
 * weights can share one line. */
export function groupStrengthIndex(workouts: GymWorkout[], info: ExerciseLookup, group: MuscleGroup) {
    const names = new Set<string>();
    for (const w of workouts) for (const e of w.exercises) if (info(e.name).primary.some((m) => groupOf(m) === group)) names.add(e.name);
    const perWeek = new Map<number, number[]>();
    for (const name of names) {
        const sessions = exerciseSessions(workouts, name).filter((s) => s.best);
        if (sessions.length < 2) continue;
        const base = sessions[0].best!.e1rm;
        const weekBest = new Map<number, number>();
        for (const s of sessions) weekBest.set(weekStart(s.at), Math.max(weekBest.get(weekStart(s.at)) ?? 0, s.best!.e1rm));
        for (const [week, v] of weekBest) perWeek.set(week, [...(perWeek.get(week) ?? []), (v / base) * 100]);
    }
    return [...perWeek.entries()].sort((a, b) => a[0] - b[0]).map(([week, vs]) => ({ week, index: vs.reduce((s, v) => s + v, 0) / vs.length, exercises: vs.length }));
}

/* ----------------------------------------------------------------------- */
/* The next time: what to lift                                             */

const LOWER_BODY: MuscleGroup[] = ['quads', 'hamstrings', 'glutes', 'calves'];

/* Double progression: reps go up within the range at the same weight; once every work set
 * reached the top of the range, the weight goes up by a step (2.5 kg, 5 kg for the large lower
 * body lifts on a barbell or machine) and the reps start again at the bottom. */
export function suggestNext(session: ExerciseSession | undefined, info: ExerciseInfo, repsLow: number, repsHigh: number) {
    if (!session || !session.sets.length) return null;
    if (info.kind !== 'weight' && info.kind !== 'bodyweight') return null;
    const top = session.topWeight;
    const atTop = session.sets.filter((s) => (s.weight ?? 0) === top);
    const allHigh = atTop.every((s) => (s.reps ?? 0) >= repsHigh);
    const lower = info.primary.some((m) => LOWER_BODY.includes(groupOf(m)));
    const step = info.kind === 'bodyweight' && !top ? 0 : lower && ['barbell', 'machine', 'smith'].includes(info.equipment) ? 5 : 2.5;
    const minReps = Math.min(...atTop.map((s) => s.reps ?? 0));
    if (allHigh && step) return { weight: top + step, reps: repsLow, why: `all sets reached ${repsHigh} reps: add ${step} kg` };
    if (allHigh) return { weight: top, reps: repsHigh + 1, why: `all sets reached ${repsHigh} reps: one more` };
    const target = Math.min(repsHigh, Math.max(repsLow, minReps + 1));
    return { weight: top, reps: target, why: minReps < repsLow ? `below ${repsLow} reps last time: same weight, aim for ${repsLow}` : `same weight, aim for ${target} reps` };
}

/* ----------------------------------------------------------------------- */
/* Advice                                                                   */

export interface GymInsight {
    level: 'good' | 'info' | 'warn';
    group?: MuscleGroup;
    exercise?: string;
    title: string;
    text: string;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/* What the last weeks say about the training: groups below or above the range of sets, groups
 * trained once a week only, exercises that stopped improving, the balance of pushing and pulling
 * and of the front and back of the thigh, and what went well. Needs a few weeks of history. */
export function gymInsights(workouts: GymWorkout[], info: ExerciseLookup, now = Date.now()): GymInsight[] {
    const out: GymInsight[] = [];
    const recent = workouts.filter((w) => w.start >= now - 28 * DAY_MS && w.start <= now);
    if (recent.length < 3) return out;
    const weeksCovered = Math.min(4, Math.max(1, (now - Math.min(...recent.map((w) => w.start))) / WEEK_MS));
    const sets = setsPerGroup(recent, info);
    const perWeek = Object.fromEntries(GROUP_IDS.map((g) => [g, sets[g] / weeksCovered])) as Record<MuscleGroup, number>;

    for (const g of GROUP_IDS) {
        const [low, high] = GROUPS[g].sets;
        const v = perWeek[g];
        if (low > 0 && v < low * 0.6)
            out.push({
                level: 'warn',
                group: g,
                title: `${GROUPS[g].label}: ${round1(v)} sets a week`,
                text: `Well below the ${low}–${high} hard sets a week that grow it. Add ${Math.ceil(low - v)} sets a week, spread over two sessions.`,
            });
        else if (low > 0 && v < low)
            out.push({ level: 'info', group: g, title: `${GROUPS[g].label}: ${round1(v)} sets a week`, text: `A little below ${low}–${high}. One or two more sets a week would help it grow.` });
        else if (v > high * 1.25)
            out.push({
                level: 'info',
                group: g,
                title: `${GROUPS[g].label}: ${round1(v)} sets a week`,
                text: `Above ${high}: more than most people recover from. If its lifts stall, take sets away before adding weight.`,
            });
    }

    // how often each group is trained: twice a week grows more than the same sets once
    for (const g of GROUP_IDS) {
        const [low] = GROUPS[g].sets;
        if (low < 8 || perWeek[g] < low * 0.6) continue;
        const trained = recent.filter((w) => w.exercises.some((e) => e.sets.some(isWorkSet) && info(e.name).primary.some((m) => groupOf(m) === g)));
        const days = new Set(trained.map((w) => new Date(w.start).toDateString()));
        const perWeekDays = days.size / weeksCovered;
        if (perWeekDays < 1.3)
            out.push({
                level: 'info',
                group: g,
                title: `${GROUPS[g].label} once a week`,
                text: `All its sets come in one session. Splitting them over two days a week (e.g. a few sets in another workout) usually grows more for the same work.`,
            });
    }

    // exercises that stopped improving: done 4 times or more in 6 weeks, the last 3 not above the best before
    const names = new Set(workouts.filter((w) => w.start >= now - 42 * DAY_MS).flatMap((w) => w.exercises.map((e) => e.name)));
    for (const name of names) {
        const x = info(name);
        if (x.kind === 'cardio' || x.kind === 'duration') continue;
        const sessions = exerciseSessions(workouts, name).filter((s) => s.best && s.at >= now - 42 * DAY_MS);
        if (sessions.length < 4) continue;
        const last = sessions.slice(-3);
        const before = sessions.slice(0, -3);
        const bestBefore = Math.max(...before.map((s) => s.best!.e1rm));
        const bestLast = Math.max(...last.map((s) => s.best!.e1rm));
        if (bestLast <= bestBefore * 1.005)
            out.push({
                level: 'warn',
                exercise: name,
                group: x.primary[0] ? groupOf(x.primary[0]) : undefined,
                title: `${name} has stalled`,
                text: `No better set in the last 3 sessions. Try a different rep range (e.g. ${sessions[0].best!.reps > 8 ? '5–8' : '10–15'}), a variation of it, or a lighter week, then build again.`,
            });
        else {
            const first = sessions[0].best!.e1rm;
            const gain = (bestLast / first - 1) * 100;
            if (gain >= 5) out.push({ level: 'good', exercise: name, title: `${name} +${Math.round(gain)} %`, text: `Estimated 1RM up from ${round1(first)} to ${round1(bestLast)} kg in 6 weeks.` });
        }
    }

    // balance
    const push = perWeek.chest + perWeek.triceps / 2;
    const pull = perWeek.back + perWeek.biceps / 2;
    if (push > 6 && pull < push * 0.75)
        out.push({
            level: 'warn',
            title: 'More pushing than pulling',
            text: `${round1(push)} pushing against ${round1(pull)} pulling sets a week. Rows and pulldowns as much as presses keep the shoulders healthy and the posture upright.`,
        });
    if (perWeek.quads > 6 && perWeek.hamstrings < perWeek.quads * 0.5)
        out.push({
            level: 'info',
            group: 'hamstrings',
            title: 'Hamstrings behind the quads',
            text: `${round1(perWeek.hamstrings)} against ${round1(perWeek.quads)} sets a week. A Romanian deadlift or leg curl in every leg day balances the knee.`,
        });
    const rear = setsPerMuscle(recent, info).delts_rear / weeksCovered;
    if (perWeek.chest > 8 && rear < 4)
        out.push({ level: 'info', group: 'shoulders', title: 'Few sets for the rear delts', text: `${round1(rear)} a week. Face pulls or reverse flies (6+ sets a week) balance all the pressing.` });

    // the groups with gains
    for (const g of GROUP_IDS) {
        const c = groupStrengthChange(workouts, info, g, 28, now);
        if (c && c.change >= 3 && c.exercises.length >= 2)
            out.push({ level: 'good', group: g, title: `${GROUPS[g].label} stronger`, text: `+${round1(c.change)} % estimated 1RM over the last 4 weeks (median of ${c.exercises.length} exercises).` });
    }

    const rank = { warn: 0, info: 1, good: 2 };
    return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/* ----------------------------------------------------------------------- */

/* Templates from history: each workout name done twice or more becomes one, with the exercises
 * of its latest session in their order, as many sets as were done and the reps that were. */
export function templatesFromHistory(workouts: GymWorkout[], min = 2): Omit<GymTemplate, '_id'>[] {
    const byName = new Map<string, GymWorkout[]>();
    for (const w of workouts) {
        const key = w.name.trim();
        if (!key) continue;
        byName.set(key, [...(byName.get(key) ?? []), w]);
    }
    const out: Omit<GymTemplate, '_id'>[] = [];
    const named = [...byName.entries()].filter(([, ws]) => ws.length >= min).sort((a, b) => b[1].length - a[1].length);
    for (const [name, ws] of named) {
        const latest = ws.reduce((a, b) => (b.start > a.start ? b : a));
        const exercises: TemplateExercise[] = [];
        for (const e of latest.exercises) {
            const work = e.sets.filter((s) => s.kind !== 'warmup' && ((s.reps ?? 0) > 0 || (s.seconds ?? 0) > 0 || (s.distance ?? 0) > 0));
            if (!work.length && !e.sets.length) continue;
            const reps = work.map((s) => s.reps ?? 0).filter((r) => r > 0).sort((a, b) => a - b);
            const low = reps.length ? reps[0] : 0;
            const high = reps.length ? Math.max(reps[reps.length - 1], low + 2) : 0;
            const seconds = Math.max(0, ...work.map((s) => s.seconds ?? 0));
            const distance = Math.max(0, ...work.map((s) => s.distance ?? 0));
            exercises.push({
                name: e.name,
                sets: Math.max(1, work.length || e.sets.length),
                repsLow: low,
                repsHigh: high,
                restSeconds: e.restSeconds ?? 90,
                ...(seconds ? { seconds } : {}),
                ...(distance ? { distance } : {}),
            });
        }
        if (exercises.length) out.push({ name, kind: latest.kind, exercises, order: out.length, source: 'strong' });
    }
    return out;
}

/* ----------------------------------------------------------------------- */
/* Everything that was done                                                 */

export const workoutMinutes = (w: GymWorkout) => (w.end && w.end > w.start ? (w.end - w.start) / 60_000 : 0);

export interface ActivityWeek {
    week: number;
    sessions: number;
    minutes: number;
    byKind: Partial<Record<WorkoutKind, { sessions: number; minutes: number }>>;
}

/* Every workout of the week, whatever its kind and wherever it was logged: the sessions and the
 * minutes, in all and by kind. */
export function weeklyActivity(workouts: GymWorkout[], weeks: number, now = Date.now()): ActivityWeek[] {
    const first = weekStart(now) - (weeks - 1) * WEEK_MS;
    const out: ActivityWeek[] = [];
    for (let i = 0; i < weeks; i++) {
        const week = weekStart(first + i * WEEK_MS + 12 * 3600_000);
        const next = weekStart(week + WEEK_MS + 12 * 3600_000);
        const row: ActivityWeek = { week, sessions: 0, minutes: 0, byKind: {} };
        for (const w of workouts) {
            if (w.start < week || w.start >= next || !w.end) continue;
            const m = workoutMinutes(w);
            row.sessions++;
            row.minutes += m;
            const k = (row.byKind[w.kind] ??= { sessions: 0, minutes: 0 });
            k.sessions++;
            k.minutes += m;
        }
        out.push(row);
    }
    return out;
}

/* A cardio exercise's totals: time, distance and the pace or speed it makes. */
export function cardioTotals(e: GymExerciseLog) {
    const sets = e.sets.filter((s) => s.done && s.kind !== 'warmup');
    const seconds = sets.reduce((v, s) => v + (s.seconds ?? 0), 0);
    const distance = sets.reduce((v, s) => v + (s.distance ?? 0), 0);
    return { seconds, distance, paceSecPerKm: distance > 0 && seconds > 0 ? seconds / distance : null, kmh: distance > 0 && seconds > 0 ? distance / (seconds / 3600) : null };
}
