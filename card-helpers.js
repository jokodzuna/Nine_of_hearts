// ============================================================
// card-helpers.js — Card DOM builders and layout calculators
// Nine of Hearts
// ============================================================

import { HUMAN_ID, RANK_IMG, SUIT_IMG } from './constants.js';

// ---- Image path helper ------------------------------------------------------

function _cardImageSrc(rank, suit) {
    return `Images/Cards/${RANK_IMG[rank]}_${SUIT_IMG[suit]}.png`;
}

// ---- Card element builders --------------------------------------------------

/** Creates a face-down card-back element. */
export function createCardBack() {
    const card = document.createElement('div');
    card.className = 'card';
    const back = document.createElement('div');
    back.className = 'card-back';
    card.appendChild(back);
    return card;
}

/**
 * Creates a stacked deck visual used as the deal source during animations.
 * @returns {HTMLElement}
 */
export function createDeckStack() {
    const deck  = document.createElement('div');
    deck.className = 'deal-deck';
    const stack = document.createElement('div');
    stack.className = 'deal-deck-stack';
    for (let i = 0; i < 4; i++) {
        const c = document.createElement('div');
        c.className = 'deal-deck-card card dealt';
        c.style.cssText = 'width:100%;height:100%';
        c.style.setProperty('--deck-scale', String(1 - i * 0.015));
        const back = document.createElement('div');
        back.className = 'card-back';
        c.appendChild(back);
        stack.appendChild(c);
    }
    deck.appendChild(stack);
    return deck;
}

/**
 * Wraps a card element in a .side-card-wrap container for rotated side players.
 * @param {HTMLElement} cardEl
 * @returns {HTMLElement}
 */
export function createSideWrap(cardEl) {
    const wrap = document.createElement('div');
    wrap.className = 'side-card-wrap';
    wrap.appendChild(cardEl);
    return wrap;
}

/**
 * Creates a face-up card element using the card image from Images/Cards/.
 *
 * @param {{rank:string, suit:string}} cardData
 * @param {boolean} interactive — if true, wires up click/drag for the human player
 * @param {{
 *   onToggle?:     (card: HTMLElement) => void,
 *   onMouseDown?:  EventListener,
 *   onTouchStart?: EventListener,
 *   onTouchMove?:  EventListener,
 *   onTouchEnd?:   EventListener,
 * }} handlers — event handlers required when interactive = true
 */
export function createFaceUpCard(cardData, interactive = false, handlers = {}) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.rank = cardData.rank;
    card.dataset.suit = cardData.suit;

    const front = document.createElement('div');
    front.className = 'card-front';

    const img = document.createElement('img');
    img.src       = _cardImageSrc(cardData.rank, cardData.suit);
    img.alt       = `${cardData.rank}${cardData.suit}`;
    img.draggable = false;
    front.appendChild(img);
    card.appendChild(front);

    if (interactive) {
        card.addEventListener('click', e => {
            e.stopPropagation();
            if (e.detail !== 1) return;
            if (handlers.onToggle) handlers.onToggle(card);
        });
        if (handlers.onMouseDown)  card.addEventListener('mousedown',  handlers.onMouseDown);
        if (handlers.onTouchStart) card.addEventListener('touchstart', handlers.onTouchStart, { passive: false });
        if (handlers.onTouchMove)  card.addEventListener('touchmove',  handlers.onTouchMove,  { passive: false });
        if (handlers.onTouchEnd)   card.addEventListener('touchend',   handlers.onTouchEnd);
    }
    return card;
}

// ---- Layout helpers ---------------------------------------------------------

/** Recalculates overlap margin and justify-content for the human player's hand. */
export function updateHandLayout() {
    const hand = document.getElementById(HUMAN_ID);
    if (!hand) return;
    const cards   = hand.querySelectorAll('.card');
    const n       = cards.length;
    const isLand  = window.matchMedia('(orientation: landscape)').matches;
    const first   = cards[0];
    const cardW   = first ? first.getBoundingClientRect().width : 0;
    const areaW   = hand.clientWidth;
    const total   = cardW * n;

    let overlap = 0;
    if (n > 1 && cardW > 0 && areaW > 0 && total > areaW) {
        overlap = Math.max(0, Math.min(cardW - 1, (total - areaW) / (n - 1)));
    }
    document.documentElement.style.setProperty('--your-overlap-margin', `-${overlap}px`);

    if (!isLand) {
        const nearFull  = areaW > 0 && (total / areaW) >= 0.85;
        const leftAlign = overlap > 0 || nearFull;
        hand.style.justifyContent = leftAlign ? 'flex-start' : 'center';
        hand.style.transform = leftAlign
            ? `translateX(-${Math.min(10, Math.round(cardW * 0.08))}px)`
            : 'translateX(0px)';
    } else {
        hand.style.transform = 'translateX(0px)';
    }

    requestAnimationFrame(() => {
        const overflow = hand.scrollWidth - hand.clientWidth;
        if (overflow > 0 && n > 1) {
            const adj = Math.max(0, Math.min(cardW - 1, overlap + overflow / (n - 1) + 1));
            document.documentElement.style.setProperty('--your-overlap-margin', `-${adj}px`);
            if (!isLand) hand.style.justifyContent = 'flex-start';
        }
    });
}

/** Recalculates overlap margin for the top (opponent) player's hand. */
export function updateTopHandLayout() {
    const hand = document.getElementById('player2Cards');
    if (!hand) return;
    const cards = hand.querySelectorAll('.card');
    const n     = cards.length;
    const first = cards[0];
    const cardW = first ? first.getBoundingClientRect().width : 0;
    const areaW = hand.clientWidth;

    let overlap = 0;
    if (n > 1 && cardW > 0 && areaW > 0) {
        const total = cardW * n;
        if (total > areaW) overlap = Math.max(0, Math.min(cardW - 1, (total - areaW) / (n - 1)));
    }
    document.documentElement.style.setProperty('--top-overlap-margin', `-${overlap}px`);
}

/**
 * Dynamically sets the vertical step for left/right side players so cards
 * spread out when few and compress to fit when many.
 *
 * @param {string} playerId  'player1Cards' or 'player3Cards'
 */
export function updateSideHandLayout(playerId) {
    const container = document.getElementById(playerId);
    if (!container) return;
    const wraps = Array.from(container.querySelectorAll('.side-card-wrap'));
    const n = wraps.length;
    if (n < 2) { wraps.forEach(w => { w.style.marginTop = ''; }); return; }

    const wrapH = wraps[0].getBoundingClientRect().height;  // other-card-width in px
    const areaH = container.clientHeight;                   // available height in px
    if (wrapH <= 0 || areaH <= 0) return;

    const maxStep    = (areaH - wrapH) / (n - 1);  // step that exactly fills container
    const maxNatural = wrapH * 0.95;               // max spread: slight overlap (5%), no gaps
    const step       = Math.min(maxNatural, Math.max(0, maxStep));
    const neg        = -(wrapH - step);

    wraps[0].style.marginTop = '0';
    for (let i = 1; i < n; i++) wraps[i].style.marginTop = `${neg}px`;
}
