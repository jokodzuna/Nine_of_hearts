// ============================================================
// animations.js — All game animations
// Nine of Hearts
//
// This is the single home for every visual animation in the game.
// Add new animation functions here as the game grows.
//
// Current animations:
//   - animateDealing          (card deal from pile to all players)
//   - triggerFourOfAKindRipple (3-ring pulse on the pile when a quad is played)
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
import { playDealSound, playSubwooferBlast } from './audio.js';

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

// ---- Four-of-a-kind pile slam ----------------------------------------------

/** Active slam timeline — tracked so a rapid re-trigger resets cleanly. */
let _activeTl = null;

/**
 * Pile compress → hold → spring-back sequence on four-of-a-kind.
 * Requires GSAP loaded globally via script tag (gsap.min.js).
 *
 * @param {HTMLElement} pileEl
 */
export function triggerFourOfAKindRipple(pileEl, type = 'four') {
    if (!pileEl || typeof gsap === 'undefined') return;

    const gameTable = document.querySelector('.game-table');

    if (_activeTl) {
        _activeTl.kill();
        gsap.set(pileEl, { clearProps: 'transform,boxShadow' });
        if (gameTable) gameTable.classList.remove('board-shaking');
    }

    gsap.set(pileEl, { transformOrigin: '50% 50%' });

    const tl = gsap.timeline({
        onComplete() {
            gsap.set(pileEl, { clearProps: 'transform,boxShadow' });
            _activeTl = null;
        },
    });
    _activeTl = tl;

    // Stage 1 — press into felt
    tl.to(pileEl, {
        scale:     0.92,
        boxShadow: '0 1px 4px rgba(0,0,0,0.8)',
        duration:  0.175,
        ease:      'power2.in',
    });

    // Subwoofer blast + vibration at hold moment (end of Stage 1 / start of Stage 2)
    tl.call(() => {
        playSubwooferBlast();
        if (navigator.vibrate) navigator.vibrate([30, 20, 80, 20, 150]);
    });

    // Stage 2 — hold
    tl.to(pileEl, { duration: 0.075 });

    // ── springBack label ─────────────────────────────────────────────────
    tl.addLabel('springBack');

    // Stage 3 — spring back with overshoot (at springBack)
    tl.to(pileEl, {
        scale:     1.0,
        boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        duration:  0.45,
        ease:      'back.out(2)',
    }, 'springBack');

    // "FOUR OF A KIND!" message — springs in right as pile finishes rebounding
    tl.call(() => {
        const r  = pileEl.getBoundingClientRect();
        const msg = document.createElement('div');
        msg.className = 'fourofakind-msg';
        msg.innerHTML = type === 'three-nines' ? 'THREE<br>NINES' : 'FOUR OF<br>A KIND!';
        msg.style.left = `${r.left + r.width / 2}px`;
        msg.style.top  = `${r.top  + r.height / 2}px`;
        msg.style.animation = 'fourofakind-spring 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards';
        document.body.appendChild(msg);
        setTimeout(() => {
            msg.style.animation = 'fourofakind-fade 0.15s ease-in forwards';
            setTimeout(() => msg.remove(), 150);
        }, 800);
    }, [], 'springBack+=0.45');

    // Board shake — CSS animation triggered at springBack via tl.call
    if (gameTable) {
        tl.call(() => {
            gameTable.classList.remove('board-shaking'); // force re-trigger if already shaking
            void gameTable.offsetWidth;                  // reflow to restart animation
            gameTable.classList.add('board-shaking');
            gameTable.addEventListener(
                'animationend',
                () => gameTable.classList.remove('board-shaking'),
                { once: true }
            );
        }, [], 'springBack');
    }
}

// ---- Draw flight animation --------------------------------------------------

/**
 * Spawn card-back clones at the pile top and animate them flying to the
 * drawing player's hand container with a wind-blown arc.
 *
 * @param {HTMLElement} pileEl   — the #pile element
 * @param {number}      count   — number of cards drawn (1–3)
 * @param {string}      playerId — destination container ID
 */
export function triggerDrawFlight(pileEl, count, playerId) {
    if (!pileEl || !playerId || typeof gsap === 'undefined') return;
    const destEl = document.getElementById(playerId);
    if (!destEl) return;

    // Source: top card of pile; destination: centre of hand container
    const srcEl = pileEl.lastElementChild ?? pileEl;
    const srcR  = srcEl.getBoundingClientRect();
    const dstR  = destEl.getBoundingClientRect();
    const srcX  = srcR.left  + srcR.width  / 2;
    const srcY  = srcR.top   + srcR.height / 2;
    const dstX  = dstR.left  + dstR.width  / 2;
    const dstY  = dstR.top   + dstR.height / 2;
    const cardW = srcR.width  || 52;
    const cardH = srcR.height || 74;

    // Compute end scale: shrink clone from pile-card size down to hand-card size
    const handCard = destEl.querySelector('.card');
    const dstCardW = handCard ? handCard.getBoundingClientRect().width : cardW * 0.6;
    const endScale = Math.min(1, dstCardW / cardW);  // never scale up

    // Perpendicular bow so the arc is always natural regardless of flight direction
    const dx  = dstX - srcX, dy = dstY - srcY;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const bowX = (-dy / len) * 55;
    const bowY = ( dx / len) * 55;

    for (let i = 0; i < count; i++) {
        const drift = (Math.random() - 0.5) * 60;  // per-card wind wobble
        const rot   = (Math.random() - 0.5) * 30;  // mid-flight tilt

        const clone = createCardBack();
        clone.classList.add('dealt');
        clone.style.cssText = `position:fixed;left:${srcX - cardW / 2}px;top:${srcY - cardH / 2}px;` +
                              `width:${cardW}px;height:${cardH}px;z-index:200;pointer-events:none;transition:none;`;
        document.body.appendChild(clone);
        gsap.set(clone, { scale: 1, x: 0, y: 0, rotation: 0, transformOrigin: '50% 50%' });

        // GSAP x/y are transform offsets relative to the CSS left/top origin
        const midX = (dstX - srcX) / 2 + bowX + drift;
        const midY = (dstY - srcY) / 2 + bowY;
        const endX = dstX - srcX;
        const endY = dstY - srcY;

        const tl = gsap.timeline({ delay: i * 0.08, onComplete: () => clone.remove() });
        tl.to(clone, { x: midX, y: midY, rotation: rot,  scale: 1.05,     duration: 0.25, ease: 'power1.out' });
        tl.to(clone, { x: endX, y: endY, rotation:   0,  scale: endScale,  duration: 0.25, ease: 'power2.in'  });
    }
}

// ---- Deal animation ---------------------------------------------------------

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
