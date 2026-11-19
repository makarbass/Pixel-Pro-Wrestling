export const ROSTER = {
  warrior: 'Ultimate Warrior',
  honky: 'Honky Tonk Man',
  bret: 'Bret "Hitman" Hart',
  yokozuna: 'Yokozuna',
  ddp: 'Diamond Dallas Page',
  savage: '"Macho Man" Randy Savage',
  booker: 'Booker T',
  taker: 'The Undertaker'
};

export const PRESETS = {
  bright: { arena: 'bright', player: 'warrior', opponent: 'honky' },
  mania: { arena: 'mania', player: 'bret', opponent: 'yokozuna' },
  stampede: { arena: 'stampede', player: 'ddp', opponent: 'savage' },
  night: { arena: 'night', player: 'booker', opponent: 'taker' }
};

export const TACTICS = {
  warrior: 'rush',
  honky: 'taunt',
  bret: 'grapple',
  yokozuna: 'grapple',
  ddp: 'rush',
  savage: 'corner',
  booker: 'corner',
  taker: 'taunt'
};

export const GRAPPLES = {
  warrior: { label: 'Military press slam', style: 'press', duration: 0.62, lift: 34 },
  honky: { label: 'Shoulder throw', style: 'shoulder', duration: 0.55, lift: 18 },
  bret: { label: 'Leg sweep', style: 'low', duration: 0.44, lift: 5 },
  yokozuna: { label: 'Side body slam', style: 'body', duration: 0.60, lift: 12 },
  ddp: { label: 'Falling grapple', style: 'side', duration: 0.43, lift: 11 },
  savage: { label: 'Overhead throw', style: 'overhead', duration: 0.57, lift: 25 },
  booker: { label: 'Hip toss', style: 'hip', duration: 0.50, lift: 14 },
  taker: { label: 'Tombstone piledriver', style: 'vertical', duration: 0.56, lift: 23 }
};

export const SIGNATURES = {
  booker: { label: 'Jumping kick', impact: 0.32, duration: 0.85, reach: 27, depth: 9, travel: 13, lift: 13, damage: 22, fall: true },
  taker: { label: 'Tombstone piledriver', impact: 0.26, duration: 0.70, reach: 17, depth: 8, grab: 'vertical', damage: 26 },
  warrior: { label: 'Running body splash', impact: 0.31, duration: 0.86, reach: 25, depth: 9, travel: 21, lift: 6, damage: 23, fall: true },
  honky: { label: 'Spinning strike', impact: 0.24, duration: 0.65, reach: 23, depth: 9, travel: 5, damage: 18 },
  bret: { label: 'Grapple into leg sweep', impact: 0.23, duration: 0.67, reach: 16, depth: 8, grab: 'low', damage: 22 },
  yokozuna: { label: 'Body splash', impact: 0.32, duration: 0.92, reach: 21, depth: 9, travel: 8, damage: 24, fall: true },
  ddp: { label: 'Falling grapple', impact: 0.22, duration: 0.65, reach: 17, depth: 8, grab: 'side', damage: 24 },
  savage: { label: 'Diving elbow drop', impact: 0.34, duration: 0.88, reach: 24, depth: 9, travel: 10, lift: 17, damage: 22, fall: true }
};
