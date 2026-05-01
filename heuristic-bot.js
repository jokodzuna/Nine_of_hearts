// ============================================================
// heuristic-bot.js — Rule-based heuristic bot for Nine of Hearts
//
// Strategy pillars (from game-theory analysis):
//   1. Power reserve: never let Aces drop below safety threshold
//   2. Escalation resistance: don't match K/A pressure if it would
//      drain power below threshold — draw instead
//   3. Ace dominance: when holding Ace advantage, escalate aggressively
//   4. Junk management: dump 9s/10s when safe, preserve power cards
//   5. Full card tracking: knows exactly what was drawn/played
//   6. Pile transparency: knows exact cards we would draw
//
// Public API (same shape as ISMCTSEngine):
//   observeMove(state, move)  — call before every move (all players)
//   advanceTree(move)         — no-op (no tree to advance)
//   resetKnowledge()          — call on new game
//   cleanup()                 — no-op
//   chooseMove(state)         — returns move integer
// ============================================================

import {
    getPossibleMoves,
    DRAW_FLAG,
    RANK_MASK,
} from './game-logic.js';

// ============================================================
// Local helpers (avoid import of non-exported internals)
// ============================================================

function _popcount(x) {
    x = (x | 0);
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    x = (x + (x >>> 4)) & 0x0F0F0F;
    return Math.imul(x, 0x010101) >>> 16;
}

/** Rank index (0–5) of the lowest-rank card in a move bitmask. */
function _moveRankIdx(moveBits) {
    const lb = moveBits & (-moveBits);
    return (31 - Math.clz32(lb)) >> 2;
}

/** Number of cards in a play move (1, 3, or 4). */
function _moveCount(moveBits) { return _popcount(moveBits); }

// ============================================================
// HeuristicBot
// ============================================================

export class HeuristicBot {
    constructor() {
        this._cardKnowledge = null; // Int32Array(numPlayers) — confirmed cards per player
        this._pileSeenMask  = 0;    // union of all cards ever pushed to pile
    }

    // ----------------------------------------------------------
    // Card Tracking  (identical protocol to ISMCTSEngine)
    // ----------------------------------------------------------

    /**
     * Observe a move before it is applied.
     * Draw  → top-N pile cards are now known to be in that player's hand.
     * Play  → remove played cards from their knowledge entry.
     */
    observeMove(state, move) {
        if (this._cardKnowledge === null) {
            this._cardKnowledge = new Int32Array(state.numPlayers);
        }
        const p = state.currentPlayer;
        if (move & DRAW_FLAG) {
            const count = (move & 3) + 1;
            for (let i = 0; i < count; i++) {
                const b = state.pile[state.pileSize - 1 - i];
                this._cardKnowledge[p] |= (1 << b);
            }
        } else {
            const played = (move & 0xFFFFFF) | 0;
            this._pileSeenMask         |= played;
            this._cardKnowledge[p]     &= ~played;
        }
    }

    advanceTree(_move) { /* no tree — no-op */ }

    resetKnowledge() {
        this._cardKnowledge = null;
        this._pileSeenMask  = 0;
    }

    cleanup() { /* no resources to free */ }

    // ----------------------------------------------------------
    // Main decision function
    // ----------------------------------------------------------

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        if (moves.length === 1) return moves[0];

        const myP     = state.currentPlayer;
        const myHand  = state.hands[myP];
        const myTotal = _popcount(myHand);
        const topRI   = state.topRankIdx;   // 0=9, 1=10, 2=J, 3=Q, 4=K, 5=A

        // ---- My hand breakdown by rank ----
        const myAces  = _popcount(myHand & RANK_MASK[5]);
        const myKings = _popcount(myHand & RANK_MASK[4]);
        const my9s    = _popcount(myHand & RANK_MASK[0]);

        // Cards I cannot currently play (below pile top)
        let stuckCount = 0;
        for (let r = 0; r < topRI; r++) stuckCount += _popcount(myHand & RANK_MASK[r]);

