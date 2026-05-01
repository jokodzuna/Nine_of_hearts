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
        let drawRankMask = 0;
        for (let i = 0; i < drawCount; i++) {
            drawRankMask |= (1 << (state.pile[state.pileSize - 1 - i] >> 2));
        }
        const drawHasAce  = !!(drawRankMask & (1 << 5));
        const drawHasKing = !!(drawRankMask & (1 << 4));

        // Count Aces/Kings in pile (for opponent estimation)
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

            const acesElsewhere  = Math.max(0, 4 - myAces  - acesInPile);
            const kingsElsewhere = Math.max(0, 4 - myKings - kingsInPile);

            let ea = Math.min(acesElsewhere,  oppTotal);
            let ek = Math.min(kingsElsewhere, oppTotal);

            if (this._cardKnowledge !== null) {
                ea = Math.max(ea, _popcount(this._cardKnowledge[oppP] & RANK_MASK[5]));
                ek = Math.max(ek, _popcount(this._cardKnowledge[oppP] & RANK_MASK[4]));
            }

            oppEstAces  += ea;
            oppEstKings += ek;
        }
        if (opps.length === 0) oppMinCards = 0;

        // ---- Safety thresholds ----
        // Need ≥2 Aces in early/mid game (hand > 4 cards), ≥1 in late game
        const safeAceMin = myTotal > 4 ? 2 : 1;

        // ---- Separate moves ----
        const drawMove  = moves.find(m => !!(m & DRAW_FLAG)) ?? null;
        const playMoves = moves.filter(m => !(m & DRAW_FLAG));

        const wouldWin  = m => ((myHand & ~(m & 0xFFFFFF)) | 0) === 0;
        const playRI    = m => _moveRankIdx(m & 0xFFFFFF);
        const playCnt   = m => _moveCount(m & 0xFFFFFF);

        // ==============================================================
        // RULE 0 — Instant win: emptying hand this turn
        // ==============================================================
        for (const m of playMoves) {
            if (wouldWin(m)) return m;
        }

        // ==============================================================
        // RULE 1 — 9♥ strict opening
        // When the 9♥ is the top card (pileSize === 1, bit index 1 = rank-0 suit-♥),
        // always play the lowest card. Only exception: opp has ≤3 cards and their
        // lowest reachable rank ≤ ours — then play the lowest quad above their lowest
        // to block them from responding with a cheap card.
        // 9♥ bit index = rank(0)*4 + suit(♥=1) = 1
        // ==============================================================
        if (state.pile[state.pileSize - 1] === 1) {
            // Triple 9s still take priority (massive junk dump)
            if (my9s === 3) {
                const t9 = playMoves.find(m => playCnt(m) === 3 && playRI(m) === 0);
                if (t9) return t9;
            }

            // Find our lowest rank in hand
            let myLoRI = 5;
            for (let r = 0; r <= 5; r++) {
                if (myHand & RANK_MASK[r]) { myLoRI = r; break; }
            }

            // Exception: opp has ≤3 cards — try to block their lowest card with a quad
            if (oppMinCards <= 3 && opps.length > 0) {
                // Estimate opp's lowest reachable rank by deduction:
                // first rank where we don't hold all 4 + pile doesn't cover the rest
                let oppLoRI = -1;
                for (let r = 0; r <= 5; r++) {
                    let pileCountR = 0;
                    for (let i = 0; i < state.pileSize; i++) {
                        if ((state.pile[i] >> 2) === r) pileCountR++;
                    }
                    if (_popcount(myHand & RANK_MASK[r]) + pileCountR < 4) {
                        oppLoRI = r; break;
                    }
                }
                // Card-tracking can confirm even lower cards
                if (this._cardKnowledge !== null) {
                    for (const oppP of opps) {
                        const known = this._cardKnowledge[oppP];
                        for (let r = 0; r <= 5; r++) {
                            if (known & RANK_MASK[r]) {
                                if (oppLoRI === -1 || r < oppLoRI) oppLoRI = r;
                                break;
                            }
                        }
                    }
                }
                // If opp's lowest ≤ our lowest, block with the lowest quad above opp's lowest
                if (oppLoRI !== -1 && oppLoRI <= myLoRI) {
                    for (let r = oppLoRI + 1; r <= 5; r++) {
                        if (_popcount(myHand & RANK_MASK[r]) === 4) {
                            const qm = playMoves.find(m => playCnt(m) === 4 && playRI(m) === r);
                            if (qm) return qm;
                        }
                    }
                }
            }

            // Default: quad of lowest rank (if we hold all 4), otherwise single lowest
            const loMoves = playMoves.filter(m => playRI(m) === myLoRI);
            return loMoves.find(m => playCnt(m) === 4)
                ?? loMoves.find(m => playCnt(m) === 1)
                ?? loMoves[0]
                ?? playMoves[0];
        }

        // ==============================================================
        // RULE 2 — Triple 9s on any 9 top
        // ==============================================================
        if (topRI === 0 && my9s === 3) {
            const t9 = playMoves.find(m => playCnt(m) === 3 && playRI(m) === 0);
            if (t9) return t9;
        }

        // ==============================================================
        // RULE 3 — 4-of-a-kind junk dump (rank 9–Q only, Ace reserve safe)
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
                // Only escalate with a strict buffer: must stay at safeAceMin AND have clear advantage
                const safeToPlay = (acesAfter >= safeAceMin && oppEstAces === 0)      // dominate: opp has none
                                || (acesAfter >= safeAceMin && myAces > oppEstAces + 1); // 2+ Ace lead
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

            // 5a. Escalate with A: only when we clearly dominate AND keep our buffer
            // Also: check that pile below current K-top isn't power (opp's 3-card draw = myA + K + pile[n-2])
            if (aceMoves.length > 0) {
                const acesAfter    = myAces - 1;
                const dominant     = oppEstAces === 0 && acesAfter >= safeAceMin;
                const advantage    = acesAfter >= safeAceMin && myAces > oppEstAces + 1;
                const subTopRI     = state.pileSize >= 2 ? state.pile[state.pileSize - 2] >> 2 : -1;
                const pileGivesOppPower = subTopRI >= 4; // K or A is 3rd draw card opp would pick up
                if ((dominant || advantage) && !pileGivesOppPower) return aceMoves[0];
            }

            // 5b. Draw if pile has power cards we're deficient in
            if (drawMove !== null) {
                if (drawHasAce  && myAces < safeAceMin)               return drawMove; // rescue Ace
                if (drawHasKing && myKings <= 1 && !aceMoves.length)  return drawMove; // get backup K
            }

            // 5c. Match K if reserve allows
            if (kingMoves.length > 0 && (myKings >= 2 || myAces >= safeAceMin)) {
                return kingMoves[0];
            }

            // 5d. Draw: preserve last K and Aces
            return drawMove ?? playMoves[playMoves.length - 1];
        }

        // ==============================================================
        // RULE 6 — Top ≤ Q: junk-dump phase
        // ==============================================================

        // Lone-Ace guard: never sacrifice last Ace (unless it wins the game)
        let safePlays = [...playMoves];
        if (myAces === 1 && myTotal > 2) {
            const filtered = safePlays.filter(m => playRI(m) !== 5);
            if (filtered.length > 0) safePlays = filtered;
        }

        // 6a. Opponent near win — maximum pressure
        if (oppMinCards <= 4 && safePlays.length > 0) {
            const sorted = [...safePlays].sort((a, b) => playRI(b) - playRI(a));
            const highest = sorted[0];
            const hRI     = playRI(highest);
            if (hRI === 4 && myAces >= safeAceMin) return highest;   // K escalation, Ace-safe
            if (hRI < 4) return highest;                               // J/Q/10: always press
            // King but Ace-deficient: play next best
            const nonK = sorted.find(m => playRI(m) < 4);
            if (nonK) return nonK;
        }

        // 6b. Deeply stuck AND pile has power cards → draw
        if (drawMove !== null && stuckCount >= Math.ceil(myTotal / 2) && (drawHasAce || drawHasKing)) {
            return drawMove;
        }

        // 6c. K escalation: press with King on J+ tops when opp has no Aces
        // Requires topRI >= 2 (don't escalate from 9 or 10 — premature and wastes K)
        // Requires myAces >= 1 as backup (if opp has 0 Aces they can't escalate further)
        if (myKings >= 1 && myAces >= 1 && oppEstAces === 0 && topRI >= 2) {
            const kingMoves = safePlays.filter(m => playRI(m) === 4);
            if (kingMoves.length > 0) return kingMoves[0];
        }

        // 6d. Prefer singles when hand is large (preserve combo potential)
        let candidates = safePlays;
        if (myTotal > 4) {
            const singles = safePlays.filter(m => playCnt(m) === 1);
            if (singles.length > 0) candidates = singles;
        }

        // 6e. Dump lowest rank first (9s before 10s before Js …)
        candidates.sort((a, b) => playRI(a) - playRI(b));
        return candidates[0] ?? drawMove ?? moves[0];
    }
}
