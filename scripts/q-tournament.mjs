// ============================================================
// scripts/q-tournament.mjs
// Reward-parameter search via Q-bot knockout tournament.
//
// 32 variants are trained from the warm Q-table (10k episodes each
// vs balanced heuristic). They then play a single-elimination
// bracket (200 games per match). The champion's config is printed.
//
// Usage:  node scripts/q-tournament.mjs
// ============================================================

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir      = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(__dir, '..', 'q-table.json');

// ---- Hyper-parameters -----------------------------------------------
const TRAIN_EPS    = 10_000;   // episodes per variant during warm-up
const MATCH_GAMES  = 200;      // games per knockout match (100 each side)
const ALPHA        = 0.2;
const GAMMA        = 0.997;
const EPS_TRAIN    = 0.25;     // exploration during training phase
const EPS_MIN      = 0.05;
const STEP_LIMIT   = 1000;

// ---- Bit helpers ----------------------------------------------------
const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];

function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

function pClass(rk) { return rk <= 1 ? 0 : rk <= 3 ? 1 : 2; }
function bkt(n)     { return n >= 3 ? 3 : n; }
function hdist(n)   { return n<=1?0 : n===2?1 : n<=4?2 : n<=8?3 : 4; }
function pdepth(ps) { const d=ps-1; return d<=0?0 : d<=2?1 : 2; }

