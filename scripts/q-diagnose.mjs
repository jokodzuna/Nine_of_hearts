// scripts/q-diagnose.mjs  — run with: node scripts/q-diagnose.mjs
import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult, DRAW_FLAG } from '../game-logic.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir      = dirname(fileURLToPath(import.meta.url));
const TABLE_PATH = join(__dir, '..', 'q-table.json');

const BOT  = 1;
const STEP_LIMIT = 5000;

// ---- helpers --------------------------------------------------------
function pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

const RM = [0x00000F, 0x0000F0, 0x000F00, 0x00F000, 0x0F0000, 0xF00000];
function bkt(n) { return n >= 3 ? 3 : n; }
function dst(n) { return n <= 1 ? 0 : n === 2 ? 1 : 2; }
function pClass(rk) { return rk <= 1 ? 0 : rk <= 3 ? 1 : 2; }

function encodeState(s) {
    const h  = s.hands[BOT];
    const oh = s.hands[1 - BOT];
    const p2 = s.pileSize >= 2 ? pClass(s.pile[s.pileSize - 2] >> 2) : 3;
    const p3 = s.pileSize >= 3 ? pClass(s.pile[s.pileSize - 3] >> 2) : 3;
    return `${s.topRankIdx}|${p2}|${p3}|${bkt(pop(h & (RM[0]|RM[1])))}|${bkt(pop(h & (RM[2]|RM[3])))}|${bkt(pop(h & (RM[4]|RM[5])))}|${dst(pop(h))}|${dst(pop(oh))}`;
}

function randMove(s) {
    const m = getPossibleMoves(s);
    return m[(Math.random() * m.length) | 0];
}

// ---- load Q-table ---------------------------------------------------
let qtable = null;
try {
    const raw = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
    qtable = raw.table;
    console.log(`Q-table loaded: ${raw.stateCount} states, trained ${raw.episodes} episodes\n`);
} catch (e) {
    console.log('No q-table.json found — Q-bot tests will be skipped\n');
}

const ACT_NAMES = ['PLAY_9','PLAY_10','PLAY_J','PLAY_Q','PLAY_K','PLAY_A','PLAY_QUAD','DRAW'];
const ACT_DRAW  = 7;
const ACT_QUAD  = 6;

function moveToAct(m) {
    if (m & DRAW_FLAG) return ACT_DRAW;
    const bits = m & 0xFFFFFF;
    if (pop(bits) >= 3) return ACT_QUAD;
    return (31 - Math.clz32(bits)) >> 2;
}
function actToMove(moves, act) {
    if (act === ACT_DRAW)  { for (const m of moves) if  (m & DRAW_FLAG) return m; return null; }
    if (act === ACT_QUAD)  { for (const m of moves) if (!(m & DRAW_FLAG) && pop(m & 0xFFFFFF) >= 3) return m; return null; }
    for (const m of moves) {
        if (m & DRAW_FLAG) continue;
        const bits = m & 0xFFFFFF;
        if (pop(bits) === 1 && ((31 - Math.clz32(bits)) >> 2) === act) return m;
    }
    return null;
}

function qbotMove(s) {
    const moves = getPossibleMoves(s);
    if (!qtable) return moves[(Math.random() * moves.length) | 0];
    const key = encodeState(s);
    const row = qtable[key];
    const legal = [...new Set(moves.map(moveToAct))];
    let best = legal[0], bv = -Infinity;
    for (const a of legal) {
        const v = row ? (row[a] ?? Infinity) : Infinity;
        const vf = (v === null || v === undefined) ? Infinity : v;
        if (vf > bv) { bv = vf; best = a; }
    }
    let conc = actToMove(moves, best);
    return conc ?? moves[0];
}

// ---- run games ------------------------------------------------------
function runGames(N, p0fn, p1fn, label) {
    let wins = 0, timeouts = 0, totalSteps = 0;
    const firstMoverWins = [0, 0];   // [p0_went_first_wins, p1_went_first_wins]
    const firstCount     = [0, 0];

    for (let g = 0; g < N; g++) {
        let s = createInitialState(2);
        const starter = s.currentPlayer;    // who goes first
        firstCount[starter]++;

        let step = 0, finished = false;
        while (step++ < STEP_LIMIT) {
            if (isGameOver(s)) { finished = true; break; }
            const fn = s.currentPlayer === 0 ? p0fn : p1fn;
            s = applyMove(s, fn(s));
        }
        totalSteps += step;
        if (!finished) { timeouts++; continue; }

        if (getResult(s, BOT) > 0) {
            wins++;
            firstMoverWins[starter]++;
        }
    }

    const wr     = (wins / N * 100).toFixed(1);
    const toRate = (timeouts / N * 100).toFixed(1);
    const avgLen = (totalSteps / N).toFixed(1);
    console.log(`${label}`);
    console.log(`  wins: ${wins}/${N} = ${wr}%   timeouts: ${timeouts} (${toRate}%)   avg_steps: ${avgLen}`);
    console.log(`  when P0 went first: ${firstMoverWins[0]}/${firstCount[0]} BOT wins = ${(firstMoverWins[0]/firstCount[0]*100).toFixed(1)}%`);
    console.log(`  when P1 went first: ${firstMoverWins[1]}/${firstCount[1]} BOT wins = ${(firstMoverWins[1]/firstCount[1]*100).toFixed(1)}%\n`);
}

const N = 5000;
runGames(N, randMove, randMove,  'Baseline  — random P0 vs random P1 (BOT=P1)');
if (qtable) runGames(N, randMove, qbotMove, 'Q-bot     — random P0 vs Q-bot  P1 (BOT=P1)');

// ---- inspect Q-table top actions per common state -------------------
if (qtable) {
    console.log('--- Q-table: best action per state (top 20 by visit count proxy) ---');
    const entries = Object.entries(qtable)
        .filter(([,v]) => v.some(x => x !== null))
        .slice(0, 20);
    for (const [k, v] of entries) {
        const tried = v.map((x, i) => x !== null ? `${ACT_NAMES[i]}=${x.toFixed(3)}` : null).filter(Boolean);
        const best  = v.reduce((bi, x, i) => (x !== null && (v[bi] === null || x > v[bi])) ? i : bi, 0);
        console.log(`  [${k}]  best=${ACT_NAMES[best]}  tried=${tried.join(' ')}`);
    }
}
