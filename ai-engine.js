// ============================================================
// ai-engine.js — Information Set Monte Carlo Tree Search (ISMCTS)
// Nine of Hearts
//
// Algorithm: Single-Observer ISMCTS (Cowling, Powley, Whitehouse 2012)
//   • One shared tree built from the root player's information set
//   • Per-determinization UCB1 with an "avails" denominator
//   • Opponents' hidden hands are randomised while respecting their
//     known hand SIZES each iteration
//
// Usage:
//   import { ISMCTSEngine } from './ai-engine.js';
//   const engine = new ISMCTSEngine(ISMCTSEngine.PROFILES.shark);
//   const move   = engine.chooseMove(gameState);   // integer move
//   engine.cleanup();                               // free tree memory
// ============================================================

import {
    getPossibleMoves,
    applyMove,
    isGameOver,
    copyState,
    DRAW_FLAG,
} from './game-logic.js';

// ============================================================
// ISMCTS Tree Node
// ============================================================

class ISMCTSNode {
    constructor(move = null, parent = null) {
        this.move     = move;        // integer move that led to this node (null = root)
        this.parent   = parent;
        this.children = new Map();   // move (int) → ISMCTSNode
        this.visits   = 0;
        this.wins     = 0.0;
        this.avails   = 0;           // times this node was a legal option during selection
    }

    /**
     * UCB1 score (ISMCTS variant: avails replaces parent.visits).
     * Returns Infinity for unvisited nodes so they are always expanded first.
     */
    ucb1(C) {
        if (this.visits === 0) return Infinity;
        return this.wins / this.visits + C * Math.sqrt(Math.log(this.avails) / this.visits);
    }
}

// ============================================================
// Module-level helpers  (zero dynamic allocation in hot path)
// ============================================================

/** 24-bit population count. */
function _popcount(x) {
    x = (x | 0);
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    x = (x + (x >>> 4)) & 0x0F0F0F;
    return (Math.imul(x, 0x010101) >>> 16) & 0xFF;
}

/** Collect set-bit indices of a 24-bit mask into _buf[0..n-1], return n. */
const _buf = new Uint8Array(24);
function _bitsToArray(mask) {
    let m = mask, n = 0;
    while (m) {
        const lb = m & (-m);
        _buf[n++] = 31 - Math.clz32(lb);
        m &= ~lb;
    }
    return n;
}

/** Fisher-Yates shuffle of _buf[0..len-1] in place. */
function _shuffle(len) {
    for (let i = len - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const t = _buf[i]; _buf[i] = _buf[j]; _buf[j] = t;
    }
}

/**
 * Module-level reusable elimination-rank buffer (supports up to 8 players).
 * Index p holds the finish position of player p (0 = 1st safe, N-1 = loser).
 */
const _elimRank = new Int8Array(8);

/**
 * Rank masks — mirrors game-logic.js RANK_MASK (avoids extra import).
 *   index 0 = 9s (bits 0-3) … index 5 = As (bits 20-23)
 */
const _RANK_MASK = new Int32Array([
    0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000,
]);

/**
 * Expert Survival weighted move selector.
 *
 * Base weight: max(1, 6 − dist) where dist = card rank − topRankIdx.
 * Modifiers applied on top:
 *
 *   Ace Scarcity   — last Ace in hand with 4+ cards left  → weight × 0.05
 *   King Scarcity  — last King when no Aces, 4+ cards left → weight × 0.05
 *                    (cascade: if no Aces, King becomes the power card)
 *   Draw Bonus     — if Defenseless (no Aces) or Clogged (≥50% clog cards)
 *                    the draw move gets weight 4 instead of 1, teaching
 *                    the AI to fish for power cards rather than burn them.
 *
 * @param {number[]} pool        legal moves from getPossibleMoves
 * @param {number}   topRankIdx  state.topRankIdx (0–5)
 * @param {number}   hand        current player’s hand bitmask
 */
