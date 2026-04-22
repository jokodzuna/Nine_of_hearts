// q-bot.js — Q-table engine for The Botfather (player 1, black cards)
// Implements the same interface as ISMCTSEngine so it drops straight into
// game-controller.js with no other changes.

import { getPossibleMoves, DRAW_FLAG } from './game-logic.js';
import { ISMCTSEngine } from './ai-engine.js'; // TEST_BLOCK

// ---- Constants (must match q-trainer.mjs exactly) -------------------
const BOT      = 1;
const ACT_QUAD = 6;
const ACT_DRAW = 7;
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

// ---- Bit helpers ----------------------------------------------------
function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

// ---- State encoding V2 (must match hybrid-trainer.mjs encodeState exactly) --------
function pClass(rk) { return rk <= 1 ? 0 : rk <= 3 ? 1 : 2; }
function bkt(n)     { return n >= 3 ? 3 : n; }
function pdepth(ps) { const d=ps-1; return d<=0?0 : d<=2?1 : 2; }

function encodeState(s) {
    const h   = s.hands[BOT];
    const oh  = s.hands[1 - BOT];
    const p2  = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3  = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    const myH = Math.min(pop(h),  12);
    const opH = Math.min(pop(oh), 12);
    const myA = pop(h & RM[5]);
    return `${s.topRankIdx}|${p2}|${p3}` +
           `|${bkt(pop(h  & (RM[0]|RM[1])))}|${bkt(pop(h  & (RM[2]|RM[3])))}` +
           `|${myA}|${myH}|${opH}|${pdepth(s.pileSize)}|${bkt(pop(oh & (RM[4]|RM[5])))}`;
}

// ---- Action ↔ concrete move (identical to q-trainer.mjs) ------------
function moveToAct(m) {
    if (m & DRAW_FLAG) return ACT_DRAW;
    const bits = m & 0xFFFFFF;
    if (pop(bits) >= 3) return ACT_QUAD;
    return (31 - Math.clz32(bits)) >> 2;
}

function actToMove(moves, act) {
    if (act === ACT_DRAW) {
        for (const m of moves) if (m & DRAW_FLAG) return m;
        return null;
    }
    if (act === ACT_QUAD) {
        for (const m of moves) if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m;
        return null;
    }
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        const bits = m & 0xFFFFFF;
        if (pop(bits) === 1 && ((31 - Math.clz32(bits)) >> 2) === act) return m;
    }
    return null;
}

// ---- Heuristic fallback (used while Q-table is loading) -------------
function heuristicMove(moves) {
    const plays = moves.filter(m => !(m & DRAW_FLAG));
    if (!plays.length) return moves[0];
    let best = plays[0], bestRank = -1;
    for (const m of plays) {
        const rk = (31 - Math.clz32((m & 0xFFFFFF) & (-(m & 0xFFFFFF)))) >> 2;
        if (rk > bestRank) { bestRank = rk; best = m; }
    }
    return best;
}

// ---- QBotEngine class -----------------------------------------------
export class QBotEngine {
    constructor() {
        this._table = null;
        fetch('./q-table.json')
            .then(r => r.json())
            .then(data => { this._table = data.table; })
            .catch(err => console.warn('[QBot] Could not load q-table.json — using heuristic fallback.', err));
    }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        if (!moves.length) return 0;

        if (!this._table) {
            return heuristicMove(moves);
        }

        const key   = encodeState(state);
        const qrow  = this._table[key];
        const legal = [...new Set(moves.map(moveToAct))];

        // Greedy pick — no exploration during deployment
        let best = legal[0], bv = -Infinity;
        for (const a of legal) {
            // null entry means untried (Q=Infinity); treat as strongly preferred
            const v = qrow ? (qrow[a] ?? Infinity) : Infinity;
            if (v > bv) { bv = v; best = a; }
        }

        return actToMove(moves, best) ?? heuristicMove(moves);
    }

    // --- ISMCTSEngine interface stubs (Q-bot is stateless per-game) ---
    cleanup()        {}
    resetKnowledge() {}
    observeMove()    {}
    advanceTree()    {}
}

// ===== TEST_BLOCK_START — delete this class and the ISMCTSEngine import above for production =====
export class HybridQBotEngine {
    constructor() {
        this._table     = null;
        this._mcts      = new ISMCTSEngine('shark');
        this._turnCount = 0;
        fetch('./q-table.json')
            .then(r => r.json())
            .then(data => { this._table = data.table ?? data; })
            .catch(err => console.warn('[HybridQBot] q-table.json unavailable — using MCTS.', err));
    }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        if (!moves.length) return 0;
        this._turnCount++;

        const p        = state.currentPlayer;
        const myCards  = pop(state.hands[p]);
        const oppCards = pop(state.hands[1 - p]);
        const isOpening = this._turnCount <= 5;
        const isEndgame = myCards <= 4 || oppCards <= 4;

        if (!this._table || isOpening || isEndgame)
            return this._mcts.chooseMove(state);

        const key  = encodeState(state);
        const qrow = this._table[key];
        if (!qrow) return this._mcts.chooseMove(state);

        const legal = [...new Set(moves.map(moveToAct))];
        let best = legal[0], bv = -Infinity;
        for (const a of legal) {
            const v = qrow[a] ?? Infinity;
            if (v > bv) { bv = v; best = a; }
        }
        return actToMove(moves, best) ?? heuristicMove(moves);
    }

    cleanup()         { this._mcts.cleanup(); }
    resetKnowledge()  { this._turnCount = 0; this._mcts.resetKnowledge(); }
    observeMove(m, p) { this._mcts.observeMove(m, p); }
    advanceTree(m, p) { this._mcts.advanceTree(m, p); }
}
// ===== TEST_BLOCK_END =====
