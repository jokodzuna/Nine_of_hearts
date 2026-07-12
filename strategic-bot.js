import { ISMCTSEngine }              from './ai-engine.js';
import { getPossibleMoves }           from './game-logic.js';
import { applyNineHeartsGuard,
         applyLowPileDrawGuard,
         applyAntiHumanPressure }     from './bot-guards.js';

// ============================================================
// StrategicBot metadata
// ============================================================

const STRATEGIC_META = [
    { name: 'Argon',   avatar: 'Images/bot-avatars/strategic/Argon.webp'   },
    { name: 'Cobalt',  avatar: 'Images/bot-avatars/strategic/Cobalt.webp'  },
    { name: 'Iridium', avatar: 'Images/bot-avatars/strategic/Iridium.webp' },
    { name: 'Radon',   avatar: 'Images/bot-avatars/strategic/Radon.webp'   },
    { name: 'Thallium',avatar: 'Images/bot-avatars/strategic/Thallium.webp'},
];

// Module-level pool — shuffled once per game via StrategicBot.prepareGame().
let _namePool = [];

function _shuffle(arr) { arr.sort(() => Math.random() - 0.5); }

// ============================================================
// StrategicBot — ISMCTSEngine('mctsAce50') with hardwired
//               Nine-of-Hearts and low-pile-draw safeguards
// ============================================================

export class StrategicBot {
    constructor() {
        if (_namePool.length === 0) _shuffle(_namePool = [...STRATEGIC_META]);
        const meta       = _namePool.pop();
        this._name       = meta.name;
        this._avatar     = meta.avatar;
        this._engine = new ISMCTSEngine('mctsAce50');
    }

    static prepareGame() {
        _shuffle(_namePool = [...STRATEGIC_META]);
    }

    get name()       { return this._name; }
    get avatarPath() { return this._avatar; }

    chooseMove(state) {
        const moves = getPossibleMoves(state);
        let   move  = this._engine.chooseMove(state);
        move = applyNineHeartsGuard(state, move, moves);
        move = applyLowPileDrawGuard(state, move, moves, this._engine);
        move = applyAntiHumanPressure(state, move, moves);
        return move;
    }

    observeMove(state, move) { this._engine.observeMove(state, move); }
    advanceTree(move)        { this._engine.advanceTree(move); }
    resetKnowledge()         { this._engine.resetKnowledge(); }
    cleanup()                { this._engine.cleanup(); }
}
