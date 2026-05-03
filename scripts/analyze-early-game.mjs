// scripts/analyze-early-game.mjs
// Analyze & optionally patch early-game Q-values in q-table-strategist-mcts.json
//
// The Q-strategist sometimes "plays stupid" at game start: with a large hand
// and shallow pile it keeps drawing instead of shedding low cards (9s/10s).
// This script finds those states and can boost low-card action values.
//
// Usage:
//   node scripts/analyze-early-game.mjs          # analysis only
//   node scripts/analyze-early-game.mjs --patch  # analysis + patch in-place
//   node scripts/analyze-early-game.mjs --patch --boost 15.0  # custom boost
//   node scripts/analyze-early-game.mjs --table q-table-strategist.json

globalThis.window = globalThis.window || { AI_DEBUG: false };

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ---- CLI args -------------------------------------------------------
const PATCH  = process.argv.includes('--patch');
const TABLE  = process.argv.includes('--table')
    ? process.argv[process.argv.indexOf('--table') + 1]
    : 'q-table-strategist-mcts.json';
const BOOST  = process.argv.includes('--boost')
    ? parseFloat(process.argv[process.argv.indexOf('--boost') + 1])
    : 10.0;

const TABLE_PATH = join(__dir, '..', TABLE);

if (!existsSync(TABLE_PATH)) {
    console.error(`Table not found: ${TABLE_PATH}`);
    process.exit(1);
}

const saved = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
const data  = saved.table ?? saved;
const N_ACTS = 8;
const ACT_NAMES = ['9', '10', 'J', 'Q', 'K', 'A', 'quad', 'draw'];

// State key format:
//   topRank|p2|p3|lowBucket|midBucket|myAces|myHandSize|oppHandSize|pileDepth|oppPowerBucket
//
// We consider "early game" states where:
//   - pileDepth is 0 (shallow, ≤1 card below top) or 1 (medium, 2-3 cards)
//   - myHandSize is large (≥7 cards) — we have plenty to shed
//   - topRank is NOT Ace (5) — no need to escalate
//
// In these states, playing 9s (act 0) and 10s (act 1) should be strongly
// preferred over drawing (act 7) or burning power cards (acts 4, 5).

const EARLY_RE = /^([0-4])\|(\d)\|(\d)\|(\d)\|(\d)\|(\d)\|([7-9]|1[0-2])\|(\d{1,2})\|([01])\|(\d)$/;

let totalEarly = 0;
let badStates    = 0;   // low-card actions undervalued vs draw or high cards
let patched      = 0;

function reportState(key, row, reason) {
    const vals = row.map((v, i) => {
        const mark = i <= 1 ? '★' : i >= 4 ? '!' : ' ';
        return `${mark}${ACT_NAMES[i]}=${v == null ? '—' : v.toFixed(2)}`;
    }).join('  ');
    console.log(`  ${key}`);
    console.log(`    ${vals}`);
    if (reason) console.log(`    → ${reason}`);
}

for (const [key, arr] of Object.entries(data)) {
    const m = key.match(EARLY_RE);
    if (!m) continue;
    totalEarly++;

    const row = arr.slice(); // copy
    const topRank = parseInt(m[1], 10);
    const lowBucket = parseInt(m[4], 10);   // count of 9s+10s (bucketed 0-3)
    const midBucket = parseInt(m[5], 10);   // count of Js+Qs (bucketed 0-3)
    const myAces    = parseInt(m[6], 10);

    // Skip states where we have no low cards to shed
    if (lowBucket === 0 && midBucket === 0) continue;

    // Find best action (highest Q-value)
    let bestAct = 7, bestVal = row[7] ?? -Infinity;
    for (let a = 0; a < N_ACTS; a++) {
        const v = row[a] ?? -Infinity;
        if (v > bestVal) { bestVal = v; bestAct = a; }
    }

    // We flag as "bad" if the bot prefers draw (7) or K/A (4,5) over
    // playing available low cards (0,1) when it has a large hand.
    const isBad = (bestAct === 7 || bestAct >= 4)
        && (lowBucket > 0 || midBucket > 0);

    if (!isBad) continue;
    badStates++;

    // Determine which low actions are available and how far behind they are
    const availableLow = [];
    if (lowBucket > 0) { availableLow.push(0); availableLow.push(1); }
    if (midBucket > 0) { availableLow.push(2); availableLow.push(3); }

    const lowBest = Math.max(...availableLow.map(a => row[a] ?? -Infinity));
    const gap     = bestVal - lowBest;

    const reason = `best=${ACT_NAMES[bestAct]}(${bestVal.toFixed(2)})  lowBest=${lowBest.toFixed(2)}  gap=${gap.toFixed(2)}`;

    if (badStates <= 10 || (badStates % 500 === 0)) {
        reportState(key, row, reason);
    }

    if (PATCH) {
        // Boost 9s and 10s (acts 0,1) by BOOST.
        // Boost Js and Qs (acts 2,3) by half BOOST if no low cards.
        const boostLow  = BOOST;
        const boostMid  = BOOST * 0.5;

        for (const a of availableLow) {
            const base = row[a] ?? 0;
            const add  = a <= 1 ? boostLow : boostMid;
            row[a] = base + add;
        }

        // Also slightly penalize draw if it's the current best, to break ties
        if (bestAct === 7) {
            row[7] = (row[7] ?? 0) - (BOOST * 0.3);
        }

        patched++;
        data[key] = row;
    }
}

console.log(`\n=== Early-Game Analysis (${TABLE}) ===`);
console.log(`  Total early-game states (pileDepth 0/1, hand ≥7): ${totalEarly.toLocaleString()}`);
console.log(`  States where draw/K/A beats available low cards: ${badStates.toLocaleString()}`);
console.log(`  Bad ratio: ${(badStates / totalEarly * 100).toFixed(1)}%`);

if (PATCH) {
    console.log(`\n  Patched ${patched} states (boost low cards by +${BOOST}, mid by +${BOOST*0.5}, draw -${(BOOST*0.3).toFixed(1)})`);
    const out = JSON.stringify({ games: saved.games, stateCount: Object.keys(data).length, table: data });
    writeFileSync(TABLE_PATH, out);
    console.log(`  Saved → ${TABLE_PATH}`);
} else {
    console.log(`\n  Run with --patch to fix ${badStates} states (default boost=${BOOST})`);
    console.log(`  Or:  node scripts/analyze-early-game.mjs --patch --boost 20.0`);
}
