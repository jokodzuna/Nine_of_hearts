import { ISMCTSEngine }                        from './ai-engine.js';
import { getPossibleMoves, DRAW_FLAG, RANK_MASK } from './game-logic.js';

// ============================================================
// Learning Bot metadata
// ============================================================

const LEARNING_META = [
    { name: 'Bob', avatar: 'Images/bot-avatars/learning/Bob.webp' },
    { name: 'Dom', avatar: 'Images/bot-avatars/learning/Dom.webp' },
    { name: 'Jon', avatar: 'Images/bot-avatars/learning/Jon.webp' },
    { name: 'Rob', avatar: 'Images/bot-avatars/learning/Rob.webp' },
    { name: 'Sam', avatar: 'Images/bot-avatars/learning/Sam.webp' },
];

const ITERATIONS = 100;

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

// Module-level pool — shuffled once per game via LearningBot.prepareGame().
let _namePool = [];

function _shuffle(arr) { arr.sort(() => Math.random() - 0.5); }

// ============================================================
// LearningBot — thin wrapper around ISMCTSEngine('newbie')
//               at ITERATIONS iterations with unique name/avatar per instance
// ============================================================

export class LearningBot {
    constructor() {
        if (_namePool.length === 0) _shuffle(_namePool = [...LEARNING_META]);
        const meta       = _namePool.pop();
        this._name       = meta.name;
        this._avatar     = meta.avatar;
        const profile    = { ...ISMCTSEngine.PROFILES.newbie, maxIterations: ITERATIONS };
        this._engine     = new ISMCTSEngine(profile);
    }

    /**
     * Call once before creating bots for a new game.
     * Shuffles the name pool so every bot in this game gets a unique name.
     */
    static prepareGame() {
        _shuffle(_namePool = [...LEARNING_META]);
    }

    get name()       { return this._name; }
    get avatarPath() { return this._avatar; }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        let   move  = this._engine.chooseMove(state);
        move = this._rule1_nineOfHearts(state, move, moves);
        move = this._rule2_lowPileDraw(state, move, moves);
        return move;
    }

    // ----------------------------------------------------------
    // Rule 1: On Nine of Hearts top card, play lowest allowed
    //         rank (3-4 active player stage only).
    //   - Default max rank: J (idx 2)
    //   - If any opponent has ≤2 cards: raise to Q (idx 3)
    //   - K and A are NEVER allowed on 9♥
    // ----------------------------------------------------------
    _rule1_nineOfHearts(state, move, moves) {
        const active = state.numPlayers - _pc(state.eliminated);
        if (active < 3) return move;
        if (state.pile[state.pileSize - 1] !== NINE_HEARTS_PILE_IDX) return move;

        const me = state.currentPlayer;
        let maxRank = 2; // J
        for (let p = 0; p < state.numPlayers; p++) {
            if (p === me || (state.eliminated & (1 << p))) continue;
            if (_pc(state.hands[p]) <= 2) { maxRank = 3; break; } // raise to Q
        }

        let bestMove = null, bestRank = Infinity;
        for (const m of moves) {
            if (m & DRAW_FLAG) continue;
            const r = _moveRank(m);
            if (r <= maxRank && r < bestRank) { bestRank = r; bestMove = m; }
        }
        if (bestMove !== null) return bestMove;

        // No play within rank limit — prefer draw; last resort: lowest-rank play
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

    // ----------------------------------------------------------
    // Rule 2: Don't draw when top pile card rank < Q (idx 3).
    //   Exceptions (drawing still allowed):
    //   a) Drawing would complete a quad (3 of same rank in hand)
    //   b) All non-draw plays are K or A AND total K+A count < 3
    // ----------------------------------------------------------
    _rule2_lowPileDraw(state, move, moves) {
        if (!(move & DRAW_FLAG))    return move; // not a draw
        if (state.topRankIdx >= 3)  return move; // Q/K/A top → allowed

        const hand = state.hands[state.currentPlayer];

        // Exception a: drawing completes a quad
        if (_pc(hand & RANK_MASK[state.topRankIdx]) === 3) return move;

        // Exception b: only K/A plays available AND fewer than 3 K/A in hand
        const playMoves = moves.filter(m => !(m & DRAW_FLAG));
        const myKA = _pc(hand & (RANK_MASK[4] | RANK_MASK[5]));
        if (playMoves.length > 0 && myKA < 3 &&
            playMoves.every(m => _moveRank(m) >= 4)) return move;

        // Override: play lowest available card instead
        if (playMoves.length === 0) return move;
        let best = null, bestR = Infinity;
        for (const m of playMoves) {
            const r = _moveRank(m);
            if (r < bestR) { bestR = r; best = m; }
        }
        return best ?? move;
    }
    observeMove(state, move) { this._engine.observeMove(state, move); }
    advanceTree(move)        { this._engine.advanceTree(move); }
    resetKnowledge()         { this._engine.resetKnowledge(); }
    cleanup()                { this._engine.cleanup(); }
}
