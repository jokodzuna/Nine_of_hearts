// scripts/bf-benchmark.mjs
// Head-to-head: BotfatherBot (strategist2-botfather.js) vs Strategist2Bot (baseline).
// Seats alternate every game so first-mover advantage cancels out.
//
// Usage:  node scripts/bf-benchmark.mjs [games]
//   e.g.  node scripts/bf-benchmark.mjs 1000
//
// Win rate > 50 % means BotfatherBot is stronger than the baseline.
// Use this before and after rule changes to verify net improvement.

globalThis.window = globalThis.window || { AI_DEBUG: false };

import { createInitialState, getPossibleMoves, applyMove,
         isGameOver, getResult } from '../game-logic.js';
import { BotfatherBot }  from '../strategist2-botfather.js';
import { Strategist2Bot } from '../strategist2-bot.js';

const N_GAMES   = parseInt(process.argv.find(a => /^\d+$/.test(a)) ?? '1000', 10);
const STEP_LIMIT = 10000;
const LOG_EVERY  = 100;

const bf   = new BotfatherBot();
const base = new Strategist2Bot();

let bfWins = 0, baseWins = 0, ties = 0;

console.log(`\nBotfatherBot vs Strategist2Bot (baseline)   n=${N_GAMES}\n`);

for (let g = 1; g <= N_GAMES; g++) {
    // Alternate seats: even games BF=P0, odd games BF=P1
    const bfSeat   = g % 2 === 0 ? 0 : 1;
    const baseSeat = 1 - bfSeat;

    bf.resetKnowledge?.();
    base.resetKnowledge?.();
    let s = createInitialState(2);

    for (let step = 0; step < STEP_LIMIT; step++) {
        if (isGameOver(s)) break;
        const isBF = (s.currentPlayer === bfSeat);
        const bot  = isBF ? bf : base;
        const move = bot.chooseMove(s);
        bf.observeMove?.(s, move);
        base.observeMove?.(s, move);
        s = applyMove(s, move);
    }

    if (!isGameOver(s)) {
        ties++;
    } else if (getResult(s, bfSeat) > 0) {
        bfWins++;
    } else {
        baseWins++;
    }

    if (g % LOG_EVERY === 0) {
        const played = g - ties;
        const bfPct   = played > 0 ? (bfWins   / played * 100).toFixed(1) : '-';
        const basePct = played > 0 ? (baseWins / played * 100).toFixed(1) : '-';
        process.stdout.write(
            `  game ${String(g).padStart(5)}` +
            `  BF: ${String(bfWins).padStart(4)} (${bfPct}%)` +
            `  Base: ${String(baseWins).padStart(4)} (${basePct}%)` +
            `  ties: ${ties}\n`
        );
    }
}

const played = N_GAMES - ties;
console.log(`\n=== Final (${N_GAMES} games, ${ties} ties excluded) ===`);
console.log(`  BotfatherBot   wins : ${bfWins}  (${(bfWins   / played * 100).toFixed(1)}%)`);
console.log(`  Strategist2Bot wins : ${baseWins}  (${(baseWins / played * 100).toFixed(1)}%)`);
if (ties) console.log(`  Step-limit draws    : ${ties}`);
