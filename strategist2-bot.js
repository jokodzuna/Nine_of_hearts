// ============================================================
// strategist2-bot.js — Scoring-based heuristic bot (Strategist 2)
//
// Same strategy pillars as HeuristicBot but uses a candidate-
// nomination system instead of sequential early-returns:
//   - Every rule nominates a move with a numeric priority score.
//   - Higher score wins; multiple rules can compete for the same move.
//   - Narrow rules can safely override broad ones by nominating a
//     better alternative with a higher score — no fragile shadowing.
//
// Score tiers (rough guide):
//   10000  instant win
//    5000  9♥ opening / ace-trap
//    4000  opp 1-card press
//    3500  quad-K→A finishing sequence
//    2000  opp 2-4 card near-win pressure
//    1800  Ace-battle (Rule 4)
//    1600  King-battle (Rule 5)
//    2500  junk quad dump (Rule 3) — beats Rule 6a's opp-near-win press
//     550  dominant-hand single play (overrides quad-draw)
//     500  draw to complete quad (Rule 3.5)
//     400  stuck-9s draw (Rule 6b)
//     340  shallow-pile recovery draw (Rule 6-pre / 6b2)
//     300  K-escalation (Rule 6c)
//     350  ace-force: P0 has all Aces + quad ready, opp has no Aces (6-ace-force)
//   200-r  junk single — lowest rank first (Rule 6d/6e)
//     100  draw fallback
// ============================================================

import {
    getPossibleMoves,
    applyMove,
    isGameOver,
    DRAW_FLAG,
    RANK_MASK,
} from './game-logic.js';

function _popcount(x) {
    x = (x | 0);
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0F0F0F0F;
    return Math.imul(x, 0x01010101) >>> 24;
}

function _moveRankIdx(moveBits) {
    const lb = moveBits & (-moveBits);
    return (31 - Math.clz32(lb)) >> 2;
}

function _moveCount(moveBits) { return _popcount(moveBits); }

// ============================================================
// Strategist2Bot
// ============================================================

export class Strategist2Bot {
    constructor() {
        this._cardKnowledge = null;
        this._pileSeenMask  = 0;
        this._inSimulation  = false;  // true → skip endgame search (prevents recursion)
    }

    observeMove(state, move) {
        if (this._cardKnowledge === null) {
            this._cardKnowledge = new Int32Array(state.numPlayers);
        }
        const p = state.currentPlayer;
        if (move & DRAW_FLAG) {
            const count = (move & 3) + 1;
            for (let i = 0; i < count; i++) {
                this._cardKnowledge[p] |= (1 << state.pile[state.pileSize - 1 - i]);
            }
        } else {
            const played = (move & 0xFFFFFF) | 0;
            this._pileSeenMask         |= played;
            this._cardKnowledge[p]     &= ~played;
        }
    }

    advanceTree(_move) {}
    resetKnowledge() { this._cardKnowledge = null; this._pileSeenMask = 0; }
    cleanup() {}

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        if (moves.length === 1) return moves[0];

        // Endgame search: when either player has ≤3 cards, simulate forward
        // with Strategist2 scoring (full info) to find the best move.
        if (!this._inSimulation && state.numPlayers === 2) {
            const _myP  = state.currentPlayer;
            const _myC  = _popcount(state.hands[_myP]);
            const _oppC = _popcount(state.hands[1 - _myP]);
            if (_myC <= 3 || _oppC <= 3) return this._runEndgameSearch(state, moves);
        }

        // ---- State variables (same as HeuristicBot) ----
        const myP     = state.currentPlayer;
        const myHand  = state.hands[myP];
        const myTotal = _popcount(myHand);
        const topRI   = state.topRankIdx;

        const myAces  = _popcount(myHand & RANK_MASK[5]);
        const myKings = _popcount(myHand & RANK_MASK[4]);
        const my9s    = _popcount(myHand & RANK_MASK[0]);

        let stuckCount = 0;
        for (let r = 0; r < topRI; r++) stuckCount += _popcount(myHand & RANK_MASK[r]);

        const drawable  = state.pileSize - 1;
        const drawCount = Math.min(3, drawable);

        let drawRankMask = 0;
        for (let i = 0; i < drawCount; i++)
            drawRankMask |= (1 << (state.pile[state.pileSize - 1 - i] >> 2));
        const drawHasAce  = !!(drawRankMask & (1 << 5));
        const drawHasKing = !!(drawRankMask & (1 << 4));

