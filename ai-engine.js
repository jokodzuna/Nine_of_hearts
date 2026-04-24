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
 * Per-player forced card bitmasks reused during knowledge-refined determinization.
 * Avoids heap allocation inside the hot _determinize loop.
 */
const _forced = new Int32Array(8);

/**
 * Rank masks — mirrors game-logic.js RANK_MASK (avoids extra import).
 *   index 0 = 9s (bits 0-3) … index 5 = As (bits 20-23)
 */
const _RANK_MASK = new Int32Array([
    0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000,
]);

/**
 * Compute the draw-move bonus weight from actual pile card quality and hand state.
 *
 * Base quality: average rank index of the top min(3, pileSize-1) drawable pile
 * cards, scaled to [0.5, 3.0].  Multiplied by 2.0 when defenseless or clogged.
 *
 * @param {object} state  Current game state (pile intact, pre-move).
 * @param {number} hand   Current player's hand bitmask.
 * @returns {number}  Weight to assign to the draw move.
 */
function _pileDrawBonus(state, hand) {
    const topRankIdx    = state.topRankIdx;
    const aceCount      = _popcount(hand & _RANK_MASK[5]);
    const totalCards    = _popcount(hand);
    let clogCnt = 0;
    for (let r = 0; r < topRankIdx; r++) clogCnt += _popcount(hand & _RANK_MASK[r]);
    const isDefenseless = aceCount === 0;
    const isClogged     = clogCnt >= Math.max(2, totalCards >> 1);

    const drawable = Math.min(3, state.pileSize - 1);
    let base;
    if (drawable === 0) {
        base = 0.1;  // nothing to draw — strongly discourage
    } else {
        let rankSum = 0;
        for (let i = 0; i < drawable; i++) {
            rankSum += (state.pile[state.pileSize - 1 - i] >> 2);  // rankIdx 0–5
        }
        base = 0.5 + (rankSum / drawable / 5) * 2.5;  // [0.5 (all 9s) … 3.0 (all As)]
    }
    return (isDefenseless || isClogged) ? base * 2.0 : base;
}

/**
 * Expert Survival weighted move selector.
 *
 * Base weight: max(1, 6 − dist) where dist = card rank − topRankIdx.
 * Modifiers applied on top:
 *
 *   Ace Scarcity   — last Ace in hand with 3+ cards left  → weight × 0.05
 *   King Scarcity  — last King when no Aces, 3+ cards left → weight × 0.05
 *                    (cascade: if no Aces, King becomes the power card)
 *   Draw Bonus     — caller-supplied weight derived from _pileDrawBonus(),
 *                    reflecting actual quality of the top drawable pile cards.
 *
 * @param {number[]} pool        legal moves from getPossibleMoves
 * @param {number}   topRankIdx  state.topRankIdx (0–5)
 * @param {number}   hand        current player's hand bitmask
 * @param {boolean}  twoAcesOnTop  true when top 2 pile cards are both Aces
 * @param {number}   drawBonus   draw-move weight from _pileDrawBonus()
 */
function _pickQualityMove(pool, topRankIdx, hand, twoAcesOnTop = false, drawBonus = 1.0) {
    const totalCards  = _popcount(hand);
    const aceCount    = _popcount(hand & _RANK_MASK[5]);
    const kingCount   = _popcount(hand & _RANK_MASK[4]);

    // Compute weight for a single play move (inlined in both passes)
    // twoAcesOnTop: top 2 pile cards are Aces → suppress a 3rd Ace heavily
    // Burning threshold: 3+ cards (was 4)
    const _w = (bits, rankIdx) => {
        const dist = rankIdx - topRankIdx;
        let w = Math.max(1, 6 - dist);
        if (totalCards >= 3) {
            if      (rankIdx === 5 && aceCount  === 1) w *= 0.05;
            else if (rankIdx === 4 && aceCount  === 0 && kingCount === 1) w *= 0.05;
        }
        if (twoAcesOnTop && rankIdx === 5 && totalCards > 2) w *= 0.01;
        return w;
    };

    // Pass 1: sum weights, detect whether any play move exists
    let totalWeight = 0, hasPlay = false;
    for (let i = 0; i < pool.length; i++) {
        const m = pool[i];
        if (m & DRAW_FLAG) {
            totalWeight += drawBonus;
        } else {
            const bits    = m & 0xFFFFFF;
            const rankIdx = (31 - Math.clz32(bits & (-bits))) >> 2;
            totalWeight  += _w(bits, rankIdx);
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
            r -= _w(bits, rankIdx);
        }
        if (r <= 0) return m;
    }
    // Fallback (floating-point rounding safety)
    for (let i = pool.length - 1; i >= 0; i--) {
        if (!(pool[i] & DRAW_FLAG)) return pool[i];
    }
    return pool[0];
}