        // ---- Pile analysis ----
        const drawable  = state.pileSize - 1;          // 9♥ always stays
        const drawCount = Math.min(3, drawable);

        // Exact cards we would draw (top of pile stack)
        let drawRankMask = 0; // bitmask of rank indices in draw pile
        for (let i = 0; i < drawCount; i++) {
            const ri = state.pile[state.pileSize - 1 - i] >> 2;
            drawRankMask |= (1 << ri);
        }
        const drawHasAce  = !!(drawRankMask & (1 << 5));
        const drawHasKing = !!(drawRankMask & (1 << 4));

        // Count Aces/Kings already permanently in pile (not drawable — excluded from pool)
        // We count ALL pile cards; the ones beyond drawCount are buried deeper.
        // For opponent estimation we only need total-in-pile.
        let acesInPile = 0, kingsInPile = 0;
        for (let i = 0; i < state.pileSize; i++) {
            const ri = state.pile[i] >> 2;
            if (ri === 5) acesInPile++;
            else if (ri === 4) kingsInPile++;
        }

        // ---- Opponent analysis ----
        const opps = [];
        for (let p = 0; p < state.numPlayers; p++) {
            if (p !== myP && !(state.eliminated & (1 << p))) opps.push(p);
        }

        let oppEstAces = 0, oppEstKings = 0, oppMinCards = Infinity;
        for (const oppP of opps) {
            const oppTotal = _popcount(state.hands[oppP]);
            if (oppTotal < oppMinCards) oppMinCards = oppTotal;

            // Deduction floor: remaining cards not in my hand or pile must be in opponents
            const acesElsewhere  = Math.max(0, 4 - myAces - acesInPile);
            const kingsElsewhere = Math.max(0, 4 - myKings - kingsInPile);

            let ea = Math.min(acesElsewhere,  oppTotal);
            let ek = Math.min(kingsElsewhere, oppTotal);

            // Card-tracking override: we know confirmed cards
            if (this._cardKnowledge !== null) {
                ea = Math.max(ea, _popcount(this._cardKnowledge[oppP] & RANK_MASK[5]));
                ek = Math.max(ek, _popcount(this._cardKnowledge[oppP] & RANK_MASK[4]));
            }

            oppEstAces  += ea;
            oppEstKings += ek;
        }
        if (opps.length === 0) oppMinCards = 0;

        // ---- Safety thresholds ----
        // Need ≥2 Aces when hand is large (early/mid game), ≥1 in late game
        const safeAceMin = myTotal > 6 ? 2 : 1;

        // ---- Separate moves ----
        const drawMove  = moves.find(m => !!(m & DRAW_FLAG)) ?? null;
        const playMoves = moves.filter(m => !(m & DRAW_FLAG));

        const wouldWin  = m => ((myHand & ~(m & 0xFFFFFF)) | 0) === 0;
        const playRI    = m => _moveRankIdx(m & 0xFFFFFF);
        const playCnt   = m => _moveCount(m & 0xFFFFFF);

        // ==============================================================
        // RULE 1 — Instant win: emptying hand this turn
        // ==============================================================
        for (const m of playMoves) {
            if (wouldWin(m)) return m;
        }

        // ==============================================================
        // RULE 2 — Triple 9s: most powerful junk dump available
        // Only legal when pile top is also rank 9
        // ==============================================================
        if (topRI === 0 && my9s === 3) {
            const tripleNine = playMoves.find(m => playCnt(m) === 3 && playRI(m) === 0);
            if (tripleNine) return tripleNine;
        }

        // ==============================================================
        // RULE 3 — 4-of-a-kind junk dump (rank 9–Q only, power is safe)
        // ==============================================================
        for (const m of playMoves) {
            if (playCnt(m) === 4 && playRI(m) <= 3 && myAces >= safeAceMin) return m;
        }