        let acesInPile = 0, kingsInPile = 0;
        for (let i = 0; i < state.pileSize; i++) {
            const ri = state.pile[i] >> 2;
            if (ri === 5) acesInPile++;
            else if (ri === 4) kingsInPile++;
        }

        const opps = [];
        for (let p = 0; p < state.numPlayers; p++)
            if (p !== myP && !(state.eliminated & (1 << p))) opps.push(p);

        let oppEstAces = 0, oppEstKings = 0, oppMinCards = Infinity;
        for (const oppP of opps) {
            const oppTotal = _popcount(state.hands[oppP]);
            if (oppTotal < oppMinCards) oppMinCards = oppTotal;
            const acesElsewhere  = Math.max(0, 4 - myAces  - acesInPile);
            const kingsElsewhere = Math.max(0, 4 - myKings - kingsInPile);
            let ea = Math.min(acesElsewhere,  oppTotal);
            let ek = Math.min(kingsElsewhere, oppTotal);
            if (this._inSimulation) {
                // Full info in simulation — read exact opp hand
                ea = _popcount(state.hands[oppP] & RANK_MASK[5]);
                ek = _popcount(state.hands[oppP] & RANK_MASK[4]);
            } else if (this._cardKnowledge !== null) {
                ea = Math.max(ea, _popcount(this._cardKnowledge[oppP] & RANK_MASK[5]));
                ek = Math.max(ek, _popcount(this._cardKnowledge[oppP] & RANK_MASK[4]));
            }
            oppEstAces  += ea;
            oppEstKings += ek;
        }
        if (opps.length === 0) oppMinCards = 0;

        const safeAceMin = myTotal > 4 ? 2 : 1;

        const drawMove  = moves.find(m => !!(m & DRAW_FLAG)) ?? null;
        let   playMoves = moves.filter(m => !(m & DRAW_FLAG));

        const wouldWin = m => ((myHand & ~(m & 0xFFFFFF)) | 0) === 0;
        const playRI   = m => _moveRankIdx(m & 0xFFFFFF);
        const playCnt  = m => _moveCount(m & 0xFFFFFF);

        // ---- Nomination system ----
        const _scores = new Map();
        const nominate = (move, score) => {
            if (move == null) return;
            const prev = _scores.get(move) ?? -Infinity;
            if (score > prev) _scores.set(move, score);
        };

        // ==============================================================
        // RULE 0 — Instant win
        // ==============================================================
        for (const m of playMoves) {
            if (wouldWin(m)) nominate(m, 10000);
        }

        // ==============================================================
        // RULE 0.5 — Lone-Ace guard: shadow Ace out of playMoves
        // ==============================================================
        if (myAces === 1 && myTotal >= 5) {
            const nonAce = playMoves.filter(m => playRI(m) !== 5);
            if (nonAce.length > 0) playMoves = nonAce;
            else nominate(drawMove, 9000); // forced Ace → draw
        }

        // ==============================================================
        // RULE 1 — 9♥ strict opening
        // ==============================================================
        if (state.pile[state.pileSize - 1] === 1) {
            if (my9s === 3) {
                const t9 = playMoves.find(m => playCnt(m) === 3 && playRI(m) === 0);
                if (t9) { nominate(t9, 5100); }
            }
            let myLoRI = 5;
            for (let r = 0; r <= 5; r++) { if (myHand & RANK_MASK[r]) { myLoRI = r; break; } }

            if (oppMinCards <= 3 && opps.length > 0) {
                let oppLoRI = -1;
                for (let r = 0; r <= 5; r++) {
                    let pileCountR = 0;
                    for (let i = 0; i < state.pileSize; i++)
                        if ((state.pile[i] >> 2) === r) pileCountR++;
                    if (_popcount(myHand & RANK_MASK[r]) + pileCountR < 4) { oppLoRI = r; break; }
                }
                if (this._cardKnowledge !== null) {
                    for (const oppP of opps) {
                        const known = this._cardKnowledge[oppP];
                        for (let r = 0; r <= 5; r++) {
                            if (known & RANK_MASK[r]) { if (oppLoRI === -1 || r < oppLoRI) oppLoRI = r; break; }
                        }
                    }
                }
                if (oppLoRI !== -1 && oppLoRI <= myLoRI) {
                    for (let r = oppLoRI + 1; r <= 5; r++) {
                        if (_popcount(myHand & RANK_MASK[r]) === 4) {
                            const qm = playMoves.find(m => playCnt(m) === 4 && playRI(m) === r);
                            if (qm) { nominate(qm, 5050); break; }
                        }
                    }
                }
            }
            const loMoves = playMoves.filter(m => playRI(m) === myLoRI);
            const loMove  = loMoves.find(m => playCnt(m) === 4)
                         ?? loMoves.find(m => playCnt(m) === 1)
                         ?? loMoves[0] ?? playMoves[0];
            nominate(loMove, 5000);
        }

