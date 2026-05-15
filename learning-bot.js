import { ISMCTSEngine } from './ai-engine.js';

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

// Module-level pool — shuffled once per game via LearningBot.prepareGame().
// All bots in the same game share the same iteration count (10 or 20)
// and draw unique names from the shuffled pool.
let _namePool      = [];
let _gameIter      = 10;

function _shuffle(arr) { arr.sort(() => Math.random() - 0.5); }

// ============================================================
// LearningBot — thin wrapper around ISMCTSEngine('newbie')
//               with per-game iteration count (10 or 20)
//               and unique name/avatar per instance
// ============================================================

export class LearningBot {
    constructor() {
        if (_namePool.length === 0) _shuffle(_namePool = [...LEARNING_META]);
        const meta       = _namePool.pop();
        this._name       = meta.name;
        this._avatar     = meta.avatar;
        const profile    = { ...ISMCTSEngine.PROFILES.newbie, maxIterations: _gameIter };
        this._engine     = new ISMCTSEngine(profile);
    }

    /**
     * Call once before creating bots for a new game.
     * Shuffles the name pool and randomly picks 10 or 20 iterations for every
     * bot in this game.
     */
    static prepareGame() {
        _shuffle(_namePool = [...LEARNING_META]);
        _gameIter = Math.random() < 0.5 ? 10 : 20;
    }

    get name()       { return this._name; }
    get avatarPath() { return this._avatar; }

    chooseMove(state)        { return this._engine.chooseMove(state); }
    observeMove(state, move) { this._engine.observeMove(state, move); }
    advanceTree(move)        { this._engine.advanceTree(move); }
    resetKnowledge()         { this._engine.resetKnowledge(); }
    cleanup()                { this._engine.cleanup(); }
}
