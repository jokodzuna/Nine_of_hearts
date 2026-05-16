// ============================================================
// sentient-bot.js — Heuristic bot for the "sentient" difficulty
//
// 3-4P active stage: nomination-based dump / build heuristic
//   Dump mode:  play lowest rank singles to clear hand fast
//   Build mode: draw for K/A when stuck or power-starved
//   Always:     quad-dump 9-Q, 9♥ rules, anti-human pressure
//
// 2P active stage (detected by live active-player count, NOT
//   state.numPlayers — works correctly inside 4P games):
//   Full forward-simulation endgame search (depth 24) when
//   either player has ≤3 cards; heuristic otherwise
//
// Score tiers (nomination system):
//   10000  instant win
//    9000  forced draw (lone Ace, no other play)
//    5100  9♥ triple-9 dump
//    5000  9♥ opening: play lowest rank
//    4800  triple 9s on any 9-top
//    4500  anti-human press (K/A directly before human ≤3 cards)
//    4000  opp 1-card panic: safe play or draw
//    3900  opp 1-card panic: forced draw
//    3500  4-of-a-kind junk dump (9-Q)
//    3000  build-mode draw for K/A (stuck or power-starved)
//    2500  pile-trap Ace escalation
//    2000  opp ≤4 press with high card
//     500  draw for K/A when low power count
//     400  stuck-9s draw on 10-top
//     340  shallow-pile Q recovery draw
//   200-r  junk single (lowest rank first)
//     100  fallback draw
// ============================================================

import {
    getPossibleMoves,
    applyMove,
    isGameOver,
    DRAW_FLAG,
    RANK_MASK,
} from './game-logic.js';

function _pc(x) {
    x = (x | 0);
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0F0F0F0F;
    return Math.imul(x, 0x01010101) >>> 24;
}

function _moveRI(moveBits) {
    const lb = moveBits & (-moveBits);
    return (31 - Math.clz32(lb)) >> 2;
}

function _activeCount(state) {
    return state.numPlayers - _pc(state.eliminated);
}

function _findOtherActive(state, myP) {
    for (let p = 0; p < state.numPlayers; p++) {
        if (p !== myP && !(state.eliminated & (1 << p))) return p;
    }
    return -1;
}

// ============================================================
// SentientBot
// ============================================================

export class SentientBot {
    constructor() {
        this._cardKnowledge = null;
        this._pileSeenMask  = 0;
        this._inSimulation  = false;
    }

    observeMove(state, move) {
        if (this._cardKnowledge === null)
            this._cardKnowledge = new Int32Array(state.numPlayers);
        const p = state.currentPlayer;
        if (move & DRAW_FLAG) {
            const count = (move & 3) + 1;
            for (let i = 0; i < count; i++)
                this._cardKnowledge[p] |= (1 << state.pile[state.pileSize - 1 - i]);
        } else {
            const played = (move & 0xFFFFFF) | 0;
            this._pileSeenMask     |= played;
            this._cardKnowledge[p] &= ~played;
        }
    }

    advanceTree(_move) {}
    resetKnowledge() { this._cardKnowledge = null; this._pileSeenMask = 0; }
    cleanup() {}

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        if (moves.length === 1) return moves[0];

        if (_activeCount(state) === 2 && !this._inSimulation) {
            const myP  = state.currentPlayer;
            const oppP = _findOtherActive(state, myP);
            if (oppP !== -1) {
                const myC  = _pc(state.hands[myP]);
                const oppC = _pc(state.hands[oppP]);
                if (myC <= 3 || oppC <= 3) {
                    const eg = this._endgameSearch(state, moves, myP);
                    if (eg !== null) return eg;
                }
            }
        }