        // ==============================================================
        // RULE 2 — Triple 9s on any 9-top
        // ==============================================================
        if (topRI === 0 && my9s === 3) {
            const t9 = playMoves.find(m => playCnt(m) === 3 && playRI(m) === 0);
            if (t9) nominate(t9, 4800);
        }

        // ==============================================================
        // RULE 2.5 — Pile-trap Ace escalation
        // ==============================================================
        const _quadReady = playMoves.some(m => playCnt(m) === 4 && playRI(m) <= 4);
        if (!_quadReady && topRI <= 3 && state.pileSize >= 2 && myAces >= safeAceMin
                && oppEstAces > 0 && oppMinCards <= 5) {
            const subRI2trap = state.pile[state.pileSize - 2] >> 2;
            if (topRI <= 1 || subRI2trap <= 1) {
                const aceTrap = playMoves.find(m => playRI(m) === 5);
                if (aceTrap) nominate(aceTrap, 4500);
            }
        }

        // ==============================================================
        // RULE 3b — Quad K → Quad A finishing sequence
        // ==============================================================
        if (myAces >= 4 && oppEstAces === 0 && myTotal === myKings + myAces) {
            const quadK = playMoves.find(m => playCnt(m) === 4 && playRI(m) === 4);
            if (quadK) nominate(quadK, 3500);
        }

        // ==============================================================
        // RULE 3 — 4-of-a-kind junk quad dump (rank 9–Q)
        // ==============================================================
        {
            const oppNonPowerEst  = oppMinCards - oppEstKings - oppEstAces;
            const riskFinishingHand = oppMinCards <= 6 && oppNonPowerEst <= 1;

            for (const m of playMoves) {
                if (playCnt(m) !== 4 || playRI(m) > 3) continue;
                if (!(myAces >= safeAceMin || myTotal > oppMinCards + 3)) continue;
                const r = playRI(m);
                if (oppMinCards <= 1) continue;
                if (oppMinCards <= 4) {
                    let dangerous = false;
                    for (let hr = r + 1; hr <= 5 && !dangerous; hr++) {
                        const mine = _popcount(myHand & RANK_MASK[hr]);
                        let inP = 0;
                        for (let i = 0; i < state.pileSize; i++) if ((state.pile[i] >> 2) === hr) inP++;
                        if (4 - mine - inP >= oppMinCards) dangerous = true;
                    }
                    if (dangerous) continue;
                }
                if (r === 3 && oppEstKings > 0 && oppMinCards <= 3) continue;
                const hasLowerSingle = !riskFinishingHand && (oppMinCards > 4) && playMoves.some(
                    pm => playCnt(pm) === 1 && playRI(pm) < r && playRI(pm) <= 3 && playRI(pm) <= topRI
                );
                // Elevate only when opp has 2 cards with an Ace: playing single
                // lets opp A-counter then finish with their low card after we draw.
                const aceFinishThreat = oppMinCards === 2 && oppEstAces > 0;
                const score = aceFinishThreat ? 2500 + r : (riskFinishingHand ? 900 + r : 900);
                if (!hasLowerSingle) nominate(m, score);
            }
        }

