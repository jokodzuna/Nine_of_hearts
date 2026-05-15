// ============================================================
// clueless-bot.js — Simple personality-based bots for Clueless difficulty
//
// Each CluelessBot picks one of 8 personalities randomly at the start of
// each game and sticks with it for the entire game.
//
// Personalities:
//   lowest      — always plays the lowest legal card
//   highest     — always plays the highest legal card
//   random      — picks any legal move at random (including draw)
//   alternator  — alternates between lowest and highest each move
//   hoarder     — draws 50% of the time; coin flip lowest/highest otherwise.
//                 Switches to pure coin flip once only 2 players are active.
//   copycat     — copies player 0's last move: draws if they drew; plays the
//                 same rank if legal, else the closest legal higher rank.
//   panicker    — plays highest if the next active player has <=3 cards,
//                 otherwise plays lowest.
//   cautious    — coin flip lowest/highest but avoids Kings while lower cards
//                 exist in hand, and avoids Aces unless hand is all Aces.
//
// Public API (same shape as ISMCTSEngine / HeuristicBot):
//   observeMove(state, move)
//   advanceTree(move)
//   resetKnowledge()
//   cleanup()
//   chooseMove(state)
// ============================================================

import { getPossibleMoves, DRAW_FLAG, RANK_MASK } from './game-logic.js';

// ---- Bit helpers -------------------------------------------------------

function _pop(x) {
    x = x - ((x >>> 1) & 0x555555);
    x = (x & 0x333333) + ((x >>> 2) & 0x333333);
    return (Math.imul((x + (x >>> 4)) & 0x0F0F0F, 0x010101) >>> 16) & 0xFF;
}

/** Rank index (0-5) of a play-move bitmask (all cards share the same rank). */
function _rankIdx(moveBits) {
    const lb = moveBits & (-moveBits);
    return (31 - Math.clz32(lb)) >> 2;
}

// ---- Move selectors ----------------------------------------------------

function _lowestMove(playMoves) {
    let best = playMoves[0], bRank = _rankIdx(best & 0xFFFFFF);
    for (const m of playMoves) {
        const r = _rankIdx(m & 0xFFFFFF);
        if (r < bRank) { bRank = r; best = m; }
    }
    return best;
}

function _highestMove(playMoves) {
    let best = playMoves[0], bRank = _rankIdx(best & 0xFFFFFF);
    for (const m of playMoves) {
        const r = _rankIdx(m & 0xFFFFFF);
        if (r > bRank) { bRank = r; best = m; }
    }
    return best;
}

function _coinFlip(playMoves) {
    return Math.random() < 0.5 ? _lowestMove(playMoves) : _highestMove(playMoves);
}

// ---- Personality metadata ---------------------------------------------

const PERSONALITY_META = {
    lowest:     { name: 'Bot Tom',      avatar: 'Images/bot-avatars/clueless/Bot-Tom.webp'      },
    highest:    { name: 'B-Bot',        avatar: 'Images/bot-avatars/clueless/B-bot.webp'        },
    random:     { name: 'Bot Ox',       avatar: 'Images/bot-avatars/clueless/Bot-Ox.webp'       },
    alternator: { name: 'Sir Spamalot', avatar: 'Images/bot-avatars/clueless/Sir-Spamalot.webp' },
    hoarder:    { name: 'Botty',        avatar: 'Images/bot-avatars/clueless/Botty.webp'        },
    copycat:    { name: 'Baby Bot',     avatar: 'Images/bot-avatars/clueless/Baby-Bot.webp'     },
    panicker:   { name: 'Bot TLE-1',    avatar: 'Images/bot-avatars/clueless/Bot-TLE-1.webp'   },
    cautious:   { name: 'Ro Bot',       avatar: 'Images/bot-avatars/clueless/Ro-Bot.webp'      },
};

const PERSONALITIES = Object.keys(PERSONALITY_META);

// Module-level pool — shuffled once per game via CluelessBot.prepareGame().
// Ensures all bots in the same game get distinct personalities.
let _pool = [];
function _nextPersonality() {
    if (_pool.length === 0) _pool = [...PERSONALITIES].sort(() => Math.random() - 0.5);
    return _pool.pop();
}

// ============================================================
// CluelessBot
// ============================================================

export class CluelessBot {
    constructor() {
        this._personality       = _nextPersonality();
        this._altFlag           = false;  // alternator state
        this._lastObservedMoves = {};     // pid => last move (for copycat)
        this._myId              = null;   // discovered on first chooseMove call
    }

    /** Call once before creating bots for a new game to ensure unique personalities. */
    static prepareGame() {
        _pool = [...PERSONALITIES].sort(() => Math.random() - 0.5);
    }

