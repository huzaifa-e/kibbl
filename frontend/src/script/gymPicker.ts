import { EXERCISES, GROUPS, GROUP_IDS, MUSCLES, exerciseKey, groupOf, type ExerciseInfo, type MuscleGroup } from '../../../shared/gym';
import { esc, info, isFavorite, logged, sheet, state, thumb } from './gymCommon';

/* Choosing an exercise: the catalog with the user's own, searched by name or muscle, filtered
 * by group (or cardio, mobility), the ones done most often first. A name nobody knows yet can
 * be taken as it is: it becomes an exercise of the user's own. */

type Filter = MuscleGroup | 'cardio' | 'mobility' | 'pilates' | 'all' | 'favorites';

export function allExercises(): ExerciseInfo[] {
    const seen = new Map<string, ExerciseInfo>();
    for (const e of EXERCISES) seen.set(exerciseKey(e.name), e);
    for (const e of state.data.exercises) seen.set(exerciseKey(e.name), e);
    // names met in the history that neither knows (an import before the exercise was kept)
    for (const w of state.data.workouts) for (const e of w.exercises) if (!seen.has(exerciseKey(e.name))) seen.set(exerciseKey(e.name), info(e.name));
    return [...seen.values()];
}

export function useCounts() {
    const counts = new Map<string, number>();
    for (const w of logged()) for (const e of w.exercises) counts.set(exerciseKey(e.name), (counts.get(exerciseKey(e.name)) ?? 0) + 1);
    return counts;
}

// favorites first, then the ones done most, then by name
export const byUse = (counts: Map<string, number>) => (a: ExerciseInfo, b: ExerciseInfo) =>
    Number(isFavorite(b.name)) - Number(isFavorite(a.name)) || (counts.get(exerciseKey(b.name)) ?? 0) - (counts.get(exerciseKey(a.name)) ?? 0) || a.name.localeCompare(b.name);

export const matchesFilter = (e: ExerciseInfo, f: Filter) =>
    f === 'all'
        ? true
        : f === 'favorites'
          ? isFavorite(e.name)
          : f === 'cardio'
          ? e.kind === 'cardio'
          : f === 'mobility'
            ? e.kind === 'mobility'
            : f === 'pilates'
              ? e.equipment === 'mat' || e.equipment === 'reformer'
              : e.primary.some((m) => groupOf(m) === f);

export const FILTERS: [Filter, string][] = [
    ['all', 'All'],
    ['favorites', '★ Favorites'],
    ...GROUP_IDS.map((g) => [g, GROUPS[g].label] as [Filter, string]),
    ['pilates', 'Pilates'],
    ['mobility', 'Mobility'],
    ['cardio', 'Cardio'],
];

export const muscleText = (e: ExerciseInfo) => [...new Set(e.primary.map((m) => MUSCLES[m].label))].join(', ') || (e.kind === 'cardio' ? 'Cardio' : 'No muscles set');

export function pickExercise(onPick: (name: string) => void, title = 'Add exercise') {
    let filter: Filter = 'all';
    let query = '';
    const counts = useCounts();
    const s = sheet(
        title,
        `<div class="gym-picker">
            <input type="search" class="form-control mb-2" placeholder="Search exercises or muscles" data-q autocomplete="off" />
            <div class="gym-chips mb-2" data-filters>${FILTERS.map(([f, l]) => `<button class="gym-chip${f === 'all' ? ' on' : ''}" data-f="${f}">${l}</button>`).join('')}</div>
            <div class="list-group list-group-flush" data-list></div>
        </div>`,
        { size: 'lg' },
    );
    const list = s.el.querySelector<HTMLElement>('[data-list]')!;
    const draw = () => {
        const q = query.trim().toLowerCase();
        const rows = allExercises()
            .filter((e) => matchesFilter(e, filter))
            .filter((e) => !q || e.name.toLowerCase().includes(q) || muscleText(e).toLowerCase().includes(q))
            .sort(byUse(counts))
            .slice(0, 120);
        const exact = rows.some((e) => e.name.toLowerCase() === q);
        list.innerHTML =
            (q && !exact
                ? `<button class="list-group-item list-group-item-action d-flex align-items-center gap-3" data-name="${esc(query.trim())}">
                    <span class="gym-noimg" style="width:44px;height:44px"><i class="ti ti-plus"></i></span>
                    <div><div class="fw-bold">“${esc(query.trim())}”</div><div class="text-secondary small">a new exercise of your own</div></div></button>`
                : '') +
            rows
                .map(
                    (e) => `<button class="list-group-item list-group-item-action d-flex align-items-center gap-3" data-name="${esc(e.name)}">
                        ${thumb(e.name, 48)}
                        <div class="flex-fill min-w-0"><div class="fw-bold text-truncate">${isFavorite(e.name) ? '<i class="ti ti-star-filled text-warning me-1"></i>' : ''}${esc(e.name)}</div>
                        <div class="text-secondary small text-truncate">${esc(muscleText(e))}${counts.get(exerciseKey(e.name)) ? ` · ${counts.get(exerciseKey(e.name))}×` : ''}</div></div></button>`,
                )
                .join('');
    };
    draw();
    s.el.querySelector<HTMLInputElement>('[data-q]')!.addEventListener('input', (e) => {
        query = (e.target as HTMLInputElement).value;
        draw();
    });
    s.el.querySelector('[data-filters]')!.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-f]');
        if (!b) return;
        filter = b.dataset.f as Filter;
        s.el.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === b));
        draw();
    });
    list.addEventListener('click', (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>('[data-name]');
        if (!b) return;
        onPick(b.dataset.name!);
        s.close();
    });
}
