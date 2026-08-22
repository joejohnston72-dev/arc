// Evidence-based routine library for experienced lifters, prioritising time efficiency.
// Design principles applied throughout:
//  - Each muscle group trained ≥2x/week (frequency drives hypertrophy more than
//    single-session volume — Schoenfeld et al. 2016 meta-analysis)
//  - Compound lifts first while fresh, isolation/accessory work after
//  - Landmark volume kept in the ~10-18 hard sets/muscle/week range, not padded
//  - Rest periods: 2-3min on heavy compounds (strength retention), 60-90s on
//    accessories (time-efficient without sacrificing hypertrophy — Schoenfeld 2016
//    rest-period study found short rest fine for smaller lifts)
//  - No redundant exercise overlap within a session — every set earns its place
//  - Sessions sized to land in 45-60 min for an experienced, efficient lifter
//
// Each split = array of day-templates, each shaped exactly like a saved routine
// template: { name, exercises: [{ name, category, restTime, sets: [{weight, reps, type}] }] }
// `sets` entries carry a target rep as a placeholder rep count (weight left at 0
// for the user to fill in) so the log pre-populates with the intended rep target.

function ex(name, category, restTime, repTargets) {
  return {
    name, category, restTime,
    sets: repTargets.map(reps => ({ weight: 0, reps, type: 'normal' })),
  };
}

