// ============================================================
// game-logic.js — Pure Referee / Game Engine
// Nine of Hearts
//
// Responsibilities:
//   - Encode all game rules as bitmask operations
//   - Provide 4 pure functions for external AI / MCTS use
//   - Provide decoder functions for ui-manager.js
//
// NOT responsible for:
//   - AI strategy or MCTS search
//   - DOM, rendering, or animations
//   - Sound or UI state
// ============================================================

// ============================================================
// Card Bit Layout  (24 cards → 24 bits of one 32-bit integer)
//
//   bit = rankIndex × 4 + suitIndex
//
//   Rank   rIdx   ♠(0)  ♥(1)  ♦(2)  ♣(3)
//     9      0     b0    b1*   b2    b3
//    10      1     b4    b5    b6    b7
//     J      2     b8    b9    b10   b11
//     Q      3    b12   b13   b14   b15
//     K      4    b16   b17   b18   b19
//     A      5    b20   b21   b22   b23
//
//  * 9♥ = bit 1  — permanent pile base, never drawn.
//
// Move Encoding  (single integer, zero allocation)
//   PLAY : bit 24 = 0,  bits 0-23 = bitmask of cards played
//   DRAW : bit 24 = 1,  bits 0-1  = (count − 1)
//          count = min(3, pileSize − 1)  — exactly one draw move per position
// ============================================================

const NINE_HEARTS_BIT = 2;
export const DRAW_FLAG = 1 << 24;

export const RANK_MASK = new Int32Array([
    0x00000F,   // 9s   bits  0-3
    0x0000F0,   // 10s  bits  4-7
    0x000F00,   // Js   bits  8-11
    0x00F000,   // Qs   bits 12-15
    0x0F0000,   // Ks   bits 16-19
    0xF00000,   // As   bits 20-23
]);

export const RANK_VALUES = new Int32Array([9, 10, 11, 12, 13, 14]);
export const RANK_NAMES  = ['9', '10', 'J', 'Q', 'K', 'A'];
export const SUIT_NAMES  = ['\u2660', '\u2665', '\u2666', '\u2663'];  // ♠ ♥ ♦ ♣

const CARDS_PER_PLAYER = Object.freeze({ 2: 12, 3: 8, 4: 6 });

// ============================================================
// Bit Utilities  (no allocation, no branches in hot path)
// ============================================================

/** 24-bit population count. */
function popcount(x) {
    x = (x | 0);
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    x = (x + (x >>> 4)) & 0x0F0F0F;
    return (Math.imul(x, 0x010101) >>> 16) & 0xFF;
}

/** Isolate the lowest set bit: lowestBit(0b1100) → 0b0100. */
function lowestBit(x) { return x & (-x); }

/** Bit position of a single-bit value: bitIdx(1 << n) → n. */
function bitIdx(bit) { return 31 - Math.clz32(bit); }

/** Rank index (0-5) from a bit index 0-23. */
function rankIdxFromBit(b) { return b >> 2; }

/** Suit index (0-3) from a bit index 0-23. */
function suitIdxFromBit(b) { return b & 3; }

// ============================================================
// State Shape
// ============================================================
//
//  {
//    hands:         Int32Array(numPlayers)  — 24-bit hand bitmask per player
//    pile:          Uint8Array(24)          — pile[0]=9♥ bit idx, pile[pileSize-1]=top
//    pileSize:      number
//    topRankIdx:    number                  — rank index (0-5) of current top card
//    currentPlayer: number                  — 0 … numPlayers-1
//    eliminated:    number                  — bit i = player i is SAFE (out of cards)
//    numPlayers:    2 | 3 | 4
//  }

// ============================================================
// State Factory
// ============================================================

/**
 * Create an empty (zeroed) state container.
 * @param {2|3|4} numPlayers
 */
export function createState(numPlayers = 4) {
    return {
        hands:         new Int32Array(numPlayers),
        pile:          new Uint8Array(24),
        pileSize:      0,
        topRankIdx:    0,
        currentPlayer: 0,
        eliminated:    0,
        numPlayers,
    };
}

/**
 * Deep-copy a state via typed-array constructors (fast memcopy, no JSON).
 * @param {object} s
 * @returns {object}
 */
export function copyState(s) {
    return {
        hands:         new Int32Array(s.hands),
        pile:          new Uint8Array(s.pile),
        pileSize:      s.pileSize,
        topRankIdx:    s.topRankIdx,
        currentPlayer: s.currentPlayer,
        eliminated:    s.eliminated,
        numPlayers:    s.numPlayers,
    };
}

// ============================================================
// Deck Shuffle  (Fisher-Yates, in-place)
// ============================================================

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
}

// ============================================================
// Initial State  (deals a full game)
// ============================================================

