// ============================================================
// constants.js — Shared IDs, timing values, and configuration
// Nine of Hearts
//
// Import from here instead of hard-coding strings anywhere.
// Both ui-manager.js and the sub-modules (animations.js, etc.)
// must import from this file.
// ============================================================

// ---- Player container IDs ---------------------------------------------------

/** The local human player's card container ID. */
export const HUMAN_ID = 'yourCards';

/** Card container IDs for the two side (left/right) players. */
export const SIDE_IDS = new Set(['player1Cards', 'player3Cards']);

/** Maps card-container ID → player-info-panel ID. */
export const INFO_ID = {
    yourCards:    'yourInfo',
    player1Cards: 'player1Info',
    player2Cards: 'player2Info',
    player3Cards: 'player3Info',
};

// ---- Turn timer -------------------------------------------------------------

/** Total milliseconds allowed per turn. */
export const TURN_DURATION_MS = 15000;

// ---- Dealing ----------------------------------------------------------------

/** Order in which cards are dealt (matches clockwise table layout). */
export const DEAL_ORDER = ['yourCards', 'player3Cards', 'player2Cards', 'player1Cards'];

// ---- Card image mapping -----------------------------------------------------

/** Maps game rank tokens to card-image filename segments. */
export const RANK_IMG = {
    '9':  '9',
    '10': '10',
    'J':  'Jack',
    'Q':  'Queen',
    'K':  'King',
    'A':  'Ace',
};

/** Maps suit Unicode characters to card-image filename segments. */
export const SUIT_IMG = {
    '\u2660': 'Spades',
    '\u2665': 'Hearts',
    '\u2666': 'Diamonds',
    '\u2663': 'Clubs',
};

// ---- Avatar -----------------------------------------------------------------

/** Default avatar path for new users. */
export const DEFAULT_AVATAR = 'Images/user-avatars/default-man_result.webp';

/** All selectable player avatar image paths. */
export const USER_AVATARS = [
    'Images/user-avatars/default-man_result.webp',
    'Images/user-avatars/punk-girl_result.webp',
    'Images/user-avatars/rainbow-hair_result.webp',
    'Images/user-avatars/biker_result.webp',
    'Images/user-avatars/alien_result.webp',
    'Images/user-avatars/fox_result.webp',
    'Images/user-avatars/witch_result.webp',
    'Images/user-avatars/pirate_result.webp',
    'Images/user-avatars/police-woman_result.webp',
    'Images/user-avatars/grumpy-girl_result.webp',
    'Images/user-avatars/girl-glasses_result.webp',
    'Images/user-avatars/big-smile_result.webp',
    'Images/user-avatars/black-boy_result.webp',
    'Images/user-avatars/cute-boy_result.webp',
    'Images/user-avatars/monkey_result.webp',
    'Images/user-avatars/old-lady_result.webp',
    'Images/user-avatars/toddler_result.webp',
    'Images/user-avatars/troll_result.webp',
];

/** Fixed avatar paths assigned to the three AI players in local games. */
export const AI_AVATARS = [
    null,
    'Images/user-avatars/grumpy-girl_result.webp',
    'Images/user-avatars/biker_result.webp',
    'Images/user-avatars/fox_result.webp',
];