function _pickQualityMove(pool, topRankIdx, hand) {
    const totalCards  = _popcount(hand);
    const aceCount    = _popcount(hand & _RANK_MASK[5]);
    const kingCount   = _popcount(hand & _RANK_MASK[4]);

    let clogCnt = 0;
    for (let r = 0; r < topRankIdx; r++) clogCnt += _popcount(hand & _RANK_MASK[r]);
    const isDefenseless = aceCount === 0;
    const isClogged     = clogCnt >= Math.max(2, totalCards >> 1);
    const drawBonus     = (isDefenseless || isClogged) ? 4.0 : 1.0;

    // Inline weight computation (called twice — avoids closure allocation)
    // Returns the weight for move m
    // (draw handled separately via drawBonus)

    // Pass 1: sum weights, detect whether any play move exists
    let totalWeight = 0, hasPlay = false;
    for (let i = 0; i < pool.length; i++) {
        const m = pool[i];
        if (m & DRAW_FLAG) {
            totalWeight += drawBonus;
        } else {
            const bits    = m & 0xFFFFFF;
            const rankIdx = (31 - Math.clz32(bits & (-bits))) >> 2;
            const dist    = rankIdx - topRankIdx;
            let w         = Math.max(1, 6 - dist);
            if (totalCards >= 4) {
                if      (rankIdx === 5 && aceCount  === 1) w *= 0.05;
                else if (rankIdx === 4 && aceCount  === 0 && kingCount === 1) w *= 0.05;
            }
            totalWeight += w;
            hasPlay = true;
        }
    }
    if (!hasPlay) {
        for (let i = 0; i < pool.length; i++) {
            if (pool[i] & DRAW_FLAG) return pool[i];
        }
        return pool[0];
    }

    // Pass 2: weighted selection
    let r = Math.random() * totalWeight;
    for (let i = 0; i < pool.length; i++) {
        const m = pool[i];
        if (m & DRAW_FLAG) {
            r -= drawBonus;
        } else {
            const bits    = m & 0xFFFFFF;
            const rankIdx = (31 - Math.clz32(bits & (-bits))) >> 2;
            const dist    = rankIdx - topRankIdx;
            let w         = Math.max(1, 6 - dist);
            if (totalCards >= 4) {
                if      (rankIdx === 5 && aceCount  === 1) w *= 0.05;
                else if (rankIdx === 4 && aceCount  === 0 && kingCount === 1) w *= 0.05;
            }
            r -= w;
        }
        if (r <= 0) return m;
    }
    // Fallback (floating-point rounding safety)
    for (let i = pool.length - 1; i >= 0; i--) {
        if (!(pool[i] & DRAW_FLAG)) return pool[i];
    }
    return pool[0];
}

/**
 * Heuristic evaluation for inconclusive (stale) simulations.
 *
 * Returns a value in [−1, 1] reflecting rootPlayer’s position:
 *
 *   Hand size   — fewer cards → higher score       (weight 0.50)
 *   Card quality — clog cards (rank < top) penalised;
 *                  power cards (K, A) rewarded        (weight 0.20)
 *   Relative pos — fraction of opponents with more
 *                  cards = ahead of me                (weight 0.30)
 *
 * Calibration: a player at mean state scores ≈ −0.1 (slightly
 * pessimistic for a stale game), rising toward +0.7 when clearly
 * leading and falling toward −0.7 when loaded with clog cards.
 */
function _progressScore(state, rootPlayer) {
    const N    = state.numPlayers;
    const hand = state.hands[rootPlayer];
    const top  = state.topRankIdx;
    const size = _popcount(hand);

    // 1. Hand size score (worst realistic case ≈ 10 cards)
    const sizeScore = Math.max(0.0, 1.0 - size / 10.0);

    // 2. Card quality: clog = rank < top (permanently unplayable),
    //                  power = K or A   (always legally playable)
    let clogCnt = 0;
    for (let r = 0; r < top; r++) clogCnt += _popcount(hand & _RANK_MASK[r]);
    const powerCnt   = _popcount(hand & (_RANK_MASK[4] | _RANK_MASK[5]));
    const qualityAdj = size > 0
        ? (powerCnt * 0.08 - clogCnt * 0.15) / size
        : 0.0;

    // 3. Relative position among remaining players
    let activeCount = 0, aheadCount = 0;
    for (let p = 0; p < N; p++) {
        if (p === rootPlayer || (state.eliminated & (1 << p))) continue;
        activeCount++;
        if (_popcount(state.hands[p]) > size) aheadCount++;
    }
    const relPos = activeCount > 0 ? aheadCount / activeCount : 0.5;

    // Combine and map raw [0,1] range to [−1, 1]
    const raw = 0.5 * sizeScore + 0.2 * qualityAdj + 0.3 * relPos;
    return Math.max(-1.0, Math.min(1.0, raw * 2.0 - 0.8));
}