export const ROUTINE_LIBRARY = [
  {
    id: 'ppl-6day',
    name: 'Push / Pull / Legs (6-day)',
    tagline: 'Highest frequency + volume ceiling. Each muscle trained 2x/week.',
    meta: '6 days/week · ~50-55 min/session',
    days: [
      {
        name: 'Push A (Chest-focus)',
        exercises: [
          ex('Bench Press (Barbell)',        'Chest',     150, [5,5,5,5]),
          ex('Incline Bench Press (Dumbbell)','Chest',     120, [8,8,8]),
          ex('Overhead Press (Barbell)',      'Shoulders', 120, [6,6,6]),
          ex('Cable Fly',                     'Chest',     75,  [12,12]),
          ex('Lateral Raise (Dumbbell)',      'Shoulders', 60,  [15,15,15]),
          ex('Tricep Pushdown (Cable)',       'Triceps',   60,  [12,12]),
        ],
      },
      {
        name: 'Pull A (Back-width-focus)',
        exercises: [
          ex('Deadlift (Barbell)',            'Back',      180, [5,5,3]),
          ex('Pull Up',                       'Back',      120, [8,8,8]),
          ex('Seated Cable Row',              'Back',      90,  [10,10,10]),
          ex('Face Pull',                     'Back',      60,  [15,15]),
          ex('Barbell Curl',                  'Biceps',    60,  [10,10]),
          ex('Hammer Curl',                   'Biceps',    60,  [12,12]),
        ],
      },
      {
        name: 'Legs A (Quad-focus)',
        exercises: [
          ex('Squat (Barbell)',               'Quads',     180, [5,5,5,5]),
          ex('Romanian Deadlift',             'Hamstrings',120, [8,8,8]),
          ex('Leg Press',                     'Quads',     90,  [10,10,10]),
          ex('Leg Curl (Lying)',              'Hamstrings',60,  [12,12]),
          ex('Calf Raise (Standing Machine)', 'Calves',    60,  [15,15,15]),
        ],
      },
      {
        name: 'Push B (Shoulder-focus)',
        exercises: [
          ex('Overhead Press (Dumbbell)',     'Shoulders', 120, [8,8,8]),
          ex('Incline Bench Press (Barbell)', 'Chest',     120, [6,6,6]),
          ex('Machine Chest Press',           'Chest',     90,  [10,10]),
          ex('Lateral Raise (Cable)',         'Shoulders', 60,  [15,15,15]),
          ex('Chest Dip',                     'Chest',     75,  [10,10]),
          ex('Overhead Tricep Extension',     'Triceps',   60,  [12,12]),
        ],
      },
      {
        name: 'Pull B (Back-thickness-focus)',
        exercises: [
          ex('Bent Over Row (Barbell)',       'Back',      150, [6,6,6]),
          ex('Lat Pulldown',                  'Back',      90,  [10,10,10]),
          ex('T-Bar Row',                     'Back',      90,  [10,10]),
          ex('Straight Arm Pulldown',         'Back',      60,  [12,12]),
          ex('Incline Dumbbell Curl',         'Biceps',    60,  [12,12]),
          ex('Cable Curl',                    'Biceps',    60,  [12,12]),
        ],
      },
      {
        name: 'Legs B (Posterior-chain-focus)',
        exercises: [
          ex('Front Squat',                   'Quads',     150, [6,6,6]),
          ex('Hip Thrust (Barbell)',          'Glutes',    120, [8,8,8]),
          ex('Bulgarian Split Squat',         'Quads',     90,  [10,10]),
          ex('Leg Curl (Seated)',             'Hamstrings',60,  [12,12]),
          ex('Calf Raise (Leg Press)',        'Calves',    60,  [15,15,15]),
        ],
      },
    ],
  },

  {
    id: 'ppl-3day',
    name: 'Push / Pull / Legs (3-day)',
    tagline: 'Same PPL structure, once through per week — for tighter schedules.',
    meta: '3 days/week · ~55-60 min/session',
    days: [
      {
        name: 'Push',
        exercises: [
          ex('Bench Press (Barbell)',        'Chest',     150, [5,5,5,5]),
          ex('Overhead Press (Barbell)',     'Shoulders', 120, [6,6,6]),
          ex('Incline Bench Press (Dumbbell)','Chest',    90,  [10,10,10]),
          ex('Lateral Raise (Dumbbell)',     'Shoulders', 60,  [15,15,15]),
          ex('Chest Dip',                    'Chest',     75,  [10,10]),
          ex('Tricep Pushdown (Cable)',      'Triceps',   60,  [12,12]),
        ],
      },
      {
        name: 'Pull',
        exercises: [
          ex('Deadlift (Barbell)',           'Back',      180, [5,5,3]),
          ex('Pull Up',                      'Back',      120, [8,8,8]),
          ex('Bent Over Row (Barbell)',      'Back',      120, [8,8,8]),
          ex('Face Pull',                    'Back',      60,  [15,15]),
          ex('Barbell Curl',                 'Biceps',    60,  [10,10]),
          ex('Hammer Curl',                  'Biceps',    60,  [12,12]),
        ],
      },
      {
        name: 'Legs',
        exercises: [
          ex('Squat (Barbell)',              'Quads',     180, [5,5,5,5]),
          ex('Romanian Deadlift',            'Hamstrings',120, [8,8,8]),
          ex('Leg Press',                    'Quads',     90,  [10,10,10]),
          ex('Leg Curl (Lying)',             'Hamstrings',60,  [12,12]),
          ex('Calf Raise (Standing Machine)','Calves',    60,  [15,15,15]),
        ],
      },
    ],
  },

  {
    id: 'upper-lower-4day',
    name: 'Upper / Lower (4-day)',
    tagline: 'Best time-efficiency-to-frequency ratio. The go-to for most lifters.',
    meta: '4 days/week · ~50 min/session',
    days: [
      {
        name: 'Upper A (Strength)',
        exercises: [
          ex('Bench Press (Barbell)',        'Chest',     150, [5,5,5,5]),
          ex('Bent Over Row (Barbell)',      'Back',      150, [5,5,5,5]),
          ex('Overhead Press (Barbell)',     'Shoulders', 120, [6,6,6]),
          ex('Lat Pulldown',                 'Back',      90,  [10,10]),
          ex('Barbell Curl',                 'Biceps',    60,  [10,10]),
          ex('Tricep Pushdown (Cable)',      'Triceps',   60,  [10,10]),
        ],
      },
      {
        name: 'Lower A (Strength)',
        exercises: [
          ex('Squat (Barbell)',              'Quads',     180, [5,5,5,5]),
          ex('Romanian Deadlift',            'Hamstrings',120, [8,8,8]),
          ex('Leg Press',                    'Quads',     90,  [10,10]),
          ex('Calf Raise (Standing Machine)','Calves',    60,  [15,15,15]),
          ex('Leg Raise (Hanging)',          'Core',      60,  [12,12]),
        ],
      },
      {
        name: 'Upper B (Hypertrophy)',
        exercises: [
          ex('Incline Bench Press (Dumbbell)','Chest',    90,  [10,10,10]),
          ex('Seated Cable Row',             'Back',      90,  [10,10,10]),
          ex('Arnold Press',                 'Shoulders', 90,  [10,10]),
          ex('Pull Up',                      'Back',      90,  [8,8,8]),
          ex('Lateral Raise (Dumbbell)',     'Shoulders', 60,  [15,15,15]),
          ex('Incline Dumbbell Curl',        'Biceps',    60,  [12,12]),
          ex('Skull Crusher',                'Triceps',   60,  [12,12]),
        ],
      },
      {
        name: 'Lower B (Hypertrophy)',
        exercises: [
          ex('Front Squat',                  'Quads',     120, [8,8,8]),
          ex('Hip Thrust (Barbell)',         'Glutes',    120, [8,8,8]),
          ex('Bulgarian Split Squat',        'Quads',     90,  [10,10]),
          ex('Leg Curl (Lying)',             'Hamstrings',60,  [12,12]),
          ex('Calf Raise (Leg Press)',       'Calves',    60,  [15,15,15]),
          ex('Cable Crunch',                 'Core',      60,  [15,15]),
        ],
      },
    ],
  },

  {
    id: 'full-body-3day',
    name: 'Full Body (3-day)',
    tagline: 'Highest frequency per exercise (3x/week/lift) in minimum days — very time-efficient.',
    meta: '3 days/week · ~45 min/session',
    days: [
      {
        name: 'Full Body A',
        exercises: [
          ex('Squat (Barbell)',              'Quads',     150, [5,5,5]),
          ex('Bench Press (Barbell)',        'Chest',     120, [6,6,6]),
          ex('Bent Over Row (Barbell)',      'Back',      120, [6,6,6]),
          ex('Overhead Press (Dumbbell)',    'Shoulders', 90,  [8,8]),
          ex('Leg Curl (Lying)',             'Hamstrings',60,  [10,10]),
        ],
      },
      {
        name: 'Full Body B',
        exercises: [
          ex('Deadlift (Barbell)',           'Back',      180, [5,5]),
          ex('Incline Bench Press (Dumbbell)','Chest',    90,  [8,8,8]),
          ex('Pull Up',                      'Back',      90,  [8,8,8]),
          ex('Bulgarian Split Squat',        'Quads',     90,  [10,10]),
          ex('Lateral Raise (Dumbbell)',     'Shoulders', 60,  [15,15]),
        ],
      },
      {
        name: 'Full Body C',
        exercises: [
          ex('Front Squat',                  'Quads',     120, [6,6,6]),
          ex('Overhead Press (Barbell)',     'Shoulders', 120, [6,6,6]),
          ex('Seated Cable Row',             'Back',      90,  [10,10]),
          ex('Hip Thrust (Barbell)',         'Glutes',    90,  [8,8]),
          ex('Barbell Curl',                 'Biceps',    60,  [10,10]),
          ex('Tricep Pushdown (Cable)',      'Triceps',   60,  [10,10]),
        ],
      },
    ],
  },

  {
    id: 'phul-4day',
    name: 'PHUL — Power Hypertrophy Upper Lower',
    tagline: 'Blends heavy strength days with higher-rep hypertrophy days for both goals at once.',
    meta: '4 days/week · ~55-60 min/session',
    days: [
      {
        name: 'Upper Power',
        exercises: [
          ex('Bench Press (Barbell)',        'Chest',     180, [3,3,3,3]),
          ex('Bent Over Row (Barbell)',      'Back',      180, [3,3,3,3]),
          ex('Overhead Press (Barbell)',     'Shoulders', 120, [5,5,5]),
          ex('Lat Pulldown',                 'Back',      90,  [8,8]),
          ex('Barbell Curl',                 'Biceps',    60,  [8,8]),
          ex('Close Grip Bench Press',       'Triceps',   90,  [8,8]),
        ],
      },
      {
        name: 'Lower Power',
        exercises: [
          ex('Squat (Barbell)',              'Quads',     180, [3,3,3,3]),
          ex('Romanian Deadlift',            'Hamstrings',150, [5,5,5]),
          ex('Leg Press',                    'Quads',     90,  [8,8]),
          ex('Calf Raise (Standing Machine)','Calves',    60,  [10,10]),
        ],
      },
      {
        name: 'Upper Hypertrophy',
        exercises: [
          ex('Incline Bench Press (Dumbbell)','Chest',    90,  [10,10,10]),
          ex('Seated Cable Row',             'Back',      90,  [10,10,10]),
          ex('Machine Shoulder Press',       'Shoulders', 90,  [12,12]),
          ex('Cable Row (Wide Grip)',        'Back',      75,  [12,12]),
          ex('Lateral Raise (Dumbbell)',     'Shoulders', 60,  [15,15]),
          ex('Incline Dumbbell Curl',        'Biceps',    60,  [12,12]),
          ex('Tricep Pushdown (Cable)',      'Triceps',   60,  [12,12]),
        ],
      },
      {
        name: 'Lower Hypertrophy',
        exercises: [
          ex('Front Squat',                  'Quads',     120, [10,10,10]),
          ex('Hip Thrust (Barbell)',         'Glutes',    90,  [10,10]),
          ex('Leg Extension',                'Quads',     60,  [12,12]),
          ex('Leg Curl (Seated)',            'Hamstrings',60,  [12,12]),
          ex('Calf Raise (Leg Press)',       'Calves',    60,  [15,15,15]),
        ],
      },
    ],
  },

  {
    id: 'kettlebell-3day',
    name: 'Kettlebell Strength & Conditioning (3-day)',
    tagline: 'Rogan-style hardstyle kettlebell training — ballistic power, grinding strength and a full-body flow day. Minimal kit, high carryover.',
    meta: '3 days/week · ~40-45 min/session',
    days: [
      {
        name: 'KB Grind (Strength)',
        exercises: [
          ex('Kettlebell Turkish Get-Up',     'Core',      90,  [3,3,3]),
          ex('Kettlebell Clean and Press',     'Shoulders', 90,  [6,6,6,6]),
          ex('Kettlebell Front Squat',         'Quads',     90,  [8,8,8]),
          ex('Kettlebell Row',                 'Back',      75,  [10,10,10]),
          ex('Kettlebell Windmill',            'Core',      60,  [6,6]),
        ],
      },
      {
        name: 'KB Ballistic (Power)',
        exercises: [
          ex('Kettlebell Swing',               'Hamstrings',60,  [15,15,15,15,15]),
          ex('Kettlebell Snatch',              'Shoulders', 75,  [8,8,8,8]),
          ex('Kettlebell Clean and Jerk',      'Shoulders', 75,  [6,6,6]),
          ex('Kettlebell Goblet Squat',        'Quads',     60,  [12,12,12]),
          ex('Kettlebell High Pull',           'Shoulders', 60,  [12,12]),
        ],
      },
      {
        name: 'KB Full-Body Flow',
        exercises: [
          ex('Kettlebell Swing (American)',    'Shoulders', 60,  [15,15,15]),
          ex('Kettlebell Thruster',            'Quads',     75,  [10,10,10]),
          ex('Kettlebell Renegade Row',        'Back',      75,  [8,8,8]),
          ex('Kettlebell Lunge',               'Quads',     60,  [10,10]),
          ex('Kettlebell Halo',                'Shoulders', 45,  [10,10]),
        ],
      },
    ],
  },

  {
    id: 'circuit-metcon-3day',
    name: 'Circuit / Metcon (3-day)',
    tagline: 'Strength-endurance circuits — 3–5 rounds back-to-back, 30–60s rest only between rounds. Builds work capacity and burns while keeping muscle.',
    meta: '3 days/week · ~35-45 min · circuit style',
    days: [
      {
        name: 'Full-Body Circuit',
        exercises: [
          ex('Kettlebell Swing',               'Hamstrings',45,  [15,15,15,15]),
          ex('Goblet Squat',                   'Quads',     45,  [15,15,15,15]),
          ex('Push Up',                        'Chest',     45,  [15,15,15,15]),
          ex('Burpee',                         'Core',      45,  [12,12,12,12]),
          ex('Plank',                          'Core',      45,  [45,45,45,45]),
        ],
      },
      {
        name: 'Upper Circuit',
        exercises: [
          ex('Kettlebell Push Press',          'Shoulders', 45,  [12,12,12,12]),
          ex('Kettlebell Renegade Row',        'Back',      45,  [10,10,10,10]),
          ex('Medicine Ball Chest Pass',       'Chest',     45,  [15,15,15]),
          ex('Battle Ropes',                   'Cardio',    45,  [30,30,30,30]),
          ex('Mountain Climber',               'Core',      45,  [30,30,30]),
        ],
      },
      {
        name: 'Lower + Conditioning Circuit',
        exercises: [
          ex('Wall Ball',                      'Quads',     45,  [15,15,15,15]),
          ex('Box Jump',                       'Quads',     45,  [12,12,12,12]),
          ex('Jumping Lunge',                  'Quads',     45,  [16,16,16]),
          ex('Kettlebell Sumo Deadlift High Pull', 'Shoulders', 45, [12,12,12]),
          ex('Medicine Ball Slam',             'Core',      45,  [15,15,15]),
        ],
      },
    ],
  },

  {
    id: 'conditioning-finisher',
    name: 'HIIT Conditioning Finisher',
    tagline: 'A short, brutal 10–15 min metcon to bolt onto any session or run solo on an off day. Go through 4–5 rounds for time.',
    meta: '1 day / add-on · ~12-15 min',
    days: [
      {
        name: 'HIIT Finisher',
        exercises: [
          ex('Kettlebell Swing',               'Hamstrings',30,  [20,20,20,20,20]),
          ex('Burpee',                         'Core',      30,  [10,10,10,10,10]),
          ex('Jumping Jacks',                  'Cardio',    30,  [40,40,40,40,40]),
          ex('High Knees',                     'Cardio',    30,  [30,30,30,30,30]),
        ],
      },
    ],
  },

  {
    id: 'minimalist-2day',
    name: 'Minimalist Full Body (2-day)',
    tagline: 'Maximum time efficiency — 2 sessions/week hitting every muscle with proven minimum-effective-dose volume.',
    meta: '2 days/week · ~40 min/session',
    days: [
      {
        name: 'Full Body A',
        exercises: [
          ex('Squat (Barbell)',              'Quads',     150, [5,5,5]),
          ex('Bench Press (Barbell)',        'Chest',     120, [6,6,6]),
          ex('Pull Up',                      'Back',      120, [8,8,8]),
          ex('Overhead Press (Dumbbell)',    'Shoulders', 90,  [8,8]),
          ex('Leg Curl (Lying)',             'Hamstrings',60,  [10,10]),
        ],
      },
      {
        name: 'Full Body B',
        exercises: [
          ex('Deadlift (Barbell)',           'Back',      180, [5,5]),
          ex('Incline Bench Press (Dumbbell)','Chest',    90,  [8,8,8]),
          ex('Seated Cable Row',             'Back',      90,  [10,10]),
          ex('Bulgarian Split Squat',        'Quads',     90,  [10,10]),
          ex('Lateral Raise (Dumbbell)',     'Shoulders', 60,  [15,15]),
        ],
      },
    ],
  },
];