/**
 * Build and deal a fresh game state.
 *
 *   numPlayers | cards dealt each | note
 *   -----------+------------------+------------------------------
 *       4      |        6         |  9♥ holder ends up with 5
 *       3      |        8         |  9♥ holder ends up with 7
 *       2      |       12         |  9♥ holder ends up with 11
 *
 * @param {2|3|4} numPlayers
 * @returns {object}  game state ready for getPossibleMoves
 */
export function createInitialState(numPlayers = 4) {
    const cardsEach = CARDS_PER_PLAYER[numPlayers];

    const deck = new Uint8Array(24);
    for (let i = 0; i < 24; i++) deck[i] = i;
    shuffle(deck);

    const state = createState(numPlayers);

    let ptr = 0;
    for (let p = 0; p < numPlayers; p++) {
        for (let c = 0; c < cardsEach; c++) {
            state.hands[p] |= (1 << deck[ptr++]);
        }
    }

    // Find 9♥ holder, remove it from their hand
    let starterPlayer = -1;
    for (let p = 0; p < numPlayers; p++) {
        if (state.hands[p] & NINE_HEARTS_BIT) {
            state.hands[p] &= ~NINE_HEARTS_BIT;
            starterPlayer = p;
            break;
        }
    }

    // 9♥ is the permanent pile base
    state.pile[0]    = 1;   // bit index of 9♥
    state.pileSize   = 1;
    state.topRankIdx = 0;   // rank index of 9

    // Player AFTER the 9♥ holder goes first
    state.currentPlayer = (starterPlayer + 1) % numPlayers;
    state.eliminated    = 0;

    return state;
}

/**
 * Fixed deal for The Botfather (2-player only).
 * Player 0 (human) gets all black cards (♠ + ♣).
 * Player 1 (Botfather) gets all red cards (♥ + ♦) minus 9♥.
 * 9♥ goes to the pile base as usual; human goes first (Botfather held 9♥).
 */
export function createBotfatherState() {
    const state      = createState(2);
    // Suit 0=♠, 3=♣ → bits (n*4+0) and (n*4+3), n=0..5  → 0x999999
    // Suit 1=♥, 2=♦ → bits (n*4+1) and (n*4+2), n=0..5  → 0x666666
    state.hands[0] = 0x999999;                       // all black cards
    state.hands[1] = 0x666666 & ~NINE_HEARTS_BIT;   // red cards, 9♥ removed
    state.pile[0]    = 1;   // 9♥ bit index
    state.pileSize   = 1;
    state.topRankIdx = 0;
    state.currentPlayer = 0;   // player 1 (Botfather) held 9♥ → human goes first
    state.eliminated    = 0;
    return state;
}

// ============================================================
// Core Pure Function 1 — getPossibleMoves
// ============================================================

/**
 * Returns all legal moves for the current player as an array of integers.
 * No objects are allocated; every move is a plain 32-bit integer.
 *
 * Valid play types (canPlayCards rule):
 *   1. Single card         — rank value >= top card rank value
 *   2. Four-of-a-kind      — rank value >= top card rank value
 *   3. Triple 9s (special) — only when top card is also rank 9
 *
 * Draw:
 *   Exactly one draw move when pileSize > 1.
 *   count = min(3, pileSize − 1):
 *     1 card above 9♥  → must draw 1
 *     2 cards above 9♥ → must draw 2
 *     3+ cards above 9♥ → must draw 3
 *
 * @param {object} state
 * @returns {number[]}
 */
export function getPossibleMoves(state) {
    const moves = [];
    const hand  = state.hands[state.currentPlayer];
    const top   = state.topRankIdx;
    const topV  = RANK_VALUES[top];

    for (let r = 0; r < 6; r++) {
        if (RANK_VALUES[r] < topV) continue;

        const group = (hand & RANK_MASK[r]) | 0;
        if (!group) continue;

        const cnt = popcount(group);

        // Single card: always valid when rank >= top
        moves.push(lowestBit(group));

        // Four-of-a-kind
        if (cnt === 4) moves.push(group);

        // Triple 9s: only when top card is also rank 9
        if (r === 0 && cnt === 3 && top === 0) moves.push(group);
    }

    // Draw: exactly one draw move, count = min(3, drawable)
    const drawable = state.pileSize - 1;
    if (drawable > 0) {
        const count = drawable < 3 ? drawable : 3;
        moves.push(DRAW_FLAG | (count - 1));
    }

    return moves;
}

// ============================================================
// Core Pure Function 2 — applyMove
// ============================================================

/**
 * Apply a move and return a NEW state (does not mutate the input).
 *
 * @param {object} state
 * @param {number} move   integer from getPossibleMoves
 * @returns {object}      next game state
 */