    get name()       { return PERSONALITY_META[this._personality].name; }
    get avatarPath() { return PERSONALITY_META[this._personality].avatar; }

    // ----------------------------------------------------------
    // Protocol
    // ----------------------------------------------------------

    resetKnowledge() {
        // Personality is fixed at construction — only reset behavioural state.
        this._altFlag           = false;
        this._lastObservedMoves = {};
        this._myId              = null;
    }

    observeMove(state, move) {
        this._lastObservedMoves[state.currentPlayer] = move;
    }

    advanceTree() { /* no tree */ }
    cleanup()     { /* no resources */ }

    // ----------------------------------------------------------
    // Main decision
    // ----------------------------------------------------------

    chooseMove(state) {
        if (this._myId === null) this._myId = state.currentPlayer;

        const moves     = getPossibleMoves(state);
        if (moves.length === 1) return moves[0];

        const playMoves = moves.filter(m => !(m & DRAW_FLAG));
        const drawMove  = moves.find(m =>  !!(m & DRAW_FLAG)) ?? null;

        if (playMoves.length === 0) return drawMove ?? moves[0];

        switch (this._personality) {

            // ---- 1. Lowest ------------------------------------------
            case 'lowest':
                return _lowestMove(playMoves);

            // ---- 2. Highest -----------------------------------------
            case 'highest':
                return _highestMove(playMoves);

            // ---- 3. Random ------------------------------------------
            case 'random':
                return moves[Math.floor(Math.random() * moves.length)];

            // ---- 4. Alternator --------------------------------------
            case 'alternator': {
                const m = this._altFlag ? _highestMove(playMoves) : _lowestMove(playMoves);
                this._altFlag = !this._altFlag;
                return m;
            }

            // ---- 5. Hoarder -----------------------------------------
            case 'hoarder': {
                const active = [];
                for (let p = 0; p < state.numPlayers; p++) {
                    if (!(state.eliminated & (1 << p))) active.push(p);
                }
                if (active.length <= 2) {
                    return _coinFlip(playMoves);
                }
                if (drawMove && Math.random() < 0.5) return drawMove;
                return _coinFlip(playMoves);
            }

            // ---- 6. Copycat -----------------------------------------
            case 'copycat': {
                const lastMove = this._lastObservedMoves[0]; // player 0 = human
                if (lastMove === undefined) return _lowestMove(playMoves);

                if (lastMove & DRAW_FLAG) {
                    return drawMove ?? _lowestMove(playMoves);
                }

                const targetRank = _rankIdx(lastMove & 0xFFFFFF);

                const sameRank = playMoves.filter(m => _rankIdx(m & 0xFFFFFF) === targetRank);
                if (sameRank.length > 0) return sameRank[0];

                const higher = playMoves
                    .filter(m => _rankIdx(m & 0xFFFFFF) > targetRank)
                    .sort((a, b) => _rankIdx(a & 0xFFFFFF) - _rankIdx(b & 0xFFFFFF));
                if (higher.length > 0) return higher[0];

                return _lowestMove(playMoves);
            }

            // ---- 7. Panicker ----------------------------------------
            case 'panicker': {
                let nextP = (state.currentPlayer + 1) % state.numPlayers;
                let iters = 0;
                while (nextP !== state.currentPlayer
                    && (state.eliminated & (1 << nextP))
                    && iters++ < state.numPlayers) {
                    nextP = (nextP + 1) % state.numPlayers;
                }
                if (nextP === state.currentPlayer) return _lowestMove(playMoves);
                const nextCards = _pop(state.hands[nextP]);
                return nextCards <= 3 ? _highestMove(playMoves) : _lowestMove(playMoves);
            }

            // ---- 8. Cautious ----------------------------------------
            case 'cautious': {
                const myHand   = state.hands[state.currentPlayer];
                const aceCount = _pop(myHand & RANK_MASK[5]);
                const onlyAces = _pop(myHand) === aceCount;
                const hasLowerThanKing = [0, 1, 2, 3].some(r => _pop(myHand & RANK_MASK[r]) > 0);

                let candidates = playMoves;

                if (hasLowerThanKing) {
                    const noKA = candidates.filter(m => _rankIdx(m & 0xFFFFFF) < 4);
                    if (noKA.length > 0) candidates = noKA;
                }

                if (!onlyAces) {
                    const noA = candidates.filter(m => _rankIdx(m & 0xFFFFFF) < 5);
                    if (noA.length > 0) candidates = noA;
                }

                return _coinFlip(candidates);
            }

            default:
                return _lowestMove(playMoves);
        }
    }
}