        // ==============================================================
        // RULE 3.5 — Draw to complete a junk quad (rank 9–Q)
        // ==============================================================
        if (drawMove !== null && myAces >= safeAceMin && stuckCount > 0 && oppMinCards > 3) {
            for (let r = 0; r <= 3; r++) {
                const inHand = _popcount(myHand & RANK_MASK[r]);
                if (inHand === 0 || inHand >= 3) continue;
                let inDraw = 0;
                for (let i = 0; i < drawCount; i++) {
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === r) inDraw++;
                }
                if (inHand + inDraw >= 4) {
                    nominate(drawMove, 500);
                }
            }
        }

        // ==============================================================
        // RULE 4 — Top card is A: Ace battle
        // ==============================================================
        if (topRI === 5) {
            if (drawMove !== null && drawHasKing && myTotal >= 5 && oppMinCards > 2
                    && (oppEstKings > 0 || oppEstAces > 0))
                nominate(drawMove, 1820);

            if (drawMove !== null && oppEstAces === 0 && myAces >= safeAceMin
                    && myTotal >= 2 && stuckCount > 0)
                nominate(drawMove, 1810);

            const aceMoves = playMoves.filter(m => playRI(m) === 5);
            if (aceMoves.length > 0) {
                const acesAfter = myAces - 1;
                const safeToPlay = (acesAfter >= safeAceMin && myAces > oppEstAces + 1)
                                || (myTotal <= 4 && acesAfter >= safeAceMin && oppEstAces > 0);
                if (safeToPlay) nominate(aceMoves[0], 1800);
            }
            nominate(drawMove, 1700);
        }

        // ==============================================================
        // RULE 5 — Top card is K: escalation decision
        // ==============================================================
        if (topRI === 4) {
            const aceMoves  = playMoves.filter(m => playRI(m) === 5);
            const kingMoves = playMoves.filter(m => playRI(m) === 4);
            const subRI2 = state.pileSize >= 2 ? state.pile[state.pileSize - 2] >> 2 : -1;
            const subRI3 = state.pileSize >= 3 ? state.pile[state.pileSize - 3] >> 2 : -1;
            const lowJunk = _popcount(myHand & (RANK_MASK[0] | RANK_MASK[1]));

            if (drawMove !== null && subRI2 === 4 && oppMinCards >= 3 && myTotal > 4
                    && lowJunk > 0 && (oppEstKings > 0 || oppEstAces > 0))
                nominate(drawMove, 1650);

            if (drawMove !== null && drawHasAce && myAces < safeAceMin)
                nominate(drawMove, 1640);

            if (drawMove !== null && state.pileSize <= 2 && subRI2 <= 1
                    && oppMinCards > 2 && myTotal >= 5)
                nominate(drawMove, 1630);

            if (drawMove !== null && oppMinCards === 2 && state.pileSize >= 5
                    && myTotal >= 8 && oppEstKings > 0)
                nominate(drawMove, 1620);

            if (kingMoves.length > 0 && (myKings >= 2 || myAces >= safeAceMin) && myTotal > 4) {
                if (state.pileSize >= 10 && (subRI2 === 4 || subRI3 === 4) && drawMove !== null
                        && oppEstKings > 0 && oppEstAces > 0) {
                    nominate(drawMove, 1610);
                } else {
                    nominate(kingMoves[0], 1600);
                }
            }

            if (aceMoves.length > 0) {
                const acesAfter = myAces - 1;
                const dominant  = oppEstAces === 0 && acesAfter >= safeAceMin;
                const advantage = acesAfter >= safeAceMin && myAces > oppEstAces + 1;
                const lateGame  = myTotal <= 4 && acesAfter >= safeAceMin;
                if (lateGame || ((dominant || advantage) && subRI2 < 4))
                    nominate(aceMoves[0], 1580);
            }

            if (kingMoves.length > 0) nominate(kingMoves[0], 1560);
            nominate(drawMove, 1540);
        }

        // ==============================================================
        // RULE 6 — Top ≤ Q: junk-dump phase
        // NOTE: only runs when topRI <= 3. Rules 4 (A-top) and 5 (K-top)
        // nominate at 1540–1820 and fully cover those situations; gating
        // Rule 6 here mirrors HeuristicBot's sequential early-return flow.
        // ==============================================================
        if (topRI <= 3) {
            let safePlays = [...playMoves];
            if (myAces === 1 && myTotal > 2) {
                const filtered = safePlays.filter(m => playRI(m) !== 5);
                if (filtered.length > 0) safePlays = filtered;
            }

            // 6-pre: shallow-pile Q recovery
            if (drawMove !== null && topRI === 3 && state.pileSize <= 2
                    && oppMinCards > 2 && myTotal >= 5)
                nominate(drawMove, 340);

            // 6a: opponent near win
            if (oppMinCards <= 4 && safePlays.length > 0) {
                if (oppMinCards === 1) {
                    const minSafeRI = oppEstAces > 0 ? 6 : oppEstKings > 0 ? 5 : 4;
                    const safe1 = safePlays.filter(m => playRI(m) >= minSafeRI)
                                           .sort((a, b) => playRI(a) - playRI(b));
                    if (safe1.length > 0) nominate(safe1[0], 4000);
                    else nominate(drawMove, 3900);
                } else {
                    const sorted = [...safePlays].sort((a, b) => playRI(b) - playRI(a));
                    const highest = sorted[0];
                    const hRI     = playRI(highest);
                    if (hRI >= 4 && myAces >= safeAceMin && (oppEstKings > 0 || oppEstAces > 0 || oppMinCards <= 2)) {
                        if (oppEstAces === 0 && oppEstKings > 0) {
                            if (myKings > oppEstKings) {
                                const kMove = safePlays.find(m => playRI(m) === 4);
                                if (kMove) nominate(kMove, 2000);
                            }
                            nominate(highest, 2000);
                        } else {
                            const kMove = safePlays.find(m => playRI(m) === 4);
                            if (kMove) nominate(kMove, 2000);
                            else nominate(highest, 2000);
                        }
                    } else if (hRI < 4) {
                        nominate(highest, 2000);
                    } else {
                        const nonK = sorted.find(m => playRI(m) < 4);
                        if (nonK) nominate(nonK, 2000);
                    }
                }
            }

            // 6b: draw to unblock stuck 9s on 10-top
            if (drawMove !== null && my9s >= 1 && topRI === 1
                    && myAces >= safeAceMin && myKings >= 1)
                nominate(drawMove, 400);

            // 6b2: deeply stuck AND pile has power
            if (drawMove !== null && stuckCount >= Math.ceil(myTotal / 2) && (drawHasAce || drawHasKing))
                nominate(drawMove, 340);

            // 6c: K escalation
            if (myKings >= 1 && myAces >= safeAceMin && topRI >= 2 && (oppEstAces > 0 || stuckCount > 0)) {
                const kingMoves = safePlays.filter(m => playRI(m) === 4);
                const aceAdvantage = myAces > oppEstAces + 1 && stuckCount > 0;
                if (kingMoves.length > 0 && (oppEstAces > 0 || aceAdvantage))
                    nominate(kingMoves[0], 300);
            }

            // 6-ace-force: P0 holds all Aces (opp has none) AND has a quad to dump
            // at the resulting 9♥-top — play Ace to force P1 to draw, then clear quad.
            // After P1 draws the Ace, oppEstAces increments naturally, preventing re-fire.
            if (oppEstAces === 0 && myAces >= safeAceMin && topRI >= 2) {
                const hasQuadFollowUp = [0,1,2,3].some(r => _popcount(myHand & RANK_MASK[r]) === 4);
                if (hasQuadFollowUp) {
                    const afMoves = safePlays.filter(m => playRI(m) === 5);
                    if (afMoves.length > 0) nominate(afMoves[0], 350);
                }
            }

            // 6d/6e: junk singles — lowest rank first; singles preferred when hand large
            {
                let candidates = safePlays;
                if (myTotal > 4) {
                    const singles = safePlays.filter(m => playCnt(m) === 1);
                    if (singles.length > 0) candidates = singles;
                }
                candidates.sort((a, b) => playRI(a) - playRI(b));
                candidates.forEach((m, i) => nominate(m, 200 - playRI(m) - i * 0.01));
            }
        }

        // Absolute fallback draw (all topRI)
        nominate(drawMove, 100);

        // ---- Pick best nominated move ----
        let bestMove = null, bestScore = -Infinity;
        for (const [m, s] of _scores) {
            if (s > bestScore) { bestScore = s; bestMove = m; }
        }
        return bestMove ?? moves[0];
    }

    // ============================================================
    // Endgame search — triggered when myCards ≤ 3 or oppCards ≤ 3
    // ============================================================

    // Try each candidate move, simulate the rest of the game with Strategist2
    // scoring (full info, no recursive endgame search), and pick the best outcome.
    _runEndgameSearch(state, moves) {
        const myP    = state.currentPlayer;
        const simBot = new Strategist2Bot();
        simBot._inSimulation = true;
        let bestMove = moves[0], bestOutcome = -Infinity;
        for (const move of moves) {
            const s1 = applyMove(state, move);
            let outcome;
            if (isGameOver(s1)) {
                outcome = (s1.eliminated & (1 << myP)) ? 10 : -10;
            } else {
                outcome = this._simulateWith(s1, myP, simBot, 20);
            }
            if (outcome > bestOutcome) { bestOutcome = outcome; bestMove = move; }
        }
        return bestMove;
    }

    // Simulate up to `depth` plies from `state` using `simBot`'s Strategist2
    // scoring. Returns 10 (myP wins), -10 (myP loses), 0 (depth exceeded).
    _simulateWith(state, myP, simBot, depth) {
        let cur = state;
        for (let d = 0; d < depth; d++) {
            if (isGameOver(cur)) break;
            cur = applyMove(cur, simBot.chooseMove(cur));
        }
        if (isGameOver(cur)) return (cur.eliminated & (1 << myP)) ? 10 : -10;
        return 0;
    }
}
