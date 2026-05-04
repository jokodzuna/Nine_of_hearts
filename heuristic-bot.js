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
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0F0F0F0F;
    return Math.imul(x, 0x01010101) >>> 24;
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
        let   playMoves = moves.filter(m => !(m & DRAW_FLAG));

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
        // RULE 0.5 — Absolute lone-Ace guard (early/mid game)
        // With 5+ cards in hand, NEVER play the last Ace.
        // Shadow Ace out of playMoves so ALL later rules naturally avoid it.
        // If Ace is the ONLY option, draw instead.
        // ==============================================================
        if (myAces === 1 && myTotal >= 5) {
            const nonAce = playMoves.filter(m => playRI(m) !== 5);
            if (nonAce.length > 0) {
                playMoves = nonAce;                    // Ace no longer reachable by any rule
            } else if (drawMove !== null) {
                return drawMove;                       // forced Ace → draw instead
            }
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
        // RULE 2.5 — Pile-trap Ace escalation
        // When the pile's current top card OR the card one below the top is a 9/10
        // (rank ≤ 1), escalating with A forces opp to draw and receive that low card
        // stuck in their hand.  Only worthwhile with Ace surplus and opp still in
        // contention (has an Ace to chain with).
        // ==============================================================
        // Don't burn an Ace on pile-trap when a quad junk dump is ready — Rule 3 handles it
        const _quadReady = playMoves.some(m => !(m & DRAW_FLAG) && playCnt(m) === 4 && playRI(m) <= 4);
        if (!_quadReady && topRI <= 3 && state.pileSize >= 2 && myAces >= safeAceMin && oppEstAces > 0
                && oppMinCards <= 5) {
            const subRI2trap = state.pile[state.pileSize - 2] >> 2;
            if (topRI <= 1 || subRI2trap <= 1) {
                const aceTrapMoves = playMoves.filter(m => playRI(m) === 5);
                if (aceTrapMoves.length > 0) return aceTrapMoves[0];
            }
        }

        // ==============================================================
        // RULE 3 — 4-of-a-kind junk dump (rank 9–Q only, Ace reserve safe)
        // Only play the quad immediately when there are no playable single cards
        // of a LOWER junk rank — dump small singles first so they don't get
        // buried under the quad and restart the escalation loop.
        // NOTE: King quads are excluded — after playing 4K, opp draws 3 Kings
        //       straight back from the pile top (or responds with A). Never good.
        // ==============================================================
        for (const m of playMoves) {
            if (playCnt(m) === 4 && playRI(m) <= 3   // rank 9–Q only, NOT K
                    && (myAces >= safeAceMin || myTotal > oppMinCards + 3)) {
                const r = playRI(m);
                // Never play a quad when opp has ≤1 card: they respond with their
                // last card on the new top and win (0 cards remaining).
                if (oppMinCards <= 1) continue;
                // Low-rank quads (9/10/J) create a top that almost any card can beat.
                // When opp has ≤4 cards they could have a responsive quad and win in 1 move.
                if (oppMinCards <= 4 && r <= 2) continue;
                // When opp has very few cards (<=3) AND still has an Ace AND we have
                // surplus Aces, escalating with K/A (Rule 6a) is stronger than a quad
                // dump — opp can respond to the quad with their power cards anyway.
                if (oppMinCards <= 3 && oppEstAces > 0 && myAces > safeAceMin) continue;
                // Skip Q-quad if opp is known to hold a King (K beats Q-top → opp escapes).
                if (r === 3 && oppEstKings > 0 && oppMinCards <= 3) continue;
                // When opp is near-win press with the quad immediately;
                // otherwise shed lower singles first so they don't get buried.
                const hasLowerSingle = (oppMinCards > 4) && playMoves.some(
                    pm => playCnt(pm) === 1 && playRI(pm) < r && playRI(pm) <= 3
                );
                if (!hasLowerSingle) return m;
            }
        }

        // ==============================================================
        // RULE 3.5 — Draw to complete a junk quad (rank 9–Q)
        // If the top drawCount pile cards + cards already in hand total 4
        // of any junk rank, drawing is strictly better than playing a single
        // card: we'll dump all 4 next turn for a net hand reduction.
        // ==============================================================
        if (drawMove !== null && myAces >= safeAceMin && stuckCount > 0) {
            for (let r = 0; r <= 3; r++) {
                const inHand = _popcount(myHand & RANK_MASK[r]);
                if (inHand === 0 || inHand >= 3) continue; // 3+ in hand: play singles; Rule 3 handles full quads
                let inDraw = 0;
                for (let i = 0; i < drawCount; i++) {
                    if ((state.pile[state.pileSize - 1 - i] >> 2) === r) inDraw++;
                }
                if (inHand + inDraw >= 4) return drawMove;
            }
        }

        // ==============================================================
        // RULE 4 — Top card is A: Ace battle
        // ==============================================================
        if (topRI === 5) {
            const aceMoves = playMoves.filter(m => playRI(m) === 5);

            // 4a. Mid-game: if pile has K below the A-top, drawing recovers A+K — always prefer that
            //     (only when we have 5+ cards; in late-game the K+A finishing line takes over below)
            if (drawMove !== null && drawHasKing && myTotal >= 5) return drawMove;

            // 4b. Opp has no Aces — drawing the A back is strictly better than escalating.
            //     Playing another A onto A-top just gifts opp that A (and whatever is below)
            //     when they're forced to draw. Get it back for free instead.
            //     Guard lowered to myTotal >= 2: Rule 0 handles the 1-card win case.
            if (drawMove !== null && oppEstAces === 0 && myAces >= safeAceMin && myTotal >= 2) return drawMove;

            if (aceMoves.length > 0) {
                const acesAfter = myAces - 1;
                // Only escalate with a strict buffer: must stay at safeAceMin AND have clear advantage
                const safeToPlay = (acesAfter >= safeAceMin && myAces > oppEstAces + 1) // 2+ Ace lead over opp who has some
                                // Late-game (≤4 cards): escalate unless opp has no Aces — if they
                                // have none, playing A just gifts it back to them when they draw.
                                || (myTotal <= 4 && acesAfter >= safeAceMin && oppEstAces > 0);
                if (safeToPlay) return aceMoves[0];
            }
            // Can't safely spend Ace — draw
            return drawMove ?? playMoves[0];
        }

        // ==============================================================
        // RULE 5 — Top card is K: escalation decision
        // Priority: draw K+K recovery > rescue draw > match K > escalate A > draw
        // ==============================================================
        if (topRI === 4) {
            const aceMoves  = playMoves.filter(m => playRI(m) === 5);
            const kingMoves = playMoves.filter(m => playRI(m) === 4);

            // Cards sitting below the current K-top (what opp draws after we play)
            const subRI2 = state.pileSize >= 2 ? state.pile[state.pileSize - 2] >> 2 : -1;
            const subRI3 = state.pileSize >= 3 ? state.pile[state.pileSize - 3] >> 2 : -1;

            // 5a. Draw to recover K+K — when pile's 2nd card is also K, drawing gives back
            // both kings (3-card draw = A/top_K + 2nd_K + whatever).
            // Skip in late-game (myTotal<=4) OR when hand has no 9s/10s (low junk):
            // any power-only hand (AAAKKK, AAAKKQ, etc.) is already a finishing hand —
            // recovering more Kings is pointless and just delays the close.
            const lowJunk = _popcount(myHand & (RANK_MASK[0] | RANK_MASK[1]));
            if (drawMove !== null && subRI2 === 4 && oppMinCards >= 3
                    && myTotal > 4 && lowJunk > 0) {
                return drawMove;
            }

            // 5b. Draw if pile has a rescue Ace we need
            if (drawMove !== null && drawHasAce && myAces < safeAceMin) {
                return drawMove;
            }

            // 5b2. Shallow-pile K recovery: K sits on low junk (e.g. K on 9♥, pileSize≤2).
            //      Drawing gets the K back for free rather than matching and recycling both Kings.
            //      Guard: opp not near win (don't open 9♥ top when opp has ≤2 cards).
            if (drawMove !== null && state.pileSize <= 2 && subRI2 <= 1
                    && oppMinCards > 2 && myTotal >= 5) {
                return drawMove;
            }

            // 5b3. Opponent has ≤2 cards with deep pile: draw to recover K rather than
            //      matching. K-match gives opp back powerful drawn cards (K+K+?);
            //      drawing may expose a top they can't respond to (e.g. Q when opp has J).
            //      Guard: myTotal≥8 — if we're nearly done ourselves, press instead.
            if (drawMove !== null && oppMinCards <= 2 && state.pileSize >= 5 && myTotal >= 8) {
                return drawMove;
            }

            // 5c. Match K — PREFER this over burning an Ace; opp must respond to K again
            // Exception: deep-pile K-loop guard — when pile is large (>=10) and drawing
            // already recovers a K, matching K just recycles power cards and extends the game.
            // Late-game skip: when myTotal<=4 fall through to 5d to escalate with A directly.
            if (kingMoves.length > 0 && (myKings >= 2 || myAces >= safeAceMin) && myTotal > 4) {
                // K-loop guard: only skip K-match when ANOTHER K is buried below the current
                // K-top (subRI2/3 === 4). drawHasKing is always true on K-top (the top card
                // itself is K), so using it here would permanently block K-matching on deep piles.
                // K-loop only forms when opp has BOTH K (to match) AND A (to escalate further).
                // When opp has K but no A, P0's Ace dominance wins the battle — keep pressing.
                // When opp has neither K nor A, they MUST draw — no loop possible.
                if (state.pileSize >= 10 && (subRI2 === 4 || subRI3 === 4) && drawMove !== null
                        && oppEstKings > 0 && oppEstAces > 0) return drawMove;
                return kingMoves[0];
            }

            // 5d. Escalate with A — only with strict dominance AND pile doesn't hand opp power
            // When I play A, opp draws: [my A] + [current K top] + [subRI2 card].
            // The first two cards are always A+K (always power), so only escalate when
            // pile is shallow (subRI2 is NOT a K/A) AND we have overwhelming Ace advantage.
            // Late-game override: when myTotal<=4 just escalate regardless of pile depth.
            if (aceMoves.length > 0) {
                const acesAfter = myAces - 1;
                const dominant  = oppEstAces === 0 && acesAfter >= safeAceMin;
                const advantage = acesAfter >= safeAceMin && myAces > oppEstAces + 1;
                const lateGame  = myTotal <= 4 && acesAfter >= safeAceMin;
                if (lateGame || ((dominant || advantage) && subRI2 < 4)) return aceMoves[0];
            }

            // 5e. K fallback — 5c was skipped (late-game) and 5d couldn't fire (lone Ace).
            //     Playing K is always better than drawing with a hand like K♥ K♦ A♣.
            if (kingMoves.length > 0) return kingMoves[0];

            // 5f. Draw (absolute last resort — preserve last K / Aces)
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

        // 6-pre. Shallow-pile Q recovery: Q sits on 9♥ or low junk (pileSize≤2).
        //        Draw it back rather than play over — don't open 9♥ top when opp has ≤2 cards.
        if (drawMove !== null && topRI === 3 && state.pileSize <= 2
                && oppMinCards > 2 && myTotal >= 5) {
            return drawMove;
        }

        // 6a. Opponent near win — maximum pressure
        if (oppMinCards <= 4 && safePlays.length > 0) {
            // When opp has exactly 1 card, don't play a rank ≤ that card — they respond
            // with their last card (= win).  With card tracking oppEstKings reflects their
            // actual card; fall through to draw or a safely-higher play.
            let pressPlays = safePlays;
            if (oppMinCards === 1) {
                // Filter out any play rank that opp could respond to and win with
                const minSafeRI = (oppEstKings > 0 ? 5 : (oppEstAces > 0 ? 6 : 0));
                const safe1 = safePlays.filter(m => playRI(m) >= minSafeRI);
                if (safe1.length > 0) pressPlays = safe1;
                else return drawMove ?? safePlays[safePlays.length - 1]; // can't safely press
            }
            const sorted = [...pressPlays].sort((a, b) => playRI(b) - playRI(a));
            const highest = sorted[0];
            const hRI     = playRI(highest);
            // When Aces are the top option, prefer K — it forces opp to respond without
            // burning our Aces; if opp plays A in reply, bot's Ace advantage remains.
            if (hRI >= 4 && myAces >= safeAceMin) {
                const kMove = pressPlays.find(m => playRI(m) === 4);
                if (kMove) return kMove;      // K preferred over A
                return highest;               // no K — escalate with A
            }
            if (hRI < 4) return highest;      // J/Q/10: always press
            // Power cards present but Ace-deficient: play next-best (J/Q)
            const nonK = sorted.find(m => playRI(m) < 4);
            if (nonK) return nonK;
        }

        // 6b. Draw to unblock stuck 9s: when top is 10 and we hold any 9s
        // that can never be played at the current rank, drawing peels back the pile and
        // may uncover a lower top — playing a J/Q/K instead pushes top UP, burying 9s deeper.
        // Guard: only when we have solid power backup (Aces + King) to handle whatever
        // new top appears after the draw; without them the draw can be disastrous.
        if (drawMove !== null && my9s >= 1 && topRI === 1
                && myAces >= safeAceMin && myKings >= 1) return drawMove;

        // 6b2. Deeply stuck AND pile has power cards → draw
        if (drawMove !== null && stuckCount >= Math.ceil(myTotal / 2) && (drawHasAce || drawHasKing)) {
            return drawMove;
        }

        // 6c. K escalation: press with King on J+ tops
        // Fire when:
        //   (a) opp has Aces: K forces them to draw K back OR spend an Ace — classic battle.
        //   (b) we have stuck junk (stuckCount>0): K escalation exposes a lower pile top
        //       so stuck Js/10s can be shed next turn. Don't mirror P1's Q plays; press with K.
        // When neither applies (no Aces on either side, no stuck cards), fall to 6d/6e
        // which pick the lowest safe card — opp drawing Q is far less harmful than opp drawing K.
        if (myKings >= 1 && myAces >= safeAceMin && topRI >= 2
                && (oppEstAces > 0 || stuckCount > 0)) {
            const kingMoves = safePlays.filter(m => playRI(m) === 4);
            const aceAdvantage = myAces > oppEstAces + 1 && stuckCount > 0;
            if (kingMoves.length > 0 && (oppEstAces > 0 || aceAdvantage)) {
                return kingMoves[0];
            }
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