export function applyMove(state, move) {
    const next = copyState(state);

    if (move & DRAW_FLAG) {
        // ---- DRAW ----
        const count = (move & 3) + 1;
        for (let i = 0; i < count; i++) {
            const topB = next.pile[--next.pileSize];
            next.hands[next.currentPlayer] |= (1 << topB);
        }
        next.topRankIdx = rankIdxFromBit(next.pile[next.pileSize - 1]);

    } else {
        // ---- PLAY ----
        const cardMask = (move & 0xFFFFFF) | 0;
        next.hands[next.currentPlayer] = (next.hands[next.currentPlayer] & ~cardMask) | 0;

        // Push each played card's bit index onto the pile stack
        let rem = cardMask;
        while (rem) {
            const lb = lowestBit(rem);
            next.pile[next.pileSize++] = bitIdx(lb);
            rem &= ~lb;
        }
        // All played cards share the same rank; topRankIdx = rank of any of them
        next.topRankIdx = rankIdxFromBit(next.pile[next.pileSize - 1]);

        // Player emptied their hand → they are SAFE
        if (next.hands[next.currentPlayer] === 0) {
            next.eliminated |= (1 << next.currentPlayer);
        }
    }

    // Advance to next non-eliminated player
    let p = next.currentPlayer;
    for (let i = 0; i < next.numPlayers; i++) {
        p = (p + 1) % next.numPlayers;
        if (!(next.eliminated & (1 << p))) break;
    }
    next.currentPlayer = p;

    return next;
}

// ============================================================
// Core Pure Function 3 — isGameOver
// ============================================================

/**
 * Returns true when exactly one player still holds cards (game over).
 *
 * @param {object} state
 * @returns {boolean}
 */
export function isGameOver(state) {
    const playerMask = (1 << state.numPlayers) - 1;
    return popcount(playerMask & ~state.eliminated) === 1;
}

// ============================================================
// Core Pure Function 4 — getResult
// ============================================================

/**
 * Returns the outcome for a given player (call only after isGameOver is true).
 *
 *   1.0  — player is SAFE  (eliminated = ran out of cards)
 *   0.0  — player is the LOSER (last one still holding cards)
 *
 * @param {object} state
 * @param {number} playerIndex
 * @returns {number}
 */
export function getResult(state, playerIndex) {
    return (state.eliminated & (1 << playerIndex)) ? 1.0 : 0.0;
}

// ============================================================
// Translator / Decoder
//
// These functions allocate plain JS objects.
// Call ONLY when feeding data to ui-manager.js — never inside a sim loop.
// ============================================================

/**
 * Convert a bit index (0-23) to a readable card object.
 *
 * @param {number} b  bit index 0-23
 * @returns {{ rank: string, suit: string, rankIdx: number, suitIdx: number }}
 */
export function bitToCard(b) {
    const rIdx = rankIdxFromBit(b);
    const sIdx = suitIdxFromBit(b);
    return { rank: RANK_NAMES[rIdx], suit: SUIT_NAMES[sIdx], rankIdx: rIdx, suitIdx: sIdx };
}

/**
 * Convert a 24-bit hand bitmask to an array of card objects.
 * Cards are naturally sorted rank ascending (9♠ = bit 0 = lowest).
 *
 * @param {number} mask  24-bit hand bitmask
 * @returns {{ rank: string, suit: string }[]}
 */
export function bitmaskToCards(mask) {
    const cards = [];
    let m = (mask & 0xFFFFFF) | 0;
    while (m) {
        const lb = lowestBit(m);
        cards.push(bitToCard(bitIdx(lb)));
        m &= ~lb;
    }
    return cards;
}

/**
 * Decode a move integer into a readable object for ui-manager.js.
 *
 * @param {number} move
 * @returns {{ type: 'play'|'draw', cards?: {rank:string,suit:string}[], count?: number }}
 */
export function decodeMove(move) {
    if (move & DRAW_FLAG) {
        return { type: 'draw', count: (move & 3) + 1 };
    }
    return { type: 'play', cards: bitmaskToCards(move & 0xFFFFFF) };
}

/**
 * Decode a full game state into plain objects for ui-manager.js.
 *
 * @param {object} state
 * @returns {{
 *   hands:         {rank:string, suit:string}[][]   index 0 = player 0
 *   pile:          {rank:string, suit:string}[]     index 0 = 9♥ (bottom), last = top
 *   topCard:       {rank:string, suit:string}
 *   currentPlayer: number
 *   eliminated:    boolean[]                        true = player is SAFE
 *   numPlayers:    number
 * }}
 */
export function decodeState(state) {
    const hands = [];
    for (let p = 0; p < state.numPlayers; p++) {
        hands.push(bitmaskToCards(state.hands[p]));
    }

    const pile = [];
    for (let i = 0; i < state.pileSize; i++) {
        pile.push(bitToCard(state.pile[i]));
    }

    const eliminated = [];
    for (let p = 0; p < state.numPlayers; p++) {
        eliminated.push(!!(state.eliminated & (1 << p)));
    }

    return {
        hands,
        pile,
        topCard:       bitToCard(state.pile[state.pileSize - 1]),
        currentPlayer: state.currentPlayer,
        eliminated,
        numPlayers:    state.numPlayers,
    };
}
