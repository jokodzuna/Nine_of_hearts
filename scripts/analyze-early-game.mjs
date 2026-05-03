// scripts/analyze-early-game.mjs
// Targeted early-game Q-table patch — only fixes clear mistakes.
//
// "Bad" criteria (ALL must hold):
//   1. Large hand (≥7 cards), shallow pile (depth 0/1)
//   2. Bot picks DRAW (act 7) — almost always wrong when you have cards to play
//   3. Available low cards (9/10) are within gap < 8 — close enough that it's
//      probably noise/tiebreak, not a genuine strategic insight
//
// We DON'T patch:
//   - K/A being best — those can be legitimate tempo plays
//   - States where low-card Q is far below draw (< -8) — suggests genuine bad outcome
//   - Mid-cards (J/Q) only available — those aren't always wrong to hold
//
// Usage:
//   node scripts/analyze-early-game.mjs              # analysis only
//   node scripts/analyze-early-game.mjs --patch      # patch in-place
//   node scripts/analyze-early-game.mjs --patch --boost 5.0
//   node scripts/analyze-early-game.mjs --table q-table-strategist.json

globalThis.window = globalThis.window || { AI_DEBUG: false };

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

const PATCH  = process.argv.includes('--patch');
const TABLE  = process.argv.includes('--table')
    ? process.argv[process.argv.indexOf('--table') + 1]
    : 'q-table-strategist-mcts.json';
const BOOST  = process.argv.includes('--boost')
    ? parseFloat(process.argv[process.argv.indexOf('--boost') + 1])
    : 5.0;   // conservative default

const TABLE_PATH = join(__dir, '..', TABLE);

if (!existsSync(TABLE_PATH)) {
    console.error(`Table not found: ${TABLE_PATH}`);
    process.exit(1);
}

const saved = JSON.parse(readFileSync(TABLE_PATH, 'utf8'));
const data  = saved.table ?? saved;
const N_ACTS = 8;
const ACT_NAMES = ['9', '10', 'J', 'Q', 'K', 'A', 'quad', 'draw'];

// topRank(0-4)|p2|p3|lowBucket|midBucket|myAces|myHandSize(7+)|oppHandSize|pileDepth(0/1)|oppPowerBucket
const EARLY_RE = /^([0-4])\|(\d)\|(\d)\|(\d)\|(\d)\|(\d)\|([7-9]|1[0-2])\|(\d{1,2})\|([01])\|(\d)$/;

const GAP_THRESHOLD = 8.0;   // only patch if draw barely beats low cards

let totalEarly = 0;
let trulyBad   = 0;
let patched    = 0;

function reportState(key, row, reason) {
    const vals = row.map((v, i) => {
        const mark = i <= 1 ? '★' : i === 7 ? '!' : ' ';
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

    const row       = arr.slice();
    const lowBucket = parseInt(m[4], 10);
    const midBucket = parseInt(m[5], 10);

    // Need actual low cards (9/10) — mid cards alone don't trigger this
    if (lowBucket === 0) continue;

    // Find best action and its value
    let bestAct = 7, bestVal = row[7] ?? -Infinity;
    for (let a = 0; a < N_ACTS; a++) {
        const v = row[a] ?? -Infinity;
        if (v > bestVal) { bestVal = v; bestAct = a; }
    }

    // ONLY flag if best action is DRAW — that's the clear mistake.
    // K/A being best with low cards available is often legitimate tempo.
    if (bestAct !== 7) continue;

    // Find best low-card value
    const lowVals = [];
    if (lowBucket > 0) { lowVals.push(row[0]); lowVals.push(row[1]); }
    const lowBest = Math.max(...lowVals.map(v => v ?? -Infinity));
    const gap     = bestVal - lowBest;

    // If low cards are genuinely terrible (gap > 8), don't patch — trust the table
    if (gap > GAP_THRESHOLD) continue;

    trulyBad++;

    const reason = `draw=${bestVal.toFixed(2)}  lowBest=${lowBest.toFixed(2)}  gap=${gap.toFixed(2)}`;
    if (trulyBad <= 10 || (trulyBad % 200 === 0)) {
        reportState(key, row, reason);
    }

    if (PATCH) {
        // Nudge 9s/10s up by a small amount, and draw down slightly
        for (const a of [0, 1]) {
            if (lowBucket > 0) {
                row[a] = (row[a] ?? 0) + BOOST;
            }
        }
        row[7] = (row[7] ?? 0) - (BOOST * 0.2);
        patched++;
        data[key] = row;
    }
}

console.log(`\n=== Early-Game Analysis (${TABLE}) ===`);
console.log(`  Total early-game states (pileDepth 0/1, hand ≥7): ${totalEarly.toLocaleString()}`);
console.log(`  States where DRAW barely beats available 9/10 (gap ≤ ${GAP_THRESHOLD}): ${trulyBad.toLocaleString()}`);
console.log(`  Bad ratio: ${(trulyBad / totalEarly * 100).toFixed(1)}%`);

if (PATCH) {
    console.log(`\n  Patched ${patched} states (9/10 +${BOOST}, draw -${(BOOST*0.2).toFixed(1)})`);
    const out = JSON.stringify({ games: saved.games, stateCount: Object.keys(data).length, table: data });
    writeFileSync(TABLE_PATH, out);
    console.log(`  Saved → ${TABLE_PATH}`);
} else {
    console.log(`\n  Run with --patch to fix ${trulyBad} states (default boost=${BOOST})`);
    console.log(`  Or:  node scripts/analyze-early-game.mjs --patch --boost 3.0`);
}
