// ============================================================
// animations.js — All game animations
// Nine of Hearts
//
// This is the single home for every visual animation in the game.
// Add new animation functions here as the game grows.
//
// Current animations:
//   - animateDealing   (card deal from pile to all players)
// ============================================================

import { HUMAN_ID, SIDE_IDS, DEAL_ORDER } from './constants.js';
import {
    createFaceUpCard,
    createCardBack,
    createSideWrap,
    createDeckStack,
    updateHandLayout,
    updateTopHandLayout,
} from './card-helpers.js';
import { playDealSound } from './audio.js';

// ---- Card interaction handlers (set once by ui-manager after defining them) -

let _cardHandlers = {};

/**
 * Register the event-handler functions that interactive cards need.
 * Call this once from ui-manager.js after all handlers are defined.
 *
 * @param {{
 *   onToggle:     (card: HTMLElement) => void,
 *   onMouseDown:  EventListener,
 *   onTouchStart: EventListener,
 *   onTouchMove:  EventListener,
 *   onTouchEnd:   EventListener,
 * }} handlers
 */
export function setCardHandlers(handlers) {
    _cardHandlers = handlers;
}

// ---- Internal helpers -------------------------------------------------------

/**
 * Calculates the pixel centre of the nth card slot inside a container.
 *
 * @param {HTMLElement} container
 * @param {number}      index   — 0-based slot index
 * @param {number}      total   — total number of cards
 * @param {number}      cardW   — card width in px
 * @param {number}      cardH   — card height in px
 * @param {'x'|'y'}     axis    — direction cards are laid out
 * @returns {{ x: number, y: number }}
 */
function _getTargetPoint(container, index, total, cardW, cardH, axis) {
    const r    = container.getBoundingClientRect();
    const step = total <= 1 ? 0 : axis === 'y'
        ? (r.height - cardH) / (total - 1)
        : (r.width  - cardW) / (total - 1);
    return axis === 'y'
        ? { x: r.left + r.width  / 2,      y: r.top + cardH / 2 + step * index }
        : { x: r.left + cardW / 2 + step * index, y: r.top + r.height / 2 };
}

/**
 * Measures a CSS variable dimension by briefly inserting a probe element.
 *
 * @param {string} wVar — CSS width value, e.g. 'var(--your-card-width)'
 * @param {string} hVar — CSS height value
 * @returns {{ w: number, h: number }}
 */
function _getSizeForVar(wVar, hVar) {
    const probe = document.createElement('div');
    probe.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${wVar};height:${hVar}`;
    document.body.appendChild(probe);
    const r = probe.getBoundingClientRect();
    probe.remove();
    return { w: r.width, h: r.height };
}

// ---- Animations -------------------------------------------------------------

/**
 * Animates cards flying from the pile/deck to each player's container, one
 * card per player per round, in DEAL_ORDER.
 *
 * @param {{ [playerId: string]: Array<{rank:string, suit:string}> }} hands
 * @param {string} humanId — container ID of the local human player
 * @returns {Promise<void>}  Resolves when every card has landed.
 */
export async function animateDealing(hands, humanId = HUMAN_ID) {
    const counts = Object.fromEntries(DEAL_ORDER.map(id => [id, (hands[id] || []).length]));
    const rounds = Math.max(...Object.values(counts));
    const stepMs = 3000 / (rounds * DEAL_ORDER.length);

    const pileEl = document.getElementById('pile');
    const deckEl = createDeckStack();
    pileEl.appendChild(deckEl);
    const or     = pileEl.getBoundingClientRect();
    const origin = { x: or.left + or.width / 2, y: or.top + or.height / 2 };

    const sizeYour  = _getSizeForVar('var(--your-card-width)',   'var(--your-card-height)');
    const sizeOther = _getSizeForVar('var(--other-card-width)',  'var(--other-card-height)');
    const sizeSide  = _getSizeForVar('var(--other-card-height)', 'var(--other-card-width)');

    const promises = [];
    let dealIdx    = 0;

    for (let r = 0; r < rounds; r++) {
        for (const targetId of DEAL_ORDER) {
            const handArr = hands[targetId] || [];
            if (r >= handArr.length) { dealIdx++; continue; }

            const container = document.getElementById(targetId);
            const isHuman   = targetId === humanId;
            const isTop     = targetId === 'player2Cards';
            const isSide    = SIDE_IDS.has(targetId);
            const cardData  = handArr[r];
            const cardW     = isHuman ? sizeYour.w : sizeOther.w;
            const cardH     = isHuman ? sizeYour.h : sizeOther.h;
            const axis      = (isHuman || isTop) ? 'x' : 'y';
            const tSize     = isSide ? sizeSide : { w: cardW, h: cardH };
            const point     = _getTargetPoint(container, r, counts[targetId], tSize.w, tSize.h, axis);
            const atMs      = dealIdx * stepMs
                + Math.floor(dealIdx / DEAL_ORDER.length) * 40
                + (dealIdx % DEAL_ORDER.length) * 10;

            const p = new Promise(resolve => {
                setTimeout(() => {
                    playDealSound();

                    const fly = document.createElement('div');
                    fly.className = 'deal-fly';
                    fly.style.cssText = `width:${cardW}px;height:${cardH}px;left:${origin.x - cardW / 2}px;top:${origin.y - cardH / 2}px`;
                    const flyCard = document.createElement('div');
                    flyCard.className = 'card dealt';
                    flyCard.style.cssText = 'width:100%;height:100%';
                    const back = document.createElement('div');
                    back.className = 'card-back';
                    flyCard.appendChild(back);
                    fly.appendChild(flyCard);
                    document.body.appendChild(fly);

                    const anim = fly.animate([
                        { transform: 'translate(0,0)', opacity: 1 },
                        { transform: `translate(${point.x - origin.x}px,${point.y - origin.y}px)`, opacity: 1 },
                    ], { duration: 220, easing: 'cubic-bezier(0.25,0.46,0.45,0.94)' });

                    anim.onfinish = () => {
                        fly.remove();
                        const finalCard = isHuman
                            ? createFaceUpCard(cardData, true, _cardHandlers)
                            : createCardBack();
                        finalCard.classList.add('dealt');
                        if (isSide) {
                            const wrap = createSideWrap(finalCard);
                            container[targetId === 'player1Cards' ? 'insertBefore' : 'appendChild'](
                                wrap, targetId === 'player1Cards' ? container.firstChild : undefined
                            );
                        } else {
                            container.appendChild(finalCard);
                        }
                        if (isHuman) requestAnimationFrame(() => requestAnimationFrame(updateHandLayout));
                        if (isTop)   requestAnimationFrame(() => requestAnimationFrame(updateTopHandLayout));
                        resolve();
                    };
                }, atMs);
            });
            promises.push(p);
            dealIdx++;
        }
    }

    await Promise.all(promises);
    deckEl.remove();
    requestAnimationFrame(() => {
        requestAnimationFrame(updateHandLayout);
        requestAnimationFrame(updateTopHandLayout);
    });
}
