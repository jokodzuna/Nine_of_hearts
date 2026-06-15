// ============================================================
// strategist2-botfather.js — Botfather variant of Strategist2Bot
//
// Copy of strategist2-bot.js. Modify this file to tune the
// Botfather difficulty without affecting other modes.
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

// Effective hand size for endgame trigger: a playable quad (rank >= topRI)
// counts as 1 card since it resolves in a single move.
function _effectiveCards(hand, topRI) {
    let eff = 0;
    for (let r = 0; r < 6; r++) {
        const n = _popcount(hand & RANK_MASK[r]);
        if (n === 4 && r >= topRI) eff += 1;
        else eff += n;
    }
    return eff;
}

// ============================================================
// BotfatherBot
// ============================================================

export class BotfatherBot {
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

        // Pre-endgame override: if K is the top and drawing completes a 4K quad, do it
        // unconditionally — stronger than any endgame sim or single-card play.
        if (!this._inSimulation && state.topRankIdx === 4) {
            const _myP2 = state.currentPlayer;
            const _myK2 = _popcount(state.hands[_myP2] & RANK_MASK[4]);
            if (_myK2 >= 1) {
                const _dc2 = Math.min(3, state.pileSize - 1);
                let _dk2 = 0;
                for (let i = 0; i < _dc2; i++)
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === 4) _dk2++;
                if (_myK2 + _dk2 >= 4) {
                    const _tot2 = _popcount(state.hands[_myP2]);
                    const _ace2 = _popcount(state.hands[_myP2] & RANK_MASK[5]);
                    const _sam2 = _tot2 > 4 ? 2 : 1;
                    let _omc2 = Infinity;
                    for (let p = 0; p < state.numPlayers; p++)
                        if (p !== _myP2 && !(state.eliminated & (1 << p)))
                            _omc2 = Math.min(_omc2, _popcount(state.hands[p]));
                    let _stuck2 = 0;
                    for (let _r2 = 0; _r2 < state.topRankIdx; _r2++)
                        _stuck2 += _popcount(state.hands[_myP2] & RANK_MASK[_r2]);
                    if (_ace2 >= _sam2 && _ace2 < 4 && _myK2 <= 2 && _omc2 > 2 && _stuck2 > 0) {
                        const dm2 = moves.find(m => !!(m & DRAW_FLAG));
                        if (dm2) return dm2;
                    }
                }
            }
        }

        // Pre-endgame override for A-top: drawing completes 4A (maximum pile control).
        if (!this._inSimulation && state.topRankIdx === 5) {
            const _myP3 = state.currentPlayer;
            const _myA3 = _popcount(state.hands[_myP3] & RANK_MASK[5]);
            const _tot3 = _popcount(state.hands[_myP3]);
            let _omc3 = Infinity;
            for (let p = 0; p < state.numPlayers; p++)
                if (p !== _myP3 && !(state.eliminated & (1 << p)))
                    _omc3 = Math.min(_omc3, _popcount(state.hands[p]));
            // myAces<=2: always draw to complete 4A.
            // myAces===3: only draw when BF is heavily inflated vs opp AND has stuck cards
            //   (playing A would hand opp back 2 Aces from pile, while draw reclaims them).
            const _nonKA3 = _tot3 - _myA3 - _popcount(state.hands[_myP3] & RANK_MASK[4]);
            const _draw4ASensible = _myA3 <= 2
                || (_myA3 === 3 && _omc3 > 1 && _nonKA3 > 1);
            if (_myA3 >= 1 && _draw4ASensible) {
                const _dc3 = Math.min(3, state.pileSize - 1);
                let _da3 = 0;
                for (let i = 0; i < _dc3; i++)
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === 5) _da3++;
                if (_myA3 + _da3 >= 4) {
                    const dm3 = moves.find(m => !!(m & DRAW_FLAG));
                    if (dm3) return dm3;
                }
            }
        }

        // Endgame search: when either player has ≤3 cards, simulate forward
        // with BotfatherBot scoring (full info) to find the best move.
        if (!this._inSimulation && state.numPlayers === 2) {
            const _myP  = state.currentPlayer;
            const _myC  = _popcount(state.hands[_myP]);
            const _oppC = _popcount(state.hands[1 - _myP]);
            if (_myC <= 3 || (_oppC <= 3 && _myC <= 4)) {
                const eg = this._runEndgameSearch(state, moves);
                if (eg !== null) return eg;  // null = all outcomes losing, fall through to scoring
            }
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
        let drawHighCount = 0;  // how many Q/K/A are in the top 3 pile cards
        let drawMidCount  = 0;  // how many Jacks (rank 2) are in the top 3 pile cards
        for (let i = 0; i < drawCount; i++) {
            const dri = state.pile[state.pileSize - 1 - i] >> 2;
            drawRankMask |= (1 << dri);
            if (dri >= 3) drawHighCount++;
            if (dri === 2) drawMidCount++;
        }
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
            if (this._inSimulation || state.numPlayers === 2) {
                // Full info — read exact opp hand (2-player: state is always visible)
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
                && oppEstAces > 0 && oppMinCards <= 7 && myTotal <= oppMinCards + 3) {
            const subRI2trap = state.pile[state.pileSize - 2] >> 2;
            if ((topRI <= 1 && state.pileSize <= 4) || (topRI >= 2 && subRI2trap <= 1)) {
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
        // RULE 3c — 4A dominance / 4K dump
        // ==============================================================
        {
            // 4A dominance: with all 4 Aces and stuck cards, force opp to draw rather than
            // dumping 4K — opp draws A back + pile cards, uncovering lower tops for BF's stuck cards.
            const aceMoves4A = playMoves.filter(m => playRI(m) === 5);
            if (myAces === 4 && stuckCount > 0 && topRI < 5 && aceMoves4A.length > 0
                    && !playMoves.some(m => playCnt(m) === 1 && playRI(m) < 5 && (playRI(m) < 4 || oppEstKings === 0)))
                nominate(aceMoves4A[0], 950);

            // 4K dump: hand is nearly all K+A (≤1 non-KA card), junk is stuck
            // Guard: skip when BF has all 4 Aces — playing A is dominant then.
            // safeAceMin only required when myNonKA=1; purely K+A hands (myNonKA=0) always dump.
            const myNonKA = myTotal - myKings - myAces;
            if (myNonKA <= 1 && myAces < 4 && stuckCount >= myNonKA
                    && (myNonKA === 0 || myAces >= safeAceMin)) {
                const quadK = playMoves.find(m => playCnt(m) === 4 && playRI(m) === 4);
                if (quadK) nominate(quadK, 910);
            }
        }

        // ==============================================================
        // RULE 3 — 4-of-a-kind quad dump (rank 9–Q)
        // ==============================================================
        const oppHasQuad = opps.some(p => [0,1,2,3,4,5].some(r => _popcount(state.hands[p] & RANK_MASK[r]) >= 4));
        let oppMaxQuadRank = -1;
        if (oppHasQuad) {
            for (const p of opps) for (let r = 5; r >= 0; r--)
                if (_popcount(state.hands[p] & RANK_MASK[r]) >= 4) { oppMaxQuadRank = Math.max(oppMaxQuadRank, r); break; }
        }
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
                if (r === 3 && oppEstKings >= 1 && state.pileSize < 8) continue;
                if (r === 3 && stuckCount > 0 && myTotal > 8) continue;
                const hasLowerSingle = !riskFinishingHand && (oppMinCards > 4) && playMoves.some(
                    pm => playCnt(pm) === 1 && playRI(pm) < r && playRI(pm) <= 3 && playRI(pm) >= topRI
                );
                const _oppBelowQuadR = opps.some(p => { for (let _r = 0; _r < r; _r++) if (_popcount(state.hands[p] & RANK_MASK[_r]) > 0) return true; return false; });
                const aceFinishThreat = oppMinCards <= 3 && oppEstAces > 0 && _oppBelowQuadR;
                const blocksThreat = oppMaxQuadRank >= topRI && oppMaxQuadRank < r;
                const score = (aceFinishThreat || blocksThreat) ? 2500 + r : (riskFinishingHand ? 900 + r : 900);
                if (!hasLowerSingle || blocksThreat) nominate(m, score);
            }
        }

        // ==============================================================
        // RULE 3.5 — Draw to complete a junk quad (rank 9–Q)
        // ==============================================================
        // oppHasQuad / oppMaxQuadRank defined above before R3.
        const _newTopRI35 = state.pileSize > drawCount ? (state.pile[state.pileSize - 1 - drawCount] >> 2) : 0;
        const _drawFreesOpp = _newTopRI35 < topRI
                && opps.some(p => { for (let _r = 0; _r < topRI; _r++) if (_popcount(state.hands[p] & RANK_MASK[_r]) > 0) return true; return false; });
        if (drawMove !== null && myAces >= safeAceMin && stuckCount > 0
                && (oppMinCards > 3 || (oppEstAces === 0 && oppEstKings === 0 && oppMinCards > 1))
                && state.pileSize > 4 && !oppHasQuad && !_drawFreesOpp) {
            for (let r = 0; r <= 3; r++) {
                const inHand = _popcount(myHand & RANK_MASK[r]);
                if (inHand < 1 || inHand > 3) continue;
                let inDraw = 0;
                for (let i = 0; i < drawCount; i++) {
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === r) inDraw++;
                }
                // Skip if r === topRI and BF already has a single of that rank:
                // just play it directly to force opp to draw — no need to inflate hand.
                if (inHand + inDraw >= 4
                        && !(r === topRI && playMoves.some(m => playCnt(m) === 1 && playRI(m) === r))) {
                    nominate(drawMove, 500);
                }
            }
        }

        // ==============================================================
        // RULE 4 — Top card is A: Ace battle
        // ==============================================================
        if (topRI === 5) {
            // Emergency: opp has 1 card — usually play Ace to keep top high.
            // Exception: if drawing exposes a post-draw top that opp's card still can't
            // beat, draw instead — we recover pile cards AND opp stays stuck.
            if (oppMinCards === 1) {
                let oppOnlyRI = 5;
                if (opps.length > 0) {
                    for (let r = 0; r <= 5; r++) if (state.hands[opps[0]] & RANK_MASK[r]) { oppOnlyRI = r; break; }
                }
                const postDrawTopRI = (state.pileSize > drawCount + 1)
                    ? (state.pile[state.pileSize - 1 - drawCount] >> 2) : -1;
                if (drawMove !== null && postDrawTopRI > oppOnlyRI) {
                    nominate(drawMove, 1875);
                } else {
                    const emergAce = playMoves.filter(m => playRI(m) === 5);
                    if (emergAce.length > 0) nominate(emergAce[0], 1870);
                }
            }

            if (drawMove !== null && drawHasKing && myTotal >= 5 && oppMinCards > 2
                    && (oppEstKings > 0 || oppEstAces > 0))
                nominate(drawMove, 1820);

            if (drawMove !== null && oppEstAces === 0 && myAces >= safeAceMin
                    && myTotal >= 2 && stuckCount > 0)
                nominate(drawMove, 1810);

            // Draw to complete 4A: collecting all 4 Aces gives dominant pile control.
            // Beats playing a single Ace since opp immediately draws the played Ace back.
            // draw-4A: always when myAces<=2; also for myAces=3 when BF is heavily
            // inflated vs opp and has stuck cards (else playing A gives opp 2 Aces back).
            const nonKA = myTotal - myKings - myAces;
            const draw4ASensible = myAces <= 2
                || (myAces === 3 && oppEstAces === 0 && oppMinCards > 1 && nonKA > 1);
            if (drawMove !== null && myAces >= 1 && draw4ASensible) {
                let drawableAces = 0;
                for (let i = 0; i < drawCount; i++)
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === 5) drawableAces++;
                if (myAces + drawableAces >= 4) nominate(drawMove, 1840);
            }

            // Large-hand A-top draw: when both players have large hands, drawing to reclaim
            // the pile Ace beats Ace-battling. With oppEstAces>0, opp just answers with their
            // Ace — mutual waste. Score 1805 beats aceScore(1800) when oppEstAces>=1 but loses
            // to aceScore(1825) when oppEstAces=0 (opp must draw helplessly, play A is correct).
            if (drawMove !== null && topRI === 5 && myTotal >= 8 && oppMinCards >= 7 && stuckCount > 0)
                nominate(drawMove, 1805);

            const aceMoves = playMoves.filter(m => playRI(m) === 5);
            if (aceMoves.length > 0) {
                const acesAfter = myAces - 1;
                const safeToPlay = (acesAfter >= safeAceMin && myAces > oppEstAces + 1)
                                || (myTotal <= 4 && acesAfter >= safeAceMin && oppEstAces > 0)
                                || (oppMinCards <= 2 && acesAfter >= 1)   // opp near-win: play A
                                || (acesAfter >= 1 && myAces > oppEstAces && myTotal <= oppMinCards + 3); // A-advantage, comparable hand sizes
                if (safeToPlay) {
                    const aceScore = (oppEstAces === 0 && stuckCount > 0) ? 1825 : 1800;
                    nominate(aceMoves[0], aceScore);
                }
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
            const hasQuad = [0,1,2,3,4,5].some(r => _popcount(myHand & RANK_MASK[r]) >= 4);

            if (drawMove !== null && subRI2 === 4 && oppMinCards >= 3 && myTotal > 4
                    && lowJunk > 0 && (oppEstKings > 0 || oppEstAces > 0))
                nominate(drawMove, 1650);

            if (drawMove !== null && drawHasAce && myAces < safeAceMin)
                nominate(drawMove, 1640);

            if (drawMove !== null && state.pileSize <= 2 && subRI2 <= 1
                    && oppMinCards > 2 && myTotal >= 5)
                nominate(drawMove, 1630);

            if (drawMove !== null && oppMinCards === 2 && state.pileSize >= 5
                    && myTotal >= 8 && oppEstKings > 0 && !hasQuad)
                nominate(drawMove, 1620);

            if (drawMove !== null && drawHasKing && myKings === 3 && drawHighCount >= 2
                    && oppEstKings === 0 && oppEstAces === 0 && oppMinCards > 2)
                nominate(drawMove, 1635);

            // Opp has no Kings — don't play K or they draw all pile Kings back next turn.
            // Drawing is better: BF reclaims them and opp stays K-starved.
            // Guard: skip if BF already has K×3 (no need for more) or opp has Ace
            // (opp will play A at K-top, not draw pile Kings — premise invalid).
            if (drawMove !== null && drawHighCount >= 2 && oppEstKings === 0 && oppEstAces === 0
                    && myKings <= 2 && oppMinCards > 4 && stuckCount > 0)
                nominate(drawMove, 1625);

            // R5-reclaim-kings: pile has ≥2 high cards incl. a King, opp has ≤2 cards with no K.
            // Playing K would grow the pile; opp then draws those Kings back.
            // Drawing now reclaims them for BF while opp stays stuck.
            if (drawMove !== null && drawHasKing && drawHighCount >= 2
                    && oppMinCards <= 2 && oppEstKings === 0 && stuckCount > 0)
                nominate(drawMove, 1603);

            // K-dump recovery: opp just played all Ks into pile — draw to reclaim 3 rather than
            // wasting Aces (which opp would draw back along with Ks)
            if (drawMove !== null && myKings === 0 && oppEstKings === 0 && state.pileSize > 4)
                nominate(drawMove, 1645);

            // Draw to complete 4K: BF has 2-3 Kings and a King is in drawable pile cards
            // Completing the quad is worth far more than playing a K (which opp draws back)
            if (drawMove !== null && myKings >= 1 && myKings <= 2 && myAces >= safeAceMin && myAces < 4 && oppMinCards > 2 && stuckCount > 0) {
                let drawableKings = 0;
                for (let i = 0; i < drawCount; i++)
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === 4) drawableKings++;
                if (myKings + drawableKings >= 4) nominate(drawMove, 2050);
            }

            // Shallow-pile K-escalation: draw to recover opp's K from pile top.
            // Only when drawing gives us a net K advantage (myKings+1 > oppEstKings).
            // pile<=6 ensures the recovered K was recently played and is near the top.
            // Guards: skip if we have a quad, or if hand is small (≤6 cards) — with a
            // small high-card hand just play the K aggressively, never draw to "improve".
            if (drawMove !== null && state.pileSize <= 6 && oppEstKings >= 1
                    && myKings + 1 > oppEstKings && !hasQuad && myTotal > 6)
                nominate(drawMove, 1615);

            // Q-recovery draw: pile top has 2+ high cards (e.g. opp's K + 2 Qs from our dump).
            // Drawing reclaims them and resets pile to Q-level where opp's low cards are stuck,
            // instead of playing our own K which opp will draw back along with the Qs.
            // Guard: skip if we already have a quad — don't waste a K-play opportunity.
            if (drawMove !== null && drawHighCount >= 2 && state.pileSize <= 10
                    && myKings >= 1 && myAces >= safeAceMin
                    && myTotal <= oppMinCards + 2 && !hasQuad && myTotal > 6)
                nominate(drawMove, 1605);

            // Don't play K when already K-disadvantaged — opp will draw it back and widen the gap
            if (kingMoves.length > 0 && (myKings >= 2 || myAces >= safeAceMin) && myTotal > 4
                    && myKings >= oppEstKings) {
                if (state.pileSize >= 10 && (subRI2 === 4 || subRI3 === 4) && drawMove !== null
                        && oppEstKings > 0 && oppEstAces > 0 && oppMinCards > 3) {
                    nominate(drawMove, 1610);
                } else {
                    nominate(kingMoves[0], 1600);
                }
            }

            if (aceMoves.length > 0 && kingMoves.length === 0) {
                const acesAfter = myAces - 1;
                const dominant  = oppEstAces === 0 && acesAfter >= safeAceMin;
                const advantage = acesAfter >= safeAceMin && myAces > oppEstAces + 1;
                const lateGame  = myTotal <= 4 && acesAfter >= safeAceMin;
                if (lateGame || ((dominant || advantage) && subRI2 < 4))
                    nominate(aceMoves[0], 1580);
            }

            // R5-draw-lower-quad: drawing completes a rank<4 quad (Q/J/10/9) at K-top.
            // A one-shot 4-card dump later is worth more than playing a lone K now,
            // especially when BF is K-disadvantaged and the quad unblocks stuck lower cards.
            if (drawMove !== null && stuckCount > 0 && myAces >= safeAceMin) {
                for (let _r5 = 0; _r5 <= 3; _r5++) {
                    const _ih = _popcount(myHand & RANK_MASK[_r5]);
                    if (_ih < 1 || _ih > 3) continue;
                    let _id = 0;
                    for (let i = 0; i < drawCount; i++)
                        if ((state.pile[state.pileSize - 1 - i] >> 2) === _r5) _id++;
                    if (_ih + _id >= 4) { nominate(drawMove, 1595); break; }
                }
            }

            // R5-quad-K-play: BF has a winning quad — play K to escalate even if K-disadvantaged.
            // The quad (4Q/4J) clears the hand once top drops to Q/J level; K count is irrelevant.
            if (kingMoves.length > 0 && hasQuad)
                nominate(kingMoves[0], 1590);

            if (kingMoves.length > 0 && myKings >= oppEstKings) nominate(kingMoves[0], 1560);
            nominate(drawMove, 1540);
        }

        // ==============================================================
        // RULE 6 — Top ≤ Q: junk-dump phase
        // ==============================================================
        if (topRI <= 3) {
            // R6-steal-pile: pile has ≥2 high/mid cards (Q+) that opp would absorb on their
            // forced-draw turn if BF escalates with A. Drawing intercepts them first.
            // Score 960 beats R3c-4A-dominance (950) to override the A-play in this case.
            if (drawMove !== null && drawHighCount >= 2 && myAces >= safeAceMin
                    && stuckCount > 0 && oppMinCards >= 2)
                nominate(drawMove, 960);

            // R6-steal-jacks: pile has ≥2 drawable Jacks and opp holds Jacks.
            // If BF escalates Q→A, opp's forced draw picks up those Jacks giving opp J×3+.
            // Drawing now intercepts them. Score 961 (above R6-steal-pile when Qs are absent).
            if (drawMove !== null && drawMidCount >= 2 && myAces >= safeAceMin
                    && stuckCount > 0 && oppMinCards >= 2) {
                const _oppJsSJ = opps.reduce((s, p) => s + _popcount(state.hands[p] & RANK_MASK[2]), 0);
                if (_oppJsSJ >= 1) nominate(drawMove, 961);
            }

            let safePlays = [...playMoves];
            if (myAces === 1 && myTotal > 2) {
                const filtered = safePlays.filter(m => playRI(m) !== 5);
                if (filtered.length > 0) safePlays = filtered;
            }
            const hasQuad  = [0,1,2,3,4,5].some(r => _popcount(myHand & RANK_MASK[r]) >= 4);
            const lowJunk  = _popcount(myHand & (RANK_MASK[0] | RANK_MASK[1]));

            // 6-pre: shallow-pile Q recovery
            // Guard: only draw Q back when we're already behind — don't draw a Q
            // that opp deliberately played as a trap to put us 1 card over them.
            if (drawMove !== null && topRI === 3 && state.pileSize <= 2
                    && oppMinCards > 2 && myTotal >= 5 && myTotal > oppMinCards)
                nominate(drawMove, 340);

            // R6-Q-skip / R6-K-skip: at 9/10-top, skip over opp's stuck Jacks.
            if (topRI <= 1) {
                const myQs   = _popcount(myHand & RANK_MASK[3]);
                const oppQs  = opps.reduce((s, p) => s + _popcount(state.hands[p] & RANK_MASK[3]), 0);
                const oppJs  = opps.reduce((s, p) => s + _popcount(state.hands[p] & RANK_MASK[2]), 0);

                // R6-J-skip: at 9/10-top, skip over opp's 10s by jumping to J.
                // Playing a 10 lets opp immediately answer with their 10; J-top locks it.
                // Only useful when opp has Aces or Kings — if their ceiling is Q or lower,
                // BF's K×4 forces draws at will, so just dump 9s/10s naturally.
                const myJs   = _popcount(myHand & RANK_MASK[2]);
                const opp10s = opps.reduce((s, p) => s + _popcount(state.hands[p] & RANK_MASK[1]), 0);
                if (myJs >= 1 && opp10s >= 1 && state.pileSize > 3 && (oppEstAces > 0 || (oppEstKings > 0 && myKings <= oppEstKings))
                        && !safePlays.some(m => playCnt(m) === 1 && playRI(m) === 1)) {
                    const jSkip = safePlays.filter(m => playRI(m) === 2 && playCnt(m) === 1);
                    if (jSkip.length > 0) nominate(jSkip[0], 240);
                }

                // R6-Q-skip: BF has more Qs than opp — Q-top freezes opp's Jacks.
                // Guard: don't skip if BF has any single lower-rank card to dump first.
                if (myQs >= 2 && myQs < 4 && oppJs >= 1 && myQs > oppQs
                        && !safePlays.some(m => playCnt(m) === 1 && playRI(m) < 3)) {
                    const qSkip = safePlays.filter(m => playRI(m) === 3);
                    if (qSkip.length > 0) nominate(qSkip[0], 250);
                }

                // R6-K-skip: BF has strict K-advantage and opp has Jacks — skip straight to K.
                // J-elevation is wasted when opp can immediately answer J with J.
                // Playing K forces opp to draw (gains low cards) instead of shedding Jacks.
                // Guard: only skip if BF has no low junk (9/10) to dump first.
                if (oppJs >= 1 && myKings >= 2 && myKings > oppEstKings && myAces >= safeAceMin
                        && (!safePlays.some(m => playCnt(m) === 1 && playRI(m) < 4)
                            || (myAces > oppEstAces && stuckCount > 0 && oppJs >= 3))) {
                    const kSkip = safePlays.filter(m => playRI(m) === 4);
                    if (kSkip.length > 0) nominate(kSkip[0], 480);
                }

                // R6-Q-elevate: at 9/10-top with stuck 9s, jump to Q to trap opp's J/10/9 and
                // burn opp's Q response. Better than playing A prematurely — saves A/K for later.
                // Score 955 beats R3c-4A-dominance (950) so Q is preferred over A here.
                if (myQs >= 1 && stuckCount > 0 && oppQs >= 1 && myAces >= safeAceMin) {
                    const qElev = safePlays.filter(m => playCnt(m) === 1 && playRI(m) === 3);
                    if (qElev.length > 0) nominate(qElev[0], 955);
                }
            }

            // R6-Q-elevate-Jtop: at J-top, opp still has Jacks — skip to Q to trap them.
            // Playing BF's J lets opp shed their J; Q-top keeps opp's Js stuck.
            // Guard: pileSize > 3 — on shallow pile the escalated card comes right back.
            if (topRI === 2 && myAces >= safeAceMin && state.pileSize > 3) {
                const _oppJsJt = opps.reduce((s, p) => s + _popcount(state.hands[p] & RANK_MASK[2]), 0);
                if (_oppJsJt >= 1) {
                    const qElevJ = safePlays.filter(m => playCnt(m) === 1 && playRI(m) === 3);
                    if (qElevJ.length > 0) nominate(qElevJ[0], 430);
                }
            }

            // R6-K-skip at J/Q-top: opp has no K, so all non-A opp cards are stuck at K-top.
            // Fires when opp has no A (all stuck) OR BF has Ace advantage (extra A absorbs
            // opp's reply at A-top, then opp's Js/Qs stay stuck through the A-chain).
            if (topRI >= 2 && oppEstKings === 0 && stuckCount > 0
                    && myKings >= 2 && myAces >= safeAceMin
                    && (oppEstAces === 0 || myAces > oppEstAces)
                    && state.pileSize > 3
                    && !safePlays.some(m => playCnt(m) === 1 && playRI(m) === 3)) {
                const kJtop = safePlays.filter(m => playRI(m) === 4 && playCnt(m) === 1);
                if (kJtop.length > 0) nominate(kJtop[0], 480);
            }

            // 3-ace aggression: BF has 3+ Aces vs opp's ≤1 — play A to drain opp's last ace
            // and force pile resets (BF will win the A-exchange: opp runs out first)
            // Guard: skip if BF has a quad ready to deploy (save Aces), UNLESS BF has stuck
            // 9s that need the pile reset — then Ace-play is still the right call.
            const triAceMoves = safePlays.filter(m => playRI(m) === 5);
            if (triAceMoves.length > 0 && myAces >= 3 && oppEstAces === 1
                    && myAces - 1 >= safeAceMin && oppMinCards >= 5
                    && myTotal <= oppMinCards + 4 && topRI >= 1
                    && (!hasQuad || my9s >= 1)
                    && (stuckCount > 0 || myTotal > 10)
                    && !playMoves.some(m => playCnt(m) === 1 && playRI(m) === 4))
                nominate(triAceMoves[0], 600);

            // Draw to reclaim top-rank cards: when BF has many stuck cards and pile has
            // 2+ of topRI rank in drawable window, drawing maintains high pile top that
            // freezes opp's low cards — better than playing a King into the pile.
            if (drawMove !== null && stuckCount >= 2 && myTotal > oppMinCards + 4
                    && oppMinCards > 1 && state.pileSize > 3
                    && !playMoves.some(m => playCnt(m) === 1 && playRI(m) === topRI)) {
                let topRankInDraw = 0;
                for (let i = 0; i < drawCount; i++)
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === topRI) topRankInDraw++;
                if (topRankInDraw >= 2) nominate(drawMove, 460);
            }

            // 6a: opponent near win
            if (oppMinCards <= 3 && safePlays.length > 0) {
                if (oppMinCards === 1) {
                    let _oppHiRI = 0;
                    for (const p of opps) for (let r = 5; r >= 0; r--)
                        if (state.hands[p] & RANK_MASK[r]) { _oppHiRI = Math.max(_oppHiRI, r); break; }
                    const minSafeRI = oppEstAces > 0 ? 6 : oppEstKings > 0 ? 5 : Math.max(topRI, _oppHiRI + 1);
                    const safe1 = safePlays.filter(m => playRI(m) >= minSafeRI)
                                           .sort((a, b) => playRI(a) - playRI(b));
                    if (safe1.length > 0) nominate(safe1[0], 4000);
                    else nominate(drawMove, 3900);
                } else {
                    const sorted = [...safePlays].sort((a, b) => playRI(b) - playRI(a));
                    const highest = sorted[0];
                    const hRI     = playRI(highest);
                    if (hRI >= 4 && myAces >= safeAceMin && (oppEstKings > 0 || oppEstAces > 0 || oppMinCards <= 2
                            || (oppEstKings === 0 && oppEstAces === 0 && myKings >= 1))) {
                        // Quad priority: play quad (rank ≤ K) to trap opp's low cards or force
                        // them to waste high cards — applies before any K/A escalation logic.
                        // Skip when BF has strict K-advantage and opp has a K to answer the
                        // quad-elevation: K-play (2000 below) is more direct and preserves quad.
                        if (hasQuad && !(myKings > oppEstKings && oppEstKings > 0 && myAces >= safeAceMin)) {
                            let oppLowest = 5;
                            for (const p of opps) {
                                for (let r = 0; r < 6; r++) {
                                    if (_popcount(state.hands[p] & RANK_MASK[r]) > 0 && r < oppLowest) oppLowest = r;
                                }
                            }
                            // Never dump 4K in R6a: opp either draws all 3 Kings back (oppEstAces=0)
                            // or plays their Ace forcing A-top while BF's Jacks stay stuck (oppEstAces>0).
                            const qm = safePlays.find(m => _popcount(m & 0xFFFFFF) >= 4 && playRI(m) < 4 && (playRI(m) > oppLowest || oppLowest >= topRI));
                            if (qm) {
                                const _qSingle = safePlays.find(m => playCnt(m) === 1 && playRI(m) === playRI(qm));
                                nominate(_qSingle ?? qm, 2100);
                            }
                        }
                        if (oppEstAces === 0 && oppEstKings > 0) {
                            if (myKings > oppEstKings) {
                                const kMove = safePlays.find(m => playRI(m) === 4);
                                if (kMove) nominate(kMove, 2000);
                            }
                            nominate(highest, 2000);
                        } else {
                            // Prefer min-rank single (rank < K) when opp has stuck cards below
                            // topRI — dump junk and preserve Kings rather than escalating early.
                            let _oppLowestRI = 5;
                            for (const p of opps) for (let r = 0; r < 6; r++) if (state.hands[p] & RANK_MASK[r]) { _oppLowestRI = Math.min(_oppLowestRI, r); break; }
                            if (_oppLowestRI < topRI) {
                                const minSingle = safePlays.filter(m => playCnt(m) === 1 && playRI(m) < 4)
                                                           .sort((a, b) => playRI(a) - playRI(b))[0];
                                if (minSingle) nominate(minSingle, 2050);
                                const kMove = safePlays.find(m => playRI(m) === 4);
                                if (kMove) nominate(kMove, 2000);
                                else nominate(highest, 2000);
                            }
                        }
                    } else if (hRI < 4) {
                        nominate(highest, 2000);
                    } else {
                        const nonK = sorted.find(m => playRI(m) < 4);
                        if (nonK) nominate(nonK, 2000);
                    }
                }
            }

            // 6-equal-escalate: BF is strictly behind (opp has first-mover advantage) —
            // skip mirroring a low rank, play K now to disrupt cadence.
            // Only in endgame (<=8 cards), pure high-card hand (no stuck cards),
            // with enough Aces in reserve and at least as many Ks as opp.
            if (topRI <= 3 && myTotal > oppMinCards && myTotal <= 9
                    && stuckCount === 0 && myKings >= 1 && myAces >= safeAceMin
                    && myKings >= oppEstKings
                    && !safePlays.some(m => playCnt(m) === 1 && playRI(m) < 4)) {
                const kEscMoves = safePlays.filter(m => playRI(m) === 4);
                if (kEscMoves.length > 0) nominate(kEscMoves[0], 380);
            }

            // 6-pileup: stuck 9s at 10-top — play J/Q to raise pile above ALL opp cards.
            // Prefer the lowest single whose rank strictly exceeds opp's highest card (full trap).
            // Fall back to any non-quad-ruining J/Q single if no full-trap option exists.
            if (my9s >= 1 && topRI === 1) {
                let oppHighestRI = 0;
                for (const p of opps) for (let r = 5; r >= 0; r--) if (state.hands[p] & RANK_MASK[r]) { oppHighestRI = Math.max(oppHighestRI, r); break; }
                const trapMoves = safePlays.filter(m => playCnt(m) === 1 && playRI(m) > oppHighestRI && playRI(m) <= 3);
                if (trapMoves.length > 0) {
                    nominate(trapMoves.reduce((a, b) => playRI(a) <= playRI(b) ? a : b), 450);
                } else {
                    // Don't elevate if BF has same-rank (topRI) singles to dump first —
                    // those would be stranded above the elevated pile top.
                    const hasTopRankSingle = safePlays.some(m => playCnt(m) === 1 && playRI(m) === topRI);
                    if (!hasTopRankSingle) {
                        const jqSingles = safePlays.filter(m => playCnt(m) === 1 && (playRI(m) === 2 || playRI(m) === 3));
                        if (jqSingles.length > 0) {
                            const lowestJQ = jqSingles.reduce((a, b) => playRI(a) <= playRI(b) ? a : b);
                            if (_popcount(myHand & RANK_MASK[playRI(lowestJQ)]) < 4)
                                nominate(lowestJQ, 450);
                        }
                    }
                }
            }

            // 6b: draw to unblock stuck 9s on 10-top — only when no 10s to play and not already ahead in cards
            if (drawMove !== null && my9s >= 1 && topRI === 1
                    && _popcount(myHand & RANK_MASK[1]) === 0
                    && myTotal <= oppMinCards + 3
                    && myAces >= safeAceMin && myKings >= 1)
                nominate(drawMove, 400);

            // 6b2: deeply stuck AND pile has power
            if (drawMove !== null && stuckCount >= Math.ceil(myTotal / 2) && (drawHasAce || drawHasKing))
                nominate(drawMove, 340);

            // 6c: K escalation — only when stuck, pile is deep enough opp can't cheaply draw K back,
            // and BF is not K-disadvantaged
            if (myKings >= 1 && myAces >= safeAceMin && topRI >= 1 && stuckCount > 0
                    && state.pileSize > 5 && myKings >= oppEstKings
                    && !safePlays.some(m => playCnt(m) === 1 && playRI(m) < 4)) {
                const kingMoves = safePlays.filter(m => playRI(m) === 4);
                const aceAdvantage = myAces > oppEstAces + 1;
                if (kingMoves.length > 0 && (oppEstAces > 0 || aceAdvantage))
                    nominate(kingMoves[0], 300);
            }

            // 6-ace-force
            if (oppEstAces === 0 && myAces >= safeAceMin && topRI >= 2
                    && myTotal <= oppMinCards + 3) {
                const hasQuadFollowUp = [0,1,2,3].some(r => _popcount(myHand & RANK_MASK[r]) === 4);
                if (hasQuadFollowUp) {
                    const afMoves = safePlays.filter(m => playRI(m) === 5);
                    if (afMoves.length > 0) nominate(afMoves[0], 350);
                }
            }

            // 6d/6e: junk singles — lowest rank first
            {
                let candidates = safePlays;
                if (myTotal > 4) {
                    const singles = safePlays.filter(m => playCnt(m) === 1);
                    if (singles.length > 0) candidates = singles;
                }
                candidates.sort((a, b) => playRI(a) - playRI(b));
                const lastAceTrap = myAces === 1 && myTotal > 1 && stuckCount > 0;
                candidates.forEach((m, i) => {
                    if (lastAceTrap && playRI(m) === 5) return;
                    nominate(m, 200 - playRI(m) - i * 0.01);
                });
            }
        }

        // Absolute fallback draw (all topRI)
        nominate(drawMove, 100);

        // ---- Pick best nominated move ----
        let bestMove = null, bestScore = -Infinity;
        for (const [m, s] of _scores) {
            if (s > bestScore) { bestScore = s; bestMove = m; }
        }
        bestMove = bestMove ?? moves[0];
        if (!this._inSimulation) {
            const rule = bestScore >= 10000 ? 'R0-instant-win'
                       : bestScore >= 9000  ? 'R0.5-ace-guard-draw'
                       : bestScore >= 5100  ? 'R1-open-triple9'
                       : bestScore >= 5050  ? 'R1-open-quad-block'
                       : bestScore >= 5000  ? 'R1-opening'
                       : bestScore >= 4800  ? 'R2-triple9'
                       : bestScore >= 4500  ? 'R2.5-pile-trap-ace'
                       : bestScore >= 4000  ? 'R6a-opp-1card'
                       : bestScore >= 3900  ? 'R6a-opp-1card-draw'
                       : bestScore >= 3500  ? 'R3b-KA-finish'
                       : bestScore >= 2500  ? 'R3-quad-dump(ace-threat)'
                       : bestScore >= 2050  ? 'R5-draw-4K-complete'
                       : bestScore >= 2000  ? 'R6a-opp-near-win'
                       : bestScore >= 1870  ? 'R4-opp-1card-ace'
                       : bestScore >= 1840  ? 'R4-draw-4A-complete'
                       : bestScore >= 1820  ? 'R4-ace-top-draw-K'
                       : bestScore >= 1800  ? 'R4-ace-battle'
                       : bestScore >= 1700  ? 'R4-ace-top-draw-fb'
                       : bestScore >= 1645  ? 'R5-K-dump-recover'
                       : bestScore >= 1625  ? 'R5-opp-no-K-draw'
                       : bestScore >= 1615  ? 'R5-K-shallow-draw'
                       : bestScore >= 1605  ? 'R5-Q-recovery-draw'
                       : bestScore >= 1603  ? 'R5-reclaim-kings'
                       : bestScore >= 1600  ? 'R5-K-top-play-K'
                       : bestScore >= 1595  ? 'R5-draw-lower-quad'
                       : bestScore >= 1540  ? 'R5-K-top-fallback'
                       : bestScore >= 961   ? 'R6-steal-jacks'
                       : bestScore >= 960   ? 'R6-steal-pile'
                       : bestScore >= 955   ? 'R6-Q-elevate'
                       : bestScore >= 950   ? 'R3c-4A-dominance'
                       : bestScore >= 900   ? 'R3-quad-dump'
                       : bestScore >= 600   ? 'R6-3ace-aggro'
                       : bestScore >= 500   ? 'R3.5-draw-for-quad'
                       : bestScore >= 480   ? 'R6-K-skip'
                       : bestScore >= 450   ? 'R6-pile-elevation'
                       : bestScore >= 430   ? 'R6-Q-elevate-Jtop'
                       : bestScore >= 400   ? 'R6b-stuck9s-draw'
                       : bestScore >= 380   ? 'R6-equal-escalate'
                       : bestScore >= 350   ? 'R6-ace-force'
                       : bestScore >= 340   ? 'R6b2/pre-draw'
                       : bestScore >= 300   ? 'R6c-K-esc'
                       : bestScore >= 250   ? 'R6-Q-skip'
                       : bestScore >= 200   ? 'R6d-junk-single'
                       : bestScore >= 100   ? 'fallback-draw'
                       : 'unknown';
            console.log(`  [BF] ${rule} (${bestScore})`);
        }
        return bestMove;
    }

    // ============================================================
    // Endgame search — triggered when myCards ≤ 3 or oppCards ≤ 3
    // ============================================================

    _runEndgameSearch(state, moves) {
        const myP    = state.currentPlayer;
        const simBot = new BotfatherBot();
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
        let oppMinC = Infinity;
        for (let p = 0; p < state.numPlayers; p++) {
            if (p !== myP && !(state.eliminated & (1 << p)))
                oppMinC = Math.min(oppMinC, _popcount(state.hands[p]));
        }
        // Only suppress inconclusive outcomes when opp is not about to win
        if ((bestMove & DRAW_FLAG) && bestOutcome === 0 && oppMinC > 3) return null;
        if (bestOutcome === 0 && (_popcount(state.hands[myP]) > 3 || oppMinC > 5)) return null;
        return bestOutcome > -10 ? bestMove : null;
    }

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
