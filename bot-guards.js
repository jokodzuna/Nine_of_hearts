import { DRAW_FLAG, RANK_MASK } from './game-logic.js';

// ============================================================
// Bit helpers (inlined — game-logic internals are not exported)
// ============================================================

function _pc(x) {
    x=(x|0); x=x-((x>>>1)&0x555555); x=(x&0x333333)+((x>>>2)&0x333333);
    x=(x+(x>>>4))&0x0F0F0F; return (Math.imul(x,0x010101)>>>16)&0xFF;
}

/** Rank index (0-5) of the lowest card in a non-draw move. */
function _moveRank(m) {
    const lb = (m & 0xFFFFFF) & (-(m & 0xFFFFFF));
    return (31 - Math.clz32(lb)) >> 2;
}

// Nine of Hearts: rank=0, suit=♥=1 → pile bit-index = 0*4+1 = 1
const NINE_HEARTS_PILE_IDX = 1;

// ============================================================
// Rule 1 — Nine of Hearts guard
// ============================================================

/**
 * On Nine of Hearts top card (3-4 active player stage only), override
 * MCTS to play the lowest available rank (≤ J by default).
 * If the NEXT ACTIVE player has ≤2 cards, raises ceiling to Q.
 * K and A are never allowed on 9♥.
 *
 * @param {object}   state  Current game state
 * @param {number}   move   MCTS-chosen move
 * @param {number[]} moves  All legal moves
 * @returns {number}        Possibly overridden move
 */
export function applyNineHeartsGuard(state, move, moves) {
    const active = state.numPlayers - _pc(state.eliminated);
    if (active < 3) return move;
    if (state.pile[state.pileSize - 1] !== NINE_HEARTS_PILE_IDX) return move;

    const me = state.currentPlayer;

    // Find the next active player in turn order
    let next = (me + 1) % state.numPlayers;
    while ((state.eliminated & (1 << next)) && next !== me)
        next = (next + 1) % state.numPlayers;

    let maxRank = 2; // J default
    if (next !== me && _pc(state.hands[next]) <= 2) maxRank = 3; // raise to Q

    let bestMove = null, bestRank = Infinity;
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        const r = _moveRank(m);
        if (r <= maxRank && r < bestRank) { bestRank = r; bestMove = m; }
    }
    if (bestMove !== null) return bestMove;

    // No play within limit → prefer draw; last resort: absolute lowest play
    const draw = moves.find(m => m & DRAW_FLAG);
    if (draw !== undefined) return draw;
    let fallback = null, fallbackR = Infinity;
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        const r = _moveRank(m);
        if (r < fallbackR) { fallbackR = r; fallback = m; }
    }
    return fallback ?? move;
}

// ============================================================
// Rule 2 — Low pile draw guard
// ============================================================

/**
 * When MCTS chooses to draw and the top pile card is below Q (9, 10, J),
 * override to the best non-draw move from MCTS simulations instead.
 *
 * Exceptions (drawing IS still allowed):
 *   a) Drawing would complete a quad (3 of same rank in hand)
 *   b) All non-draw plays are K or A AND total K+A count < 3
 *
 * @param {object}   state   Current game state
 * @param {number}   move    MCTS-chosen move
 * @param {number[]} moves   All legal moves
 * @param {object}   engine  ISMCTSEngine instance (for bestNonDrawMove())
 * @returns {number}         Possibly overridden move
 */
export function applyLowPileDrawGuard(state, move, moves, engine) {
    if (!(move & DRAW_FLAG))   return move; // not a draw
    if (state.topRankIdx >= 3) return move; // Q/K/A top → allowed

    const hand = state.hands[state.currentPlayer];

    // Exception a: drawing completes a quad
    if (_pc(hand & RANK_MASK[state.topRankIdx]) === 3) return move;

    // Exception b: all non-draw plays are K/A AND fewer than 3 K/A in hand
    const playMoves = moves.filter(m => !(m & DRAW_FLAG));
    const myKA = _pc(hand & (RANK_MASK[4] | RANK_MASK[5]));
    if (playMoves.length > 0 && myKA < 3 &&
        playMoves.every(m => _moveRank(m) >= 4)) return move;

    // Override: use best non-draw move from MCTS visit counts
    if (playMoves.length === 0) return move;
    const mctsNonDraw = engine.bestNonDrawMove();
    if (mctsNonDraw !== null) return mctsNonDraw;

    // Fallback: lowest rank play
    let best = null, bestR = Infinity;
    for (const m of playMoves) {
        const r = _moveRank(m);
        if (r < bestR) { bestR = r; best = m; }
    }
    return best ?? move;
}