// ============================================================
// ISMCTSEngine
// ============================================================

export class ISMCTSEngine {

    // ----------------------------------------------------------
    // Personality Profiles
    // ----------------------------------------------------------

    static PROFILES = {

        shark: {
            name:             'The Shark',
            difficulty:       'Expert',
            maxIterations:    2000,
            explorationParam: 0.7,    // low → exploits known good moves
            weightStale:      -0.8,   // heavy penalty for inconclusive games
            maxTime:          500,    // ms hard ceiling
        },

        gambler: {
            name:             'The Gambler',
            difficulty:       'Aggressive',
            maxIterations:    800,
            explorationParam: 2.0,    // high → explores unusual lines
            weightStale:      -0.5,
            maxTime:          500,
        },

        newbie: {
            name:             'The Newbie',
            difficulty:       'Casual',
            maxIterations:    100,
            explorationParam: 1.41,   // √2 — standard UCB default
            weightStale:      -0.3,
            maxTime:          500,
        },
    };

    // ----------------------------------------------------------
    // Constructor
    // ----------------------------------------------------------

    /**
     * @param {object|string} profile
     *   Either a profile object or a key from ISMCTSEngine.PROFILES
     *   (e.g. 'shark', 'gambler', 'newbie').
     */
    constructor(profile) {
        this.profile = typeof profile === 'string'
            ? ISMCTSEngine.PROFILES[profile]
            : profile;
        this._root = null;
    }

    // ----------------------------------------------------------
    // Public API
    // ----------------------------------------------------------

    /**
     * Run ISMCTS and return the best move integer for the current player.
     *
     * @param {object}        state           Full game state (game-logic.js format)
     * @param {string|object} [profileOverride]  Optional one-shot profile override
     * @returns {number}  Move integer compatible with applyMove()
     */
    chooseMove(state, profileOverride) {
        const prof = profileOverride
            ? (typeof profileOverride === 'string'
                ? ISMCTSEngine.PROFILES[profileOverride]
                : profileOverride)
            : this.profile;

        const { maxIterations, explorationParam, weightStale, maxTime } = prof;
        const rootPlayer = state.currentPlayer;
        const deadline   = performance.now() + maxTime;

        this._root = new ISMCTSNode();

        for (let i = 0; i < maxIterations; i++) {
            if (performance.now() > deadline) break;

            // 1. Determinize: fill in unknown opponent cards
            const det = this._determinize(state, rootPlayer);

            // 2. Selection + Expansion
            const { node, simState } = this._selectExpand(this._root, det, explorationParam);

            // 3. Random playout
            const score = this._simulate(simState, rootPlayer, weightStale);

            // 4. Backpropagate
            this._backprop(node, score);
        }

        const best = this._bestMove(this._root);

        // Safety fallback: if tree is empty (game already over), play first legal move
        if (best === null) {
            const moves = getPossibleMoves(state);
            const plays = moves.filter(m => !(m & DRAW_FLAG));
            return (plays.length > 0 ? plays : moves)[0] ?? 0;
        }

        return best;
    }

    /**
     * Release the search tree to free memory.
     * Call this after every move is applied to keep mobile RAM usage low.
     */
    cleanup() {
        this._root = null;
    }

    // ----------------------------------------------------------
    // ISMCTS phases  (private)
    // ----------------------------------------------------------

    /**
     * Determinization:
     *   Keep rootPlayer's hand and the pile exactly as-is.
     *   Randomly redistribute every other card among opponents
     *   while preserving each opponent's exact hand SIZE.
     */
    _determinize(state, rootPlayer) {
        const det = copyState(state);

        // Cards visible to rootPlayer
        let known = state.hands[rootPlayer];
        for (let i = 0; i < state.pileSize; i++) known |= (1 << state.pile[i]);

        // Unknown cards = full 24-bit universe minus visible cards
        const n = _bitsToArray((~known) & 0xFFFFFF);
        _shuffle(n);

        let ptr = 0;
        for (let p = 0; p < state.numPlayers; p++) {
            if (p === rootPlayer) continue;
            const sz = _popcount(state.hands[p]);
            det.hands[p] = 0;
            for (let c = 0; c < sz && ptr < n; c++) {
                det.hands[p] |= (1 << _buf[ptr++]);
            }
        }

        return det;
    }