        return this._heuristic(state, moves);
    }

    // ============================================================
    // Heuristic — 3-4P dump / build mode
    // ============================================================
    _heuristic(state, moves) {
        const myP    = state.currentPlayer;
        const myHand = state.hands[myP];
        const topRI  = state.topRankIdx;

        const myTotal = _pc(myHand);
        const myAces  = _pc(myHand & RANK_MASK[5]);
        const myKings = _pc(myHand & RANK_MASK[4]);
        const my9s    = _pc(myHand & RANK_MASK[0]);

        let stuckCount = 0;
        for (let r = 0; r < topRI; r++) stuckCount += _pc(myHand & RANK_MASK[r]);

        const drawMove  = moves.find(m => !!(m & DRAW_FLAG)) ?? null;
        let   playMoves = moves.filter(m => !(m & DRAW_FLAG));

        const playRI   = m => _moveRI(m & 0xFFFFFF);
        const playCnt  = m => _pc(m & 0xFFFFFF);
        const wouldWin = m => ((myHand & ~(m & 0xFFFFFF)) | 0) === 0;

        // ---- Opponent aggregates ----
        const opps = [];
        for (let p = 0; p < state.numPlayers; p++)
            if (p !== myP && !(state.eliminated & (1 << p))) opps.push(p);

        let acesInPile = 0, kingsInPile = 0;
        for (let i = 0; i < state.pileSize; i++) {
            const ri = state.pile[i] >> 2;
            if (ri === 5) acesInPile++;
            else if (ri === 4) kingsInPile++;
        }

        let oppEstAces = 0, oppEstKings = 0, oppMinCards = Infinity;
        for (const oppP of opps) {
            const oppTotal = _pc(state.hands[oppP]);
            if (oppTotal < oppMinCards) oppMinCards = oppTotal;
            const acesElsewhere  = Math.max(0, 4 - myAces  - acesInPile);
            const kingsElsewhere = Math.max(0, 4 - myKings - kingsInPile);
            let ea = Math.min(acesElsewhere,  oppTotal);
            let ek = Math.min(kingsElsewhere, oppTotal);
            if (this._inSimulation) {
                ea = _pc(state.hands[oppP] & RANK_MASK[5]);
                ek = _pc(state.hands[oppP] & RANK_MASK[4]);
            } else if (this._cardKnowledge !== null) {
                ea = Math.max(ea, _pc(this._cardKnowledge[oppP] & RANK_MASK[5]));
                ek = Math.max(ek, _pc(this._cardKnowledge[oppP] & RANK_MASK[4]));
            }
            oppEstAces  += ea;
            oppEstKings += ek;
        }

        const safeAceMin  = myTotal > 4 ? 2 : 1;
        const humanCards  = (myP !== 0 && !(state.eliminated & 1))
            ? _pc(state.hands[0]) : Infinity;

        // Drawable pile analysis
        const drawCount = Math.min(3, state.pileSize - 1);
        let drawHasAce = false, drawHasKing = false;
        for (let i = 0; i < drawCount; i++) {
            const ri = state.pile[state.pileSize - 1 - i] >> 2;
            if (ri === 5) drawHasAce  = true;
            if (ri === 4) drawHasKing = true;
        }
        const drawHasKA = drawHasAce || drawHasKing;

        // ---- Nomination ----
        const _scores = new Map();
        const nom = (move, score) => {
            if (move == null) return;
            const prev = _scores.get(move) ?? -Infinity;
            if (score > prev) _scores.set(move, score);
        };

        // Lone-Ace guard
        if (myAces === 1 && myTotal >= 5) {
            const nonAce = playMoves.filter(m => playRI(m) !== 5);
            if (nonAce.length > 0) playMoves = nonAce;
            else nom(drawMove, 9000);
        }

        // Instant win
        for (const m of playMoves) { if (wouldWin(m)) nom(m, 10000); }

        // 9♥ opening
        if (state.pile[state.pileSize - 1] === 1) {
            if (my9s === 3) {
                const t9 = playMoves.find(m => playCnt(m) === 3 && playRI(m) === 0);
                if (t9) nom(t9, 5100);
            }
            const sorted = [...playMoves].sort((a, b) => playRI(a) - playRI(b));
            if (sorted.length > 0) nom(sorted[0], 5000);
        }

        // Triple 9s on any 9-top
        if (topRI === 0 && my9s === 3) {
            const t9 = playMoves.find(m => playCnt(m) === 3 && playRI(m) === 0);
            if (t9) nom(t9, 4800);
        }

        // Anti-human press: bot directly before human plays K/A when human ≤3 cards
        if (humanCards <= 3) {
            let next = (myP + 1) % state.numPlayers;
            while ((state.eliminated & (1 << next)) && next !== myP)
                next = (next + 1) % state.numPlayers;
            if (next === 0) {
                const high = [...playMoves].sort((a, b) => playRI(b) - playRI(a));
                if (high.length > 0 && playRI(high[0]) >= 4) nom(high[0], 4500);
            }
        }

        // Opp 1-card panic
        if (oppMinCards <= 1 && playMoves.length > 0) {
            const minSafeRI = oppEstAces > 0 ? 6 : oppEstKings > 0 ? 5 : 4;
            const safe1 = playMoves.filter(m => playRI(m) >= minSafeRI)
                                   .sort((a, b) => playRI(a) - playRI(b));
            if (safe1.length > 0) nom(safe1[0], 4000);
            else nom(drawMove, 3900);
        }

        // 4-of-a-kind junk dump (9-Q)
        for (const m of playMoves) {
            if (playCnt(m) !== 4 || playRI(m) > 3) continue;
            if (!(myAces >= safeAceMin || myTotal > (oppMinCards === Infinity ? 0 : oppMinCards) + 3)) continue;
            if (oppMinCards <= 1) continue;
            if (oppMinCards <= 4) {
                let dangerous = false;
                for (let hr = playRI(m) + 1; hr <= 5 && !dangerous; hr++) {
                    const mine = _pc(myHand & RANK_MASK[hr]);
                    let inP = 0;
                    for (let i = 0; i < state.pileSize; i++)
                        if ((state.pile[i] >> 2) === hr) inP++;
                    if (4 - mine - inP >= oppMinCards) dangerous = true;
                }
                if (dangerous) continue;
            }
            nom(m, 3500 - playRI(m));
        }

        // Build mode: draw for K/A when stuck or power-starved for the 2P stage
        const isStuck     = stuckCount >= Math.ceil(myTotal * 0.5) && myTotal > 5;
        const powerStarved = (myKings + myAces < 2) && myTotal >= 6 && _activeCount(state) >= 3;
        if ((isStuck || powerStarved) && drawHasKA && drawMove !== null && myTotal < 12)
            nom(drawMove, 3000);

        // Pile-trap Ace escalation: play Ace to force draw when opp has Aces + quad ready
        const quadReady = playMoves.some(m => playCnt(m) === 4 && playRI(m) <= 4);
        if (!quadReady && topRI <= 3 && state.pileSize >= 2
                && myAces >= safeAceMin && oppEstAces > 0 && oppMinCards <= 5) {
            const subRI2 = state.pile[state.pileSize - 2] >> 2;
            if (topRI <= 1 || subRI2 <= 1) {
                const aceTrap = playMoves.find(m => playRI(m) === 5);
                if (aceTrap) nom(aceTrap, 2500);
            }
        }

        // Opp ≤4 press: play highest available card to maintain pressure
        if (oppMinCards <= 4 && oppMinCards !== Infinity && playMoves.length > 0) {
            const sorted = [...playMoves].sort((a, b) => playRI(b) - playRI(a));
            if (playRI(sorted[0]) >= 3 && myAces >= safeAceMin) nom(sorted[0], 2000);
        }

        // Draw for K/A when pile has power and we're short on power cards
        if (drawHasKA && drawMove !== null && myKings + myAces < 3 && myTotal < 10)
            nom(drawMove, 500);

        // Stuck 9s: draw on 10-top to unblock 9s
        if (drawMove !== null && my9s >= 1 && topRI === 1 && myAces >= safeAceMin && myKings >= 1)
            nom(drawMove, 400);

        // Shallow-pile Q recovery draw
        if (drawMove !== null && topRI === 3 && state.pileSize <= 2
                && (oppMinCards === Infinity || oppMinCards > 2) && myTotal >= 5)
            nom(drawMove, 340);

        // Junk singles: lowest rank first — primary dump mechanism
        {
            let candidates = playMoves;
            if (myTotal > 4) {
                const singles = playMoves.filter(m => playCnt(m) === 1);
                if (singles.length > 0) candidates = singles;
            }
            [...candidates].sort((a, b) => playRI(a) - playRI(b))
                           .forEach((m, i) => nom(m, 200 - playRI(m) - i * 0.01));
        }

        // Fallback draw
        nom(drawMove, 100);

        let bestMove = null, bestScore = -Infinity;
        for (const [m, s] of _scores) {
            if (s > bestScore) { bestScore = s; bestMove = m; }
        }
        return bestMove ?? moves[0];
    }

    // ============================================================
    // 2P endgame search — correct for any starting player count
    // ============================================================

    _endgameSearch(state, moves, myP) {
        const simBot = new SentientBot();
        simBot._inSimulation = true;
        let bestMove = moves[0], bestOutcome = -Infinity;
        for (const move of moves) {
            const s1 = applyMove(state, move);
            let outcome;
            if (isGameOver(s1)) {
                outcome = (s1.eliminated & (1 << myP)) ? 10 : -10;
            } else {
                outcome = this._simWith(s1, myP, simBot, 24);
            }
            if (outcome > bestOutcome) { bestOutcome = outcome; bestMove = move; }
        }
        if ((bestMove & DRAW_FLAG) && bestOutcome === 0) return null;
        if (bestOutcome === 0 && _pc(state.hands[myP]) > 3) return null;
        return bestOutcome > -10 ? bestMove : null;
    }

    _simWith(state, myP, simBot, depth) {
        let cur = state;
        for (let d = 0; d < depth; d++) {
            if (isGameOver(cur)) break;
            cur = applyMove(cur, simBot.chooseMove(cur));
        }
        if (isGameOver(cur)) return (cur.eliminated & (1 << myP)) ? 10 : -10;
        return 0;
    }
}