// ============================================================
// RHV — Relative Hand Value
// ============================================================

/** Point values indexed by rank (0=9 … 5=A). */
const _RHV_VALS = new Int16Array([-20, -5, 5, 12, 17, 25]);

/** Divisor for normalising a single-hand RHV to [-1, 1]. */
const _RHV_NORM = 25.0;

/** Divisor for normalising a 2-player RHV differential to [-1, 1]. */
const _RHV_DIFF_NORM = 50.0;

/**
 * Compute the Relative Hand Value for a 24-bit hand bitmask.
 *
 *   Empty hand               → +50  (Safe Bonus)
 *   Three 9s  (group)        → -20 total, counts as 1 card
 *   Four 10s  (group)        → -5  total, counts as 1 card
 *   Four J/Q/K/A (quad)      → +5 added to total  (Quad Bonus)
 *   All other cards          → _RHV_VALS[rank] each, count 1 each
 *
 *   RHV = (sum + quadBonus) / effectiveCardCount
 *
 * @param {number} hand  24-bit bitmask
 * @returns {number}
 */
function _computeRHV(hand) {
    if (!hand) return 50.0;
    let sum = 0, effCount = 0, quadBonus = 0;
    for (let r = 0; r < 6; r++) {
        const group = hand & _RANK_MASK[r];
        if (!group) continue;
        const cnt = _popcount(group);
        if (r === 0 && cnt === 3) {            // Three 9s — special group
            sum -= 20; effCount += 1;
        } else if (r === 1 && cnt === 4) {     // Four 10s — special group
            sum -= 5;  effCount += 1;
        } else {
            sum += _RHV_VALS[r] * cnt;
            effCount += cnt;
            if (cnt === 4 && r >= 2) quadBonus = 5;  // Quad J/Q/K/A
        }
    }
    return effCount > 0 ? (sum + quadBonus) / effCount : 0.0;
}

/**
 * RHV Guard — disqualifies play moves whose resulting-hand RHV would drop
 * by more than 5 points vs the current hand.  Draw moves are always kept.
 *
 * Safety fallback: if every play move is disqualified AND no draw is
 * available, the single least-bad play move is retained so the AI never
 * deadlocks on a forced play.
 *
 * @param {number[]} moves  Legal moves from getPossibleMoves
 * @param {number}   hand   Current player's 24-bit hand bitmask
 * @returns {number[]}      Filtered move list
 */
