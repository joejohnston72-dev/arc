// Muscle-group category for an exercise name. Pure (no db), so it runs under node.
//   guessCategory(name)        → keyword guess, or null when nothing matches.
//   legacyGuessCategory(name)  → the pre-v95 guesser, kept ONLY to recognise
//                                 categories it wrote (see makeCategoryResolver).
//   makeCategoryResolver(...)  → categoryOf(name, stored): library first, then
//                                 the stored value, then the guess, then 'Other'.

// Ordered: the first match wins, so specific phrases sit above the single words
// that would otherwise catch them ("leg curl" before "curl", "rear delt" before
// "fly", "overhead triceps" before "overhead"). Whole words only — substring
// matching put "Machine" under Back (chin), "Lateral" under Back (lat) and
// "Cable" under Core (ab).
const RULES = [
  [/\btriceps? kick ?backs?\b|^(?!.*glute).*\bkick ?backs? \(dumbbell\)/, 'Triceps'],
  [/\b(leg curls?|hamstrings?|romanian|rdl|good ?mornings?|(stiff|straight)[ -]?legg?(ed)? deadlifts?|nordic)\b/, 'Hamstrings'],
  [/\b(hip thrusts?|glutes?|kickbacks?|abduct(ion|or)?s?|pull[ -]?throughs?|glute bridges?|bridges?|frog pumps?)\b/, 'Glutes'],
  [/\b(calf|calves)\b/, 'Calves'],
  [/\b(rear delts?|reverse fly(es)?|reverse pec deck|face ?pulls?|lateral raises?|front raises?|shoulders?|overhead press(es)?|military press|push press|arnold|upright rows?|delts?)\b/, 'Shoulders'],
  [/\b(chest dips?)\b/, 'Chest'],
  [/\b(overhead (triceps?|extensions?)|triceps?|pushdowns?|push[ -]?downs?|skull ?crushers?|close[ -]?grip|dips?|jm press)\b/, 'Triceps'],
  [/\b(back extensions?|hyper ?extensions?|reverse hypers?)\b/, 'Back'],
  [/\b(leg extensions?|leg press(es)?|squats?|hack|lunges?|split squats?|step[ -]?ups?|sissy|adduct(ion|or)?s?)\b/, 'Quads'],
  [/\b(crunch(es)?|planks?|abs?|core|obliques?|leg raises?|knee raises?|toes[ -]?to[ -]?bar|pallof|dragon flags?|ab (curls?|wheel|rollouts?)|russian twists?|sit[ -]?ups?|wood ?chop(per)?s?|dead ?bugs?|hollow)\b/, 'Core'],
  [/\b(curls?|biceps?|preacher|hammer)\b/, 'Biceps'],
  [/\b(chest supported rows?|rows?|pull[ -]?ups?|chin[ -]?ups?|lats?|lat pull ?downs?|pull ?downs?|pullovers?|deadlifts?|shrugs?|rack pulls?)\b/, 'Back'],
  [/\b(bench|chest|fly|flyes|flys|pecs?|pec deck|crossovers?|push[ -]?ups?|press[ -]?ups?)\b/, 'Chest'],
  [/\b(run(ning)?|walk(ing)?|cycling|cycle|bike|spin|stairs?|stair ?master|treadmill|elliptical|rower|rowing machine|ski ?erg|swim(ming)?|punch(ing)? bag|boxing|jump rope|skipping|hiit|cardio)\b/, 'Cardio'],
];

export function guessCategory(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, cat] of RULES) if (re.test(n)) return cat;
  return null;
}

// The guesser every import and catalogue entry used before v95, verbatim.
export function legacyGuessCategory(name) {
  const n = String(name || '').toLowerCase();
  if (/bench|chest|fly|pec|push.?up|dip/.test(n))                      return 'Chest';
  if (/deadlift|row|pull.?up|chin|lat|pulldown|face.?pull/.test(n))    return 'Back';
  if (/shoulder|press.*over|overhead|lateral|delt|arnold/.test(n))     return 'Shoulders';
  if (/curl|bicep/.test(n))                                             return 'Biceps';
  if (/tricep|pushdown|skull|close.?grip|extension/.test(n))           return 'Triceps';
  if (/squat|leg.?press|hack|lunge|split|sissy/.test(n))               return 'Quads';
  if (/leg.?curl|hamstring|romanian|rdl|good.?morning/.test(n))        return 'Hamstrings';
  if (/hip.?thrust|glute|kickback|abduct/.test(n))                     return 'Glutes';
  if (/calf|calves/.test(n))                                            return 'Calves';
  if (/plank|crunch|ab|core|oblique|dragon|pallof|leg.?raise/.test(n)) return 'Core';
  if (/run|cardio|bike|cycle|row.*machine|stair|rope/.test(n))         return 'Cardio';
  return 'Back';
}

// A stored category is trusted unless it is exactly what the old guesser would
// have written for that name — then it was a guess, and the new guess replaces it.
export function wasLegacyGuess(name, stored) {
  return !!stored && stored === legacyGuessCategory(name);
}

const baseName = n => n.replace(/\s*\([^)]*\)\s*$/, '').trim();

// exercises: the resolved library (built-ins with overrides applied + customs),
// each {name, category}. A name matches exactly (case-insensitive), then via its
// alias, then by its base name without the "(Equipment)" suffix — but only when
// every library variant of that base agrees on the category.
export function makeCategoryResolver({ exercises = [], categories = [], canonicalName = n => n }) {
  const valid = new Set(categories);
  const exact = new Map(), byBase = new Map();
  for (const e of exercises) {
    if (!e?.name || !valid.has(e.category)) continue;
    const k = e.name.toLowerCase();
    exact.set(k, e.category);
    const b = baseName(k);
    byBase.set(b, byBase.has(b) && byBase.get(b) !== e.category ? null : e.category);
  }
  const lookup = name => {
    const k = String(name || '').toLowerCase();
    if (exact.has(k)) return exact.get(k);
    const c = String(canonicalName(name) || '').toLowerCase();
    if (exact.has(c)) return exact.get(c);
    return byBase.get(baseName(k)) || null;
  };
  return function categoryOf(name, stored) {
    const lib = lookup(name);
    if (lib) return lib;
    if (valid.has(stored) && !wasLegacyGuess(name, stored)) return stored;
    return guessCategory(name) || 'Other';
  };
}
