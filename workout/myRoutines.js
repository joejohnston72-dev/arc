// User's actual current routine (5-day split:
// Upper Strength / Lower Strength / Push Hypertrophy / Pull Hypertrophy / Legs Hypertrophy).
// One-time seeded into the templates store on first load — see
// seedMyRoutinesOnce() / fixIncompletePushDayOnce() in app.js.
//
// Rep targets use the LOW end of each rep range (double-progression: work
// up through the range on the same weight before increasing load).
// "Cardio - 25min Stairs/Cycle" entries are kept as a single set with the
// target minutes stored in the reps field, since the app's set model is
// weight×reps rather than duration-based.

function ex(name, category, restTime, repTargets) {
  return {
    name, category, restTime,
    sets: repTargets.map(reps => ({ weight: 0, reps, type: 'normal' })),
  };
}

export const MY_ROUTINES = [
  {
    name: 'Upper Strength (Chest Bias)',
    exercises: [
      ex('Incline Bench Press (Smith Machine)', 'Chest',     60, [5,5,5,5]),
      ex('Bench Press (Dumbbell)',               'Chest',     60, [8,8,8]),
      ex('Pull Up',                              'Back',      60, [6,6,6,6]),
      ex('Chest Supported Incline Row (Dumbbell)','Back',     60, [9,9,9]),
      ex('Seated Cable Row - V Grip',            'Back',      60, [7,7,7]),
      ex('Close Grip Palms Up Pulldown',         'Back',      60, [5,5,5,5]),
      ex('Triceps Pushdown',                     'Triceps',   60, [10,10,10]),
      ex('Hanging Leg Raise',                    'Core',      60, [8,8,8]),
      ex('Cardio - 25min Stairs/Cycle',          'Cardio',    75, [25]),
    ],
  },
  {
    name: 'Lower Strength (Posterior)',
    exercises: [
      ex('Squat (Barbell)',                'Quads',      75, [2,2,2,2]),
      ex('Romanian Deadlift (Barbell)',    'Hamstrings', 60, [4,4,4,4]),
      ex('Leg Press (Machine)',            'Quads',      60, [6,6,6]),
      ex('Hip Thrust Elite (Machine)',     'Glutes',     60, [7,7,7]),
      ex('Seated Leg Curl (Machine)',      'Hamstrings', 60, [6,6,6]),
      ex('Calf Extension (Machine)',       'Calves',     45, [12,12,12,12]),
      ex('Back Extension (Weighted Hyperextension)', 'Hamstrings', 75, [10,10,10]),
      ex('Crunch (Machine)',               'Core',       60, [10,10,10]),
      ex('Cardio - 25min Stairs/Cycle',    'Cardio',     75, [25]),
    ],
  },
  {
    name: 'Push Hypertrophy (Delts)',
    exercises: [
      ex('Chest Press (Machine)',            'Chest',    60, [8,8,8,8]),
      ex('Dumbbell Squeeze Press',           'Chest',    60, [8,8,8]),
      ex('Lateral Raise (Cable)',            'Shoulders',60, [13,13,13,13]),
      ex('Overhead Triceps Extension (Cable)','Triceps', 60, [10,10,10,10]),
      ex('Triceps Dip',                      'Triceps',  60, [7,7,7]),
      ex('Cross Body Tricep Extension',      'Triceps',  60, [12,12,12]),
      ex('Chest Fly (Machine)',              'Chest',    30, [10,10,10]),
      ex('Hanging Leg Raise',                'Core',     75, [10,10,10]),
      ex('Cardio - 25min Stairs/Cycle',      'Cardio',   75, [25]),
    ],
  },
  {
    name: 'Pull Hypertrophy',
    exercises: [
      ex('Seated Cable Row - Bar Grip',   'Back',    60, [9,9,9]),
      ex('Lat Pulldown (Cable)',          'Back',    60, [8,8,8,8]),
      ex('Straight Arm Lat Pulldown (Cable)','Back', 60, [8,8,8]),
      ex('Rear Delt Reverse Fly (Cable)', 'Shoulders',45, [9,9,9,9]),
      ex('Preacher Curl (Machine)',       'Biceps',  60, [8,8,8,8]),
      ex('Bayesian Curl (Cable)',         'Biceps',  30, [8,8,8,8]),
      ex('Cable Crunch',                  'Core',    75, [10,10,10,10]),
      ex('Cardio - 25min Stairs/Cycle',   'Cardio',  75, [25]),
    ],
  },
  {
    name: 'Legs Hypertrophy',
    exercises: [
      ex('Leg Press (Machine)',           'Quads',      60, [6,6,6,6]),
      ex('Bulgarian Split Squat',         'Quads',      75, [6,6,6]),
      ex('Seated Leg Curl (Machine)',     'Hamstrings', 60, [8,8,8,8]),
      ex('Leg Extension (Machine)',       'Quads',      60, [10,10,10,10]),
      ex('Super Horizontal Calf Press',   'Calves',     60, [10,10,10,10]),
      ex('Cable Crunch',                  'Core',       60, [9,9,9,9]),
      ex('Cardio - 25min Stairs/Cycle',   'Cardio',     75, [25]),
    ],
  },
];