function _applyRHVGuard(moves, hand) {
    const curRHV = _computeRHV(hand);
    const out    = [];
    let   hasDraw = false, hasPlay = false;
    let   fallbackMove = 0, fallbackRHV = -Infinity;

    for (let i = 0; i < moves.length; i++) {
        const m = moves[i];
        if (m & DRAW_FLAG) {
            out.push(m);
            hasDraw = true;
        } else {
            const newHand = (hand & ~(m & 0xFFFFFF)) | 0;
            const newRHV  = _computeRHV(newHand);
            if (curRHV - newRHV <= 5) {
                out.push(m);
                hasPlay = true;
            } else if (newRHV > fallbackRHV) {
                fallbackRHV  = newRHV;
                fallbackMove = m;
            }
        }
    }

    // Keep at least one move to avoid deadlock
    if (!hasPlay && !hasDraw && fallbackMove !== 0) out.push(fallbackMove);
    return out.length > 0 ? out : moves;
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
            maxIterations:    3000,
            explorationParam: 0.7,    // low → exploits known good moves
            weightStale:      -0.8,   // retained for reference
            maxTime:          500,    // ms hard ceiling
            maxTurns:         250,    // playout turn limit before heuristic fallback
            useCardTracking:  true,   // Short-Term Memory: track observed drawn cards
            useTreeReuse:     true,   // persist subtree between turns
        },

        gambler: {
            name:             'The Gambler',
            difficulty:       'Aggressive',
            maxIterations:    800,
            explorationParam: 2.0,    // high → explores unusual lines
            weightStale:      -0.5,
            maxTime:          500,
            maxTurns:         100,
        },

        newbie: {
            name:             'The Newbie',
            difficulty:       'Casual',
            maxIterations:    100,
            explorationParam: 1.41,   // √2 — standard UCB default
            weightStale:      -0.3,
            maxTime:          500,
            maxTurns:         100,
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
        this._root          = null;
        this._pendingRoot   = null;  // subtree saved for reuse (Shark only)
        this._cardKnowledge = null;  // Int32Array(numPlayers) — Shark only
        this._pileSeenMask  = 0;     // bitmask of all cards ever played to pile — Shark only
    }

    // ----------------------------------------------------------
    // Public API
    // ----------------------------------------------------------

    // ----------------------------------------------------------
    // Card Tracking  (Short-Term Memory — Shark only)
    // ----------------------------------------------------------

    /**
     * Observe a move BEFORE it is applied to update card knowledge.
     *
     * Draw move  — the top-N pile cards become known to be in currentPlayer's hand.
     * Play move  — remove the played cards from that player's knowledge entry.
     * No-op when useCardTracking is false (e.g. Gambler, Newbie profiles).
     *
     * @param {object} state  Pre-move game state (pile intact).
     * @param {number} move   Move integer from getPossibleMoves.
     */
    observeMove(state, move) {
        if (!this.profile.useCardTracking) return;

        if (this._cardKnowledge === null) {
            this._cardKnowledge = new Int32Array(state.numPlayers);
        }

        const p = state.currentPlayer;

        if (move & DRAW_FLAG) {
            // Public information: the top-N pile cards move to this player's hand
            const count = (move & 3) + 1;
            for (let i = 0; i < count; i++) {
                const bitIdx = state.pile[state.pileSize - 1 - i];
                this._cardKnowledge[p] |= (1 << bitIdx);
            }
        } else {
            // Cards played to pile are now publicly seen; remove from hand knowledge
            const played = (move & 0xFFFFFF);
            this._pileSeenMask |= played;
            this._cardKnowledge[p] &= ~played;
        }
    }

    /**
     * Clear all card knowledge.
     * Call when a new game starts or when this engine's player is reset.
     */
    resetKnowledge() {
        this._cardKnowledge = null;
        this._pendingRoot   = null;
        this._pileSeenMask  = 0;
    }

    /**
     * Advance the saved search tree through a move that was actually played.
     * Call for EVERY move (by any player) immediately before the state is updated.
     *
     * - If the move was explored in the tree, the matching child becomes the new
     *   pending root for the next chooseMove call (warm-start).
     * - If the move was never explored, the pending root is discarded (cold start).
     * - No-op for profiles without useTreeReuse.
     *
     * @param {number} move  Move integer that was just chosen.
     */
    advanceTree(move) {
        if (!this.profile.useTreeReuse) return;

        const root = this._root ?? this._pendingRoot;
        if (root === null) { this._root = null; return; }

        const child = root.children.get(move);
        if (child) {
            child.parent     = null;   // sever to allow GC of the rest of the tree
            this._pendingRoot = child;
        } else {
            this._pendingRoot = null;  // unexplored move → fresh root next time
        }
        this._root = null;
    }

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

        const { maxIterations, explorationParam, maxTime, maxTurns = 100 } = prof;
        const rootPlayer = state.currentPlayer;
        const deadline   = performance.now() + maxTime;

        // Warm-start: reuse subtree from previous turn if available (Shark only)
        this._root         = this._pendingRoot ?? new ISMCTSNode();
        this._pendingRoot  = null;

        for (let i = 0; i < maxIterations; i++) {
            if (performance.now() > deadline) break;

            // 1. Determinize: fill in unknown opponent cards
            const det = this._determinize(state, rootPlayer);

            // 2. Selection + Expansion
            const { node, simState } = this._selectExpand(this._root, det, explorationParam);

            // 3. Quality playout with per-profile turn limit
            const score = this._simulate(simState, rootPlayer, maxTurns);

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

        // Double Ace hard veto: if the top TWO pile cards are both Aces, the AI
        // must not play a third Ace unless it has ≤2 cards left (true last resort).
        const myCount      = _popcount(state.hands[rootPlayer]);
        const twoAcesOnTop = state.topRankIdx === 5
            && state.pileSize >= 2
            && (state.pile[state.pileSize - 2] >> 2) === 5;

        if (twoAcesOnTop && myCount > 2 && !(best & DRAW_FLAG)) {
            const bestRank = (31 - Math.clz32((best & 0xFFFFFF) & (-(best & 0xFFFFFF)))) >> 2;
            if (bestRank === 5) {
                // Override: pick next-best non-Ace move by visit count, fall back to draw
                let altMove = null, altVisits = -1;
                for (const [move, child] of this._root.children) {
                    if (move & DRAW_FLAG) continue;
                    const rank = (31 - Math.clz32((move & 0xFFFFFF) & (-(move & 0xFFFFFF)))) >> 2;
                    if (rank !== 5 && child.visits > altVisits) {
                        altVisits = child.visits;
                        altMove   = move;
                    }
                }
                if (altMove === null) {
                    for (const [move, child] of this._root.children) {
                        if ((move & DRAW_FLAG) && child.visits > altVisits) {
                            altVisits = child.visits;
                            altMove   = move;
                        }
                    }
                }
                if (altMove !== null) return altMove;
            }
        }

        // End-game danger veto: if the chosen move lets any opponent with ≤4
        // cards finish immediately (unknown pool contains enough same-rank cards
        // ≥ new top rank), prefer the safest alternative from the tree.
        return this._safetyCheck(state, rootPlayer, best);
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
     *   If card tracking is active (Shark), force known opponent cards into the
     *   correct hands first, then randomly redistribute the remaining pool
     *   while preserving each opponent's exact hand SIZE.
     */
    _determinize(state, rootPlayer) {
        const det = copyState(state);
        const N   = state.numPlayers;

        // Cards visible to rootPlayer: own hand + current pile + all cards ever
        // played to the pile (Shark pile memory — publicly-seen history)
        let known = state.hands[rootPlayer];
        for (let i = 0; i < state.pileSize; i++) known |= (1 << state.pile[i]);
        if (this._pileSeenMask) known |= this._pileSeenMask;

        const unknown = (~known) & 0xFFFFFF;

        // Build forced sets from card knowledge (Shark only)
        let forcedUnion = 0;
        _forced.fill(0, 0, N);

        if (this._cardKnowledge !== null) {
            for (let p = 0; p < N; p++) {
                if (p === rootPlayer || (state.eliminated & (1 << p))) continue;

                // Cards we know p holds that are still in the unknown pool
                const candidate = this._cardKnowledge[p] & unknown & ~forcedUnion;
                const sz        = _popcount(state.hands[p]);
                const cnt       = _popcount(candidate);

                if (cnt <= sz) {
                    _forced[p]   = candidate;
                    forcedUnion |= candidate;
                } else {
                    // Stale tracking: trim to the player's current hand size
                    let bits = candidate, trimmed = 0;
                    for (let i = 0; i < sz && bits; i++) {
                        const lb = bits & (-bits);
                        trimmed |= lb;
                        bits    &= ~lb;
                    }
                    _forced[p]   = trimmed;
                    forcedUnion |= trimmed;
                }
            }
        }

        // Shuffle the remaining unknown cards (excluding forced ones)
        const n = _bitsToArray(unknown & ~forcedUnion);
        _shuffle(n);

        let ptr = 0;
        for (let p = 0; p < N; p++) {
            if (p === rootPlayer) continue;
            if (state.eliminated & (1 << p)) { det.hands[p] = 0; continue; }

            const sz        = _popcount(state.hands[p]);
            const forcedCnt = _popcount(_forced[p]);
            det.hands[p]    = _forced[p];

            // Fill remaining slots from the random pool
            const need = sz - forcedCnt;
            for (let c = 0; c < need && ptr < n; c++) {
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
            const raw   = getPossibleMoves(s);
            if (raw.length === 0) break;
            const legal = _applyRHVGuard(raw, s.hands[s.currentPlayer]);

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
     * RHV-based quality playout from a leaf state.
     *
     * Depth: numPlayers × 8 turns (16 / 24 / 32 for 2 / 3 / 4 players).
     *
     * Scoring at playout end (hit depth or game over):
     *   2 players : normalised (AI_RHV − Opponent_RHV) / 50   → [-1, 1]
     *   3-4 players: normalised AI_RHV / 25                   → [-1, 1]
     *   Empty hand (safe) returns RHV = +50 → clamped to +1.
     */
    _simulate(state, rootPlayer, _unused) {
        let s = state, turns = 0;
        const N          = s.numPlayers;
        const depthLimit = N * 3;  // 6 / 9 / 12 — 3 rounds per player

        while (!isGameOver(s)) {
            if (++turns > depthLimit) break;

            const raw    = getPossibleMoves(s);
            if (raw.length === 0) break;
            const moves  = _applyRHVGuard(raw, s.hands[s.currentPlayer]);

            const twoAcesOnTop = s.topRankIdx === 5
                && s.pileSize >= 2
                && (s.pile[s.pileSize - 2] >> 2) === 5;
            const drawBonus = _pileDrawBonus(s, s.hands[s.currentPlayer]);
            s = applyMove(s, _pickQualityMove(moves, s.topRankIdx, s.hands[s.currentPlayer], twoAcesOnTop, drawBonus));
        }

        // RHV scoring
        const myRHV = _computeRHV(s.hands[rootPlayer]);
        if (N === 2) {
            const opp    = 1 - rootPlayer;
            const oppRHV = _computeRHV(s.hands[opp]);
            return Math.max(-1.0, Math.min(1.0, (myRHV - oppRHV) / _RHV_DIFF_NORM));
        }
        return Math.max(-1.0, Math.min(1.0, myRHV / _RHV_NORM));
    }

    /**
     * End-game danger veto.
     *
     * After ISMCTS selects a move, this checks whether it could let any
     * opponent immediately empty their hand on the very next turn.
     * The check is cheap (no tree search) and only activates when an
     * opponent holds ≤ DANGER_CARDS cards.
     *
     * A move is "risky" when, after it is played:
     *   ∃ rank R ≥ new_topRank  such that  unknown_pool[R] >= opponent_hand_size
     * i.e., there exists a consistent world where the opponent holds a complete
     * same-rank group and can finish on their next turn.
     *
     * If the best ISMCTS move is risky, the method returns the highest-visited
     * NON-risky alternative, or the original move if none exists.
     */
    _safetyCheck(state, rootPlayer, chosenMove) {
        const DANGER_CARDS = 4;
        const N = state.numPlayers;

        // Fast exit: no opponent in danger zone
        let anyDanger = false;
        for (let p = 0; p < N; p++) {
            if (p === rootPlayer || (state.eliminated & (1 << p))) continue;
            if (_popcount(state.hands[p]) <= DANGER_CARDS) { anyDanger = true; break; }
        }
        if (!anyDanger) return chosenMove;

        // Build the unknown card pool (cards root player has not seen)
        let knownMask = state.hands[rootPlayer];
        for (let i = 0; i < state.pileSize; i++) knownMask |= (1 << state.pile[i]);
        if (this._pileSeenMask) knownMask |= this._pileSeenMask;
        const unknownPool = (~knownMask) & 0xFFFFFF;

        // Returns true if `move` could allow an immediate opponent finish
        const _isRisky = (move) => {
            if (move & DRAW_FLAG) return false; // draw doesn't set a new top rank
            const bits       = move & 0xFFFFFF;
            const lb         = bits & (-bits);
            const newTopRank = (31 - Math.clz32(lb)) >> 2;

            for (let p = 0; p < N; p++) {
                if (p === rootPlayer || (state.eliminated & (1 << p))) continue;
                const opSz = _popcount(state.hands[p]);
                if (opSz > DANGER_CARDS || opSz === 0) continue;

                for (let r = newTopRank; r < 6; r++) {
                    if (_popcount(unknownPool & _RANK_MASK[r]) >= opSz) return true;
                }
            }
            return false;
        };

        if (!_isRisky(chosenMove)) return chosenMove;

        // Chosen move is risky — find the best-visited non-risky alternative
        let altMove = null, altVisits = -1;
        for (const [move, child] of this._root.children) {
            if (!_isRisky(move) && child.visits > altVisits) {
                altVisits = child.visits;
                altMove   = move;
            }
        }
        return altMove ?? chosenMove;
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
