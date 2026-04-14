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

/**
 * CSS background-position values for the 9-slot avatar sprite grid.
 * Index 0 = top-left, index 8 = bottom-right.
 */
export const AVATAR_BG_POS = [
    '14% 15%', '50% 15%', '86% 15%',
    '14% 50%', '50% 50%', '86% 50%',
    '14% 85%', '50% 85%', '86% 85%',
];

/** Shared avatar image source used for all player avatars. */
export const AVATAR_IMG_SRC = "url('Images/avatars/cartoon-pack-workers-avatars/155153-OUMT5G-397.jpg')";