// Perspective-neutral encoding: always from 'player' P's point of view
function encodeState(s, P) {
    const h  = s.hands[P];
    const oh = s.hands[1 - P];
    const p2 = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3 = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h&(RM[0]|RM[1])))}|${bkt(pop(h&(RM[2]|RM[3])))}|${bkt(pop(h&(RM[4]|RM[5])))}|${hdist(pop(h))}|${hdist(pop(oh))}|${pdepth(s.pileSize)}|${bkt(pop(oh&(RM[4]|RM[5])))}`;
}

// ---- Action helpers -------------------------------------------------
const ACT_QUAD = 6, ACT_DRAW = 7, N_ACTS = 8;

function moveToAct(m) {
    if (m & DRAW_FLAG) return ACT_DRAW;
    const bits = m & 0xFFFFFF;
    if (pop(bits) >= 3) return ACT_QUAD;
    return (31 - Math.clz32(bits)) >> 2;
}

function actToMove(moves, act) {
    if (act === ACT_DRAW) { for (const m of moves) if (m & DRAW_FLAG) return m; return null; }
    if (act === ACT_QUAD) { for (const m of moves) if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m; return null; }
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        if (pop(m & 0xFFFFFF) === 1 && ((31 - Math.clz32(m & 0xFFFFFF)) >> 2) === act) return m;
    }
    return null;
}

function legalActs(moves) { return [...new Set(moves.map(moveToAct))]; }

// ---- Q-table helpers ------------------------------------------------
function makeTable(base) {
    // Deep-copy a base Map<string, Float64Array> into a fresh Map
    const T = new Map();
    for (const [k, r] of base) T.set(k, new Float64Array(r));
    return T;
}

function qRow(T, key) {
    let r = T.get(key);
    if (!r) { r = new Float64Array(N_ACTS).fill(Infinity); T.set(key, r); }
    return r;
}

function pickAction(T, key, legal, eps) {
    if (Math.random() < eps) return legal[(Math.random() * legal.length) | 0];
    const r = qRow(T, key); let best = legal[0], bv = -Infinity;
    for (const a of legal) { const v = r[a]; if ((isFinite(v)?v:0) > bv) { bv = isFinite(v)?v:0; best = a; } }
    return best;
}

function updateQ(T, key, act, reward, nextKey, nextLegal) {
    const r   = qRow(T, key);
    const cur = isFinite(r[act]) ? r[act] : 0;
    let maxN  = 0;
    if (nextKey && nextLegal.length > 0) {
        const nr = qRow(T, nextKey); maxN = -Infinity;
        for (const a of nextLegal) { const v = isFinite(nr[a]) ? nr[a] : 0; if (v > maxN) maxN = v; }
        if (!isFinite(maxN)) maxN = 0;
    }
    r[act] = cur + ALPHA * (reward + GAMMA * maxN - cur);
}

// ---- Greedy move from a table ---------------------------------------
function greedyMove(T, s, P) {
    const moves = getPossibleMoves(s);
    const key   = encodeState(s, P);
    const legal = legalActs(moves);
    const r     = T.get(key);
    let best = legal[0], bv = -Infinity;
    for (const a of legal) {
        const v = r ? (isFinite(r[a]) ? r[a] : 1e9) : 1e9;
        if (v > bv) { bv = v; best = a; }
    }
    return actToMove(moves, best) ?? moves[0];
}

// ---- Balanced heuristic opponent ------------------------------------
function heuristicBalanced(s) {
    const P = s.currentPlayer;
    const myHand  = s.hands[P];
    const myCount = pop(myHand);
    const oppCount = pop(s.hands[1-P]);
    const moves = getPossibleMoves(s);
    const plays = moves.filter(m => !(m & DRAW_FLAG));
    if (plays.length === 0) return moves[0];
    if (Math.random() < 0.10) return moves[(Math.random() * moves.length)|0];
    const danger   = oppCount < 3;
    const hasLastA = pop(myHand & RM[5]) === 1;
    const hasLastK = pop(myHand & RM[4]) === 1;
    const preserveAK = !danger && myCount >= 4;
    const rankOf = m => (31 - Math.clz32(m & 0xFFFFFF)) >> 2;
    const isQuad = m => pop(m & 0xFFFFFF) === 4;
    const wouldWin = m => pop(myHand & ~(m & 0xFFFFFF)) === 0;
    plays.sort((a, b) => rankOf(a) - rankOf(b));
    let opts = [...plays];
    if (preserveAK) {
        const filtered = opts.filter(m => {
            if (wouldWin(m)) return true;
            const rk = rankOf(m);
            if (hasLastA && rk === 5) return false;
            if (hasLastK && rk === 4) return false;
            return true;
        });
        if (filtered.length > 0) opts = filtered;
    }
    const quad = opts.find(m => isQuad(m));
    if (quad) {
        let minRank = 6;
        for (let rk = 0; rk <= 5; rk++) { if (myHand & RM[rk]) { minRank = rk; break; } }
        if (rankOf(quad) === minRank) return quad;
    }
    if (myCount > 4) {
        const singles = opts.filter(m => pop(m & 0xFFFFFF) === 1);
        if (singles.length > 0) return singles[0];
    }
    return opts[0];
}

// ---- Reward function (parameterised) --------------------------------
// cfg fields:
//   WIN, LOSE             terminal rewards
//   TURN_SCALE            escalating turn penalty coefficient
//   SHED_PER_CARD         reward per card shed
//   BLOCK_LAST, BLOCK_FEW reward for blocking opp's last card / ≤3 cards
//   DRAW_GOOD, DRAW_BAD   draw move rewards for good/bad draws
//   PASSIVITY             penalty for drawing while opp ≤2 cards
//   ACE4                  one-time reward for REACHING 4 aces (transition)
//   ACE0                  one-time penalty for REACHING 0 aces (transition)
//   ENDGAME               one-time reward for ENTERING ≤3 cards + no K/A
//   OPP_END               one-time penalty for opp ENTERING ≤3 cards + no K/A
//
// Transition rewards are applied once per episode per event.

function makeStepReward(cfg, BOT) {
    const opp = 1 - BOT;
    // returns closure that tracks per-episode state
    return function makeEpisodeRewarder() {
        let prevAceBot = -1, prevAceOpp = -1;
        let prevEndBot = false, prevEndOpp = false;
        return function stepReward(prev, move, next) {
            let r = 0;
            const ph = prev.hands[BOT], nh = next.hands[BOT];
            const poh = prev.hands[opp], noh = next.hands[opp];

            if (move & DRAW_FLAG) {
                const drawn = (nh & ~ph) & 0xFFFFFF;
                const p9  = pop(ph & RM[0]);
                const p10 = pop(ph & RM[1]);
                let mask = drawn;
                while (mask) {
                    const lb = mask & (-mask); mask &= ~lb;
                    const rk = (31 - Math.clz32(lb)) >> 2;
                    if (rk === 0) r += (p9 < 3 && pop(nh & RM[0]) >= 3) ? cfg.DRAW_GOOD : cfg.DRAW_BAD;
                    else if (rk === 1) r += (pop(ph & RM[1]) < 4 && pop(nh & RM[1]) >= 4) ? cfg.DRAW_GOOD : cfg.DRAW_BAD * 0.67;
                }
                // 4-of-a-kind completion bonus on draw for J/Q/K/A
                for (let rk = 2; rk <= 5; rk++) {
                    if (pop(ph & RM[rk]) < 4 && pop(nh & RM[rk]) === 4) { r += cfg.DRAW_GOOD; break; }
                }
                // Passivity penalty
                const ot = pop(noh);
                if (ot > 0 && ot <= 2) {
                    for (let rk = next.topRankIdx; rk <= 5; rk++) {
                        if (noh & RM[rk]) { r += cfg.PASSIVITY; break; }
                    }
                }
            } else {
                // Shed reward
                const shed = pop(ph) - pop(nh);
                if (shed > 0) r += shed * cfg.SHED_PER_CARD;
                // Block bonus
                const ot = pop(noh);
                if (ot > 0) {
                    let oppCanPlay = false;
                    for (let rk = next.topRankIdx; rk <= 5; rk++) {
                        if (noh & RM[rk]) { oppCanPlay = true; break; }
                    }
                    if (!oppCanPlay) {
                        if      (ot === 1) r += cfg.BLOCK_LAST;
                        else if (ot <= 3)  r += cfg.BLOCK_FEW;
                    }
                }
            }

            // ---- One-time transition rewards ----------------------------
            const currAceBot = pop(nh  & RM[5]);
            const currAceOpp = pop(noh & RM[5]);

            // Reaching 4 aces (bot collects all aces)
            if (prevAceBot >= 0 && prevAceBot < 4 && currAceBot === 4) r += cfg.ACE4;
            // Losing all aces
            if (prevAceBot > 0  && currAceBot === 0) r += cfg.ACE0;
            // Opponent gains all aces
            if (prevAceOpp >= 0 && prevAceOpp < 4 && currAceOpp === 4) r -= cfg.ACE4 * 0.5;
            // Opponent loses all aces (good for us)
            if (prevAceOpp > 0  && currAceOpp === 0) r -= cfg.ACE0 * 0.5;

            prevAceBot = currAceBot;
            prevAceOpp = currAceOpp;

            // Endgame position: ≤3 cards, no K or A
            const botEnd = pop(nh)  <= 3 && (nh  & (RM[4]|RM[5])) === 0 && pop(nh)  > 0;
            const oppEnd = pop(noh) <= 3 && (noh & (RM[4]|RM[5])) === 0 && pop(noh) > 0;

            if (!prevEndBot && botEnd) r += cfg.ENDGAME;
            if (!prevEndOpp && oppEnd) r += cfg.OPP_END;

            prevEndBot = botEnd;
            prevEndOpp = oppEnd;

            return r;
        };
    };
}

// ---- Train one variant (10k episodes, balanced heuristic opp) ------
function trainVariant(baseTable, cfg) {
    const BOT  = 1;
    const T    = makeTable(baseTable);
    const rewarder = makeStepReward(cfg, BOT);
    const epsDecay = Math.pow(EPS_MIN / EPS_TRAIN, 1 / (TRAIN_EPS * 0.8));
    let eps = EPS_TRAIN;

    for (let ep = 0; ep < TRAIN_EPS; ep++) {
        const getReward = rewarder();
        let s = createInitialState(2);
        let botTurn = 0;

        for (let step = 0; step < STEP_LIMIT; step++) {
            if (isGameOver(s)) break;
            if (s.currentPlayer !== BOT) {
                s = applyMove(s, heuristicBalanced(s));
                continue;
            }

            botTurn++;
            const turnPenalty = -(botTurn * 0.002);
            const key   = encodeState(s, BOT);
            const moves = getPossibleMoves(s);
            const legal = legalActs(moves);
            const act   = pickAction(T, key, legal, eps);
            let conc    = actToMove(moves, act) ?? moves[0];
            const ns    = applyMove(s, conc);

            if (isGameOver(ns)) {
                const termR = getResult(ns, BOT) > 0 ? cfg.WIN : cfg.LOSE;
                updateQ(T, key, act, getReward(s, conc, ns) + termR + turnPenalty, null, []);
                break;
            }

            let ns2 = ns;
            while (!isGameOver(ns2) && ns2.currentPlayer !== BOT)
                ns2 = applyMove(ns2, heuristicBalanced(ns2));

            const sr = getReward(s, conc, ns);

            if (isGameOver(ns2)) {
                const termR = getResult(ns2, BOT) > 0 ? cfg.WIN : cfg.LOSE;
                updateQ(T, key, act, sr + termR + turnPenalty, null, []);
                break;
            }

            const nKey = encodeState(ns2, BOT);
            updateQ(T, key, act, sr + turnPenalty, nKey, legalActs(getPossibleMoves(ns2)));
            s = ns2;
        }
        eps = Math.max(EPS_MIN, eps * epsDecay);
    }
    return T;
}

// ---- Play one match (MATCH_GAMES games, split P0/P1 evenly) ---------
function playMatch(tA, tB) {
    let winsA = 0, winsB = 0;
    const half = MATCH_GAMES / 2;

    for (let g = 0; g < MATCH_GAMES; g++) {
        // First half: A=P1 B=P0   Second half: A=P0 B=P1
        const aIsP1 = g < half;
        const P_A   = aIsP1 ? 1 : 0;
        const P_B   = aIsP1 ? 0 : 1;

        let s = createInitialState(2);
        for (let step = 0; step < STEP_LIMIT; step++) {
            if (isGameOver(s)) break;
            const cur = s.currentPlayer;
            const move = cur === P_A ? greedyMove(tA, s, P_A)
                                     : greedyMove(tB, s, P_B);
            s = applyMove(s, move);
        }

        if (!isGameOver(s)) { /* timeout: neither wins */ }
        else if (getResult(s, P_A) > 0) winsA++;
        else                             winsB++;
    }
    return { winsA, winsB };
}

// ---- 32 variant configurations --------------------------------------
// Each variant tweaks ≥2 parameters from the baseline.
// Baseline: WIN=10, LOSE=-10, TURN_SCALE (used as 0.002 per turn),
//   SHED=0.15, BLOCK_LAST=0.10, BLOCK_FEW=0.06, DRAW_GOOD=0.03,
//   DRAW_BAD=-0.06, PASSIVITY=-0.06
//   + new: ACE4, ACE0, ENDGAME, OPP_END (all 0 in baseline)

const BASE = {
    WIN: 10, LOSE: -10,
    SHED_PER_CARD: 0.15, BLOCK_LAST: 0.10, BLOCK_FEW: 0.06,
    DRAW_GOOD: 0.03, DRAW_BAD: -0.06, PASSIVITY: -0.06,
    ACE4: 0, ACE0: 0, ENDGAME: 0, OPP_END: 0,
};

function v(name, overrides) { return { name, ...BASE, ...overrides }; }

const VARIANTS = [
    // ---- Group A: Terminal reward scaling (8) -----------------------
    v('A1-baseline',       {}),
    v('A2-low-terminal',   { WIN: 5,  LOSE: -5 }),
    v('A3-hi-terminal',    { WIN: 20, LOSE: -20 }),
    v('A4-extreme-term',   { WIN: 50, LOSE: -50 }),
    v('A5-fear-loss',      { WIN: 8,  LOSE: -15 }),
    v('A6-value-win',      { WIN: 15, LOSE: -8  }),
    v('A7-very-low',       { WIN: 3,  LOSE: -1  }),
    v('A8-aggressive-win', { WIN: 25, LOSE: -5  }),

    // ---- Group B: Turn penalty & shaping (8) -----------------------
    v('B1-no-turnpen',     { WIN: 10, LOSE: -10, SHED_PER_CARD: 0.05 }),
    v('B2-slow-pen',       { WIN: 10, LOSE: -10, SHED_PER_CARD: 0.25 }),
    v('B3-big-shed',       { WIN: 10, LOSE: -10, SHED_PER_CARD: 0.40, BLOCK_LAST: 0.20 }),
    v('B4-small-shed',     { WIN: 10, LOSE: -10, SHED_PER_CARD: 0.05, BLOCK_LAST: 0.05 }),
    v('B5-block-heavy',    { WIN: 10, LOSE: -10, BLOCK_LAST: 0.30, BLOCK_FEW: 0.20 }),
    v('B6-no-block',       { WIN: 10, LOSE: -10, BLOCK_LAST: 0, BLOCK_FEW: 0 }),
    v('B7-draw-positive',  { WIN: 10, LOSE: -10, DRAW_GOOD: 0.10, DRAW_BAD: -0.02 }),
    v('B8-draw-painful',   { WIN: 10, LOSE: -10, DRAW_GOOD: 0.01, DRAW_BAD: -0.15, PASSIVITY: -0.15 }),

    // ---- Group C: New transition rewards — aces (8) ----------------
    v('C1-ace-mild',       { ACE4: 0.5,  ACE0: -0.5  }),
    v('C2-ace-moderate',   { ACE4: 1.0,  ACE0: -1.0  }),
    v('C3-ace-strong',     { ACE4: 2.0,  ACE0: -2.0  }),
    v('C4-ace-extreme',    { ACE4: 5.0,  ACE0: -5.0  }),
    v('C5-ace4-only',      { ACE4: 1.5,  ACE0:  0    }),
    v('C6-ace0-only',      { ACE4: 0,    ACE0: -1.5  }),
    v('C7-ace-asym-good',  { ACE4: 3.0,  ACE0: -1.0  }),
    v('C8-ace-asym-fear',  { ACE4: 1.0,  ACE0: -3.0  }),

    // ---- Group D: New transition rewards — endgame (8) -------------
    v('D1-end-mild',       { ENDGAME: 0.5,  OPP_END: -0.5  }),
    v('D2-end-moderate',   { ENDGAME: 1.0,  OPP_END: -1.0  }),
    v('D3-end-strong',     { ENDGAME: 2.0,  OPP_END: -2.0  }),
    v('D4-end-extreme',    { ENDGAME: 5.0,  OPP_END: -5.0  }),
    // ---- Group E: Combinations (4) ---------------------------------
    v('E1-full-new-mild',  { ACE4: 0.5,  ACE0: -0.5, ENDGAME: 0.5,  OPP_END: -0.5  }),
    v('E2-full-new-strong',{ ACE4: 2.0,  ACE0: -2.0, ENDGAME: 2.0,  OPP_END: -2.0,
                             WIN: 15, LOSE: -15 }),
    v('E3-full-balanced',  { ACE4: 1.0,  ACE0: -1.0, ENDGAME: 1.0,  OPP_END: -1.0,
                             SHED_PER_CARD: 0.20, BLOCK_LAST: 0.15 }),
    v('E4-kitchen-sink',   { ACE4: 1.5,  ACE0: -2.0, ENDGAME: 1.5,  OPP_END: -2.0,
                             WIN: 12, LOSE: -12, SHED_PER_CARD: 0.20,
                             BLOCK_LAST: 0.15, PASSIVITY: -0.10 }),
];

// ---- Load base table ------------------------------------------------
console.log(`\nLoading warm table from q-table.json…`);
const saved = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
const BASE_TABLE = new Map();
for (const [k, arr] of Object.entries(saved.table)) {
    const r = new Float64Array(N_ACTS);
    for (let i = 0; i < N_ACTS; i++) r[i] = arr[i] == null ? Infinity : arr[i];
    BASE_TABLE.set(k, r);
}
console.log(`  ${BASE_TABLE.size} states loaded.\n`);

// ---- Train all 32 variants -----------------------------------------
console.log(`Training ${VARIANTS.length} variants (${TRAIN_EPS.toLocaleString()} eps each)…\n`);
const tables = [];
for (let i = 0; i < VARIANTS.length; i++) {
    const cfg = VARIANTS[i];
    process.stdout.write(`  [${String(i+1).padStart(2)}/${VARIANTS.length}] ${cfg.name.padEnd(22)} … `);
    const T = trainVariant(BASE_TABLE, cfg);
    tables.push(T);
    process.stdout.write(`done (${T.size} states)\n`);
}

// ---- Single-elimination tournament ----------------------------------
console.log(`\n${'='.repeat(60)}`);
console.log(`TOURNAMENT  (${MATCH_GAMES} games per match, ${VARIANTS.length} bots)\n`);

let bracket = VARIANTS.map((cfg, i) => ({ cfg, T: tables[i] }));
let round = 1;

while (bracket.length > 1) {
    console.log(`--- Round ${round} (${bracket.length} bots) ---`);
    const next = [];
    for (let i = 0; i < bracket.length; i += 2) {
        const a = bracket[i], b = bracket[i+1];
        if (!b) { console.log(`  ${a.cfg.name.padEnd(22)} — BYE`); next.push(a); continue; }
        const { winsA, winsB } = playMatch(a.T, b.T);
        const winner = winsA >= winsB ? a : b;
        const loser  = winsA >= winsB ? b : a;
        console.log(`  ${a.cfg.name.padEnd(22)} ${String(winsA).padStart(3)}  vs  ${String(winsB).padEnd(3)}  ${b.cfg.name}  → winner: ${winner.cfg.name}`);
        next.push(winner);
        void loser;
    }
    bracket = next;
    round++;
}

const champion = bracket[0].cfg;
console.log(`\n${'='.repeat(60)}`);
console.log(`CHAMPION: ${champion.name}`);
console.log(`\nWinning reward config:`);
for (const [k, val] of Object.entries(champion)) {
    if (k === 'name') continue;
    const base = BASE[k];
    const diff = val !== base ? '  ← changed' : '';
    console.log(`  ${k.padEnd(14)} = ${String(val).padStart(6)}${diff}`);
}
console.log();