        // ==============================================================
        // RULE 4 — Top card is A: Ace battle
        // ==============================================================
        if (topRI === 5) {
            const aceMoves = playMoves.filter(m => playRI(m) === 5);
            if (aceMoves.length > 0) {
                const acesAfter = myAces - 1;
                const safeToPlay = acesAfter >= safeAceMin
                    || oppEstAces === 0               // opponent has no Aces at all
                    || myAces > oppEstAces + 1;       // dominant Ace advantage
                if (safeToPlay) return aceMoves[0];
            }
            // Can't safely spend Ace — draw
            return drawMove ?? playMoves[0];
        }

        // ==============================================================
        // RULE 5 — Top card is K: escalation decision
        // ==============================================================
        if (topRI === 4) {
            const aceMoves  = playMoves.filter(m => playRI(m) === 5);
            const kingMoves = playMoves.filter(m => playRI(m) === 4);

            // 5a. Escalate with A if we have Ace dominance
            if (aceMoves.length > 0) {
                const acesAfter = myAces - 1;
                const dominant  = oppEstAces === 0 && acesAfter >= 1;
                const advantage = acesAfter >= safeAceMin && myAces > oppEstAces;
                if (dominant || advantage) return aceMoves[0];
            }

            // 5b. Draw if pile holds power cards we're deficient in
            if (drawMove !== null) {
                if (drawHasAce  && myAces < safeAceMin)     return drawMove; // rescue Ace
                if (drawHasKing && myKings <= 1 && aceMoves.length === 0) return drawMove; // get backup K
            }

            // 5c. Match K if we have enough reserve
            if (kingMoves.length > 0 && (myKings >= 2 || myAces >= safeAceMin)) {
                return kingMoves[0];
            }

            // 5d. Fall back to drawing (preserve last K / Aces)
            return drawMove ?? playMoves[playMoves.length - 1];
        }

        // ==============================================================
        // RULE 6 — Top ≤ Q: junk-dump phase
        // ==============================================================

        // Apply lone-Ace guard: last Ace is too valuable to play unless it wins
        let safePlays = [...playMoves];
        if (myAces === 1 && myTotal > 2) {
            const filtered = safePlays.filter(m => playRI(m) !== 5);
            if (filtered.length > 0) safePlays = filtered;
        }

        // 6a. Opponent near win — apply maximum pressure
        if (oppMinCards <= 4 && safePlays.length > 0) {
            // Play highest available card to raise the bar for opponent
            const sorted = [...safePlays].sort((a, b) => playRI(b) - playRI(a));
            const highest = sorted[0];
            const hRI     = playRI(highest);
            // Only escalate with K if we still have Ace cover
            if (hRI === 4 && myAces >= safeAceMin) return highest;
            // Play anything below K freely (Q, J, 10, 9)
            if (hRI < 4) return highest;
            // King but Ace-deficient: find next best
            const nonK = sorted.find(m => playRI(m) < 4);
            if (nonK) return nonK;
        }

        // 6b. Deeply stuck AND pile has power cards → draw to improve hand
        if (drawMove !== null && stuckCount >= Math.ceil(myTotal / 2) && (drawHasAce || drawHasKing)) {
            return drawMove;
        }

        // 6c. Ace-dominant: escalate with K to pressure opponent
        if (oppEstAces === 0 && myAces >= safeAceMin && myKings >= 1) {
            const kingMoves = safePlays.filter(m => playRI(m) === 4);
            if (kingMoves.length > 0) return kingMoves[0];
        }

        // 6d. Prefer singles when hand is large (preserve combo potential)
        let candidates = safePlays;
        if (myTotal > 4) {
            const singles = safePlays.filter(m => playCnt(m) === 1);
            if (singles.length > 0) candidates = singles;
        }

        // 6e. Play lowest-rank card first (dump junk: 9s before 10s before Js …)
        candidates.sort((a, b) => playRI(a) - playRI(b));
        return candidates[0] ?? drawMove ?? moves[0];
    }
}