    /**
     * Selection + Expansion:
     *   Traverse the shared tree following UCB1 on legal moves,
     *   incrementing each legal child's avails counter.
     *   Expand one untried edge per iteration.
     *
     * @returns {{ node: ISMCTSNode, simState: object }}
     */
    _selectExpand(root, state, C) {
        let node = root;
        let s    = state;

        while (!isGameOver(s)) {
            const legal = getPossibleMoves(s);
            if (legal.length === 0) break;

            // Increment avails for every child that is legal in this determinization
            for (let i = 0; i < legal.length; i++) {
                const ch = node.children.get(legal[i]);
                if (ch) ch.avails++;
            }

            // Collect untried legal moves
            let untried = null;
            for (let i = 0; i < legal.length; i++) {
                if (!node.children.has(legal[i])) {
                    if (untried === null) untried = [];
                    untried.push(legal[i]);
                }
            }

            if (untried !== null) {
                // Expand: add one new child for a randomly chosen untried move
                const move  = untried[(Math.random() * untried.length) | 0];
                const child = new ISMCTSNode(move, node);
                child.avails = 1;
                node.children.set(move, child);
                node = child;
                s    = applyMove(s, move);
                break;  // proceed to simulation from newly expanded node
            }

            // All moves tried: select best legal child by UCB1
            let bestChild = null, bestScore = -Infinity;
            for (let i = 0; i < legal.length; i++) {
                const ch = node.children.get(legal[i]);
                if (!ch) continue;
                const sc = ch.ucb1(C);
                if (sc > bestScore) { bestScore = sc; bestChild = ch; }
            }
            if (!bestChild) break;

            node = bestChild;
            s    = applyMove(s, bestChild.move);
        }

        return { node, simState: s };
    }

    /**
     * Quality-biased playout from a leaf state.
     *
     * Move selection: weighted random favouring low-rank cards
     * (dump 9s first, hold Aces) — balances Hand Size with Rank Quality.
     *
     * Scoring (from rootPlayer's perspective) — ranked finish:
     *   1st safe : +1.0
     *   2nd safe : +0.5
     *   3rd safe : +0.2
     *   Loser    : -1.0
     *   Stale (>100 turns): profile.weightStale
     */
    _simulate(state, rootPlayer, weightStale) {
        let s = state, turns = 0;
        const N = s.numPlayers;

        // Initialise elimination-rank tracker
        _elimRank.fill(-1, 0, N);
        let nextRank = 0;

        // Pre-populate players already eliminated before this simulation starts
        for (let p = 0; p < N; p++) {
            if (s.eliminated & (1 << p)) _elimRank[p] = nextRank++;
        }

        while (!isGameOver(s)) {
            if (++turns > 100) return _progressScore(s, rootPlayer);

            const moves = getPossibleMoves(s);
            if (moves.length === 0) break;

            const prevElim = s.eliminated;
            s = applyMove(s, _pickQualityMove(moves, s.topRankIdx, s.hands[s.currentPlayer]));

            // Record any newly safe players in finish order
            let newlyElim = s.eliminated & ~prevElim;
            while (newlyElim) {
                const lb = newlyElim & (-newlyElim);
                _elimRank[31 - Math.clz32(lb)] = nextRank++;
                newlyElim &= ~lb;
            }
        }

        // Remaining (non-eliminated) player is the loser
        for (let p = 0; p < N; p++) {
            if (_elimRank[p] === -1) _elimRank[p] = nextRank;
        }

        const RANK_SCORES = [1.0, 0.5, 0.2, -1.0];
        return RANK_SCORES[Math.min(_elimRank[rootPlayer], RANK_SCORES.length - 1)] ?? -1.0;
    }

    /** Backpropagate score from leaf to root. */
    _backprop(node, score) {
        let n = node;
        while (n !== null) {
            n.visits++;
            n.wins += score;
            n = n.parent;
        }
    }

    /**
     * Return the move with the highest visit count (most robust child policy).
     * This is preferred over max win-rate to reduce variance from low-sample outliers.
     */
    _bestMove(root) {
        let bestMove = null, bestVisits = -1;
        for (const [move, child] of root.children) {
            if (child.visits > bestVisits) {
                bestVisits = child.visits;
                bestMove   = move;
            }
        }
        return bestMove;
    }
}
