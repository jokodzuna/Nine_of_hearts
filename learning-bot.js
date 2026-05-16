import { ISMCTSEngine }                     from './ai-engine.js';
import { getPossibleMoves }                  from './game-logic.js';
import { applyNineHeartsGuard,
         applyLowPileDrawGuard }             from './bot-guards.js';

// ============================================================
// Learning Bot metadata
// ============================================================

const LEARNING_META = [
    { name: 'Bob', avatar: 'Images/bot-avatars/learning/Bob.webp' },
    { name: 'Dom', avatar: 'Images/bot-avatars/learning/Dom.webp' },
    { name: 'Jon', avatar: 'Images/bot-avatars/learning/Jon.webp' },
    { name: 'Rob', avatar: 'Images/bot-avatars/learning/Rob.webp' },
    { name: 'Sam', avatar: 'Images/bot-avatars/learning/Sam.webp' },
];

const ITERATIONS = 100;

// Module-level pool — shuffled once per game via LearningBot.prepareGame().
let _namePool = [];

function _shuffle(arr) { arr.sort(() => Math.random() - 0.5); }

// ============================================================
// LearningBot — thin wrapper around ISMCTSEngine('newbie')
//               at ITERATIONS iterations with unique name/avatar per instance
// ============================================================

export class LearningBot {
    constructor() {
        if (_namePool.length === 0) _shuffle(_namePool = [...LEARNING_META]);
        const meta       = _namePool.pop();
        this._name       = meta.name;
        this._avatar     = meta.avatar;
        const profile    = { ...ISMCTSEngine.PROFILES.newbie, maxIterations: ITERATIONS };
        this._engine     = new ISMCTSEngine(profile);
    }

    /**
     * Call once before creating bots for a new game.
     * Shuffles the name pool so every bot in this game gets a unique name.
     */
    static prepareGame() {
        _shuffle(_namePool = [...LEARNING_META]);
    }

    get name()       { return this._name; }
    get avatarPath() { return this._avatar; }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        let   move  = this._engine.chooseMove(state);
        move = applyNineHeartsGuard(state, move, moves);
        move = applyLowPileDrawGuard(state, move, moves, this._engine);
        return move;
    }
    observeMove(state, move) { this._engine.observeMove(state, move); }
    advanceTree(move)        { this._engine.advanceTree(move); }
    resetKnowledge()         { this._engine.resetKnowledge(); }
    cleanup()                { this._engine.cleanup(); }
}
