// Exercise categories: the keyword guesser, and the library-first resolver
// that repairs categories the old guesser wrote at import.
//   node test/unit/categorize.test.mjs
import { guessCategory, legacyGuessCategory, makeCategoryResolver } from '../../workout/categorize.js';
import { EXERCISES, CATEGORIES } from '../../workout/exercises.js';

let pass = 0, fail = 0;
const eq = (a, b, m) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  ok ? pass++ : (fail++, console.log(`FAIL ${m}\n  got      ${JSON.stringify(a)}\n  expected ${JSON.stringify(b)}`));
};

// Every name from the import bug report, plus neighbours that the fix must not break.
const cases = {
  'Leg Press (Machine)': 'Quads', 'Leg Extension (Machine)': 'Quads', 'Lying Leg Curl (Machine)': 'Hamstrings',
  'Seated Shoulder Press (Machine)': 'Shoulders', 'Calf Extension (Machine)': 'Calves', 'Preacher Curl (Machine)': 'Biceps',
  'Single Arm Lateral Raise (Cable)': 'Shoulders', 'Iso Lateral Shoulder Press': 'Shoulders', 'Leg Press Horizontal (Plates)': 'Quads',
  'Shrug (Cable)': 'Back', 'Cable Pull Through': 'Glutes',
  'Rear Delt Reverse Fly': 'Shoulders', 'Chest Supported Incline Row': 'Back', 'Triceps Dip': 'Triceps',
  'Ab Crunch (Bench)': 'Core', 'Leg Raises (Bench)': 'Core',
  'Overhead Triceps Extension': 'Triceps', 'Overhead Curl (Cable)': 'Biceps',
  'Back Extension': 'Back', 'Single Leg Extensions': 'Quads',
  'single lying leg curl': 'Hamstrings', 'Parallel Bar Ab Curls': 'Core',
  'Romanian Deadlift (Barbell)': 'Hamstrings', 'Hip Thrust': 'Glutes', 'Glute Kickback': 'Glutes',
  'Face Pull': 'Shoulders', 'Punch Bag': 'Cardio', 'incline walk': 'Cardio', 'Cycling': 'Cardio',
  'sauna': null, 'Steam': null,
  'Bench Press (Barbell)': 'Chest', 'Incline Dumbbell Fly': 'Chest', 'Chest Dip': 'Chest', 'Cable Crossover': 'Chest',
  'Close Grip Bench Press': 'Triceps', 'Triceps Kickback (Dumbbell)': 'Triceps', 'Kickback (Dumbbell)': 'Triceps',
  'Lat Pulldown (Cable)': 'Back', 'Chin Up': 'Back', 'Seated Row (Machine)': 'Back', 'Deadlift (Barbell)': 'Back',
  'Upright Row (Barbell)': 'Shoulders', 'Hammer Curl (Dumbbell)': 'Biceps', 'Squat (Barbell)': 'Quads',
  'Bulgarian Split Squat': 'Quads', 'Hip Abduction (Machine)': 'Glutes', 'Hanging Leg Raise': 'Core',
  'Standing Calf Raise': 'Calves', 'Push Press': 'Shoulders', 'Rowing Machine': 'Cardio',
};
for (const [name, cat] of Object.entries(cases)) eq(guessCategory(name), cat, name);

// Resolver: library first (exact, then base name when every variant agrees)…
const categoryOf = makeCategoryResolver({ exercises: EXERCISES, categories: CATEGORIES });
eq(categoryOf('Bench Press (Barbell)', 'Back'), 'Chest', 'library beats a stored value');
eq(categoryOf('Shrug (Cable)', 'Core'), 'Back', 'exact library name');
// …then a stored value the old guesser did NOT write (user/coach-set)…
eq(categoryOf('Zercher Thing', 'Glutes'), 'Glutes', 'non-legacy stored value is kept');
// …otherwise the new guess, else Other.
eq(legacyGuessCategory('Single Arm Lateral Raise (Cable)'), 'Back', 'old guesser really did this');
eq(categoryOf('Single Arm Lateral Raise (Cable)', 'Back'), 'Shoulders', 'legacy guess replaced');
eq(categoryOf('sauna', 'Back'), 'Other', 'legacy fallback becomes Other');
eq(categoryOf('Romanian Deadlift (Barbell)', 'Back'), 'Hamstrings', 'ambiguous base name falls through to the guess');
// Aliases: a merged variation takes its canonical lift's category.
const aliased = makeCategoryResolver({ exercises: EXERCISES, categories: CATEGORIES,
  canonicalName: n => (n === 'My Bench' ? 'Bench Press (Barbell)' : n) });
eq(aliased('My Bench', 'Back'), 'Chest', 'alias');

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
