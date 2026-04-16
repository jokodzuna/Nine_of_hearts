// ============================================================
// audio.js — All synthesised game audio
// Nine of Hearts
// ============================================================

let _audioCtx = null;
let _welcomeSoundPending = false;
let _lastDealSoundAt = 0;

// ---- Haptic state -----------------------------------------------------------

const _LS_HAPTIC_KEY = 'nhHapticEnabled';
let _hapticEnabled = localStorage.getItem(_LS_HAPTIC_KEY) !== 'false';

export function isHapticEnabled() { return _hapticEnabled; }

export function setHapticEnabled(v) {
    _hapticEnabled = !!v;
    try { localStorage.setItem(_LS_HAPTIC_KEY, String(_hapticEnabled)); } catch {}
}

export function triggerHaptic(type) {
    if (!_hapticEnabled || !navigator.vibrate) return;
    switch (type) {
        case 'light':   navigator.vibrate([1, 5, 1]);    break;
        case 'success': navigator.vibrate(30);           break;
        case 'error':   navigator.vibrate([50, 30, 50]); break;
        case 'turn':    navigator.vibrate([100, 50, 100]); break;
    }
}

// ---- Init -------------------------------------------------------------------

export function initAudio() {
    if (_audioCtx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    _audioCtx = new Ctx();
}

// ---- Welcome-sound pending flag ---------------------------------------------

/** Returns true if the welcome sound is queued waiting for user interaction. */
export function isWelcomeSoundPending() { return _welcomeSoundPending; }

/** Mark the welcome sound as pending (called when audio context is suspended). */
export function setWelcomeSoundPending(v) { _welcomeSoundPending = v; }

// ---- Convenience: init + play welcome (handles suspended-context edge case) --

/**
 * Initialise the audio context and play the welcome sound.
 * Handles the case where the context is suspended (requires user gesture).
 * Sets the pending flag if audio cannot start yet.
 */
export function initAndPlayWelcome() {
    initAudio();
    if (!_audioCtx) { _welcomeSoundPending = true; return; }
    if (_audioCtx.state === 'suspended') {
        _audioCtx.resume().then(playWelcomeSound).catch(() => { _welcomeSoundPending = true; });
    } else {
        playWelcomeSound();
    }
}

// ---- Sound effects ----------------------------------------------------------

export function playWelcomeSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});

    const now    = _audioCtx.currentTime;
    const dur    = 0.42;
    const bufSize = Math.max(1, Math.floor(_audioCtx.sampleRate * dur));
    const buf  = _audioCtx.createBuffer(1, bufSize, _audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.sin(Math.PI * (i / bufSize));
    }
    const noise = _audioCtx.createBufferSource();
    noise.buffer = buf;
    const filt = _audioCtx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.frequency.setValueAtTime(500, now);
    filt.frequency.exponentialRampToValueAtTime(2200, now + dur);
    filt.Q.setValueAtTime(0.6, now);
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.07, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    noise.connect(filt); filt.connect(g); g.connect(_audioCtx.destination);
    noise.start(now); noise.stop(now + dur);

    const osc = _audioCtx.createOscillator();
    const og  = _audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, now + 0.06);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.24);
    og.gain.setValueAtTime(0.0001, now + 0.06);
    og.gain.exponentialRampToValueAtTime(0.035, now + 0.09);
    og.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    osc.connect(og); og.connect(_audioCtx.destination);
    osc.start(now + 0.06); osc.stop(now + 0.35);
}

export function playTickSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator();
    const g   = _audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1200, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(g); g.connect(_audioCtx.destination);
    osc.start(now); osc.stop(now + 0.14);
}

export function playAchievementSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now   = _audioCtx.currentTime;
    const freqs = [523.25, 659.25, 783.99, 1046.50]; // C5 E5 G5 C6
    freqs.forEach((f, i) => {
        const osc = _audioCtx.createOscillator();
        const g   = _audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now + i * 0.11);
        g.gain.setValueAtTime(0.0001, now + i * 0.11);
        g.gain.exponentialRampToValueAtTime(0.09, now + i * 0.11 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.11 + 0.38);
        osc.connect(g); g.connect(_audioCtx.destination);
        osc.start(now + i * 0.11);
        osc.stop(now + i * 0.11 + 0.42);
    });
}

// ---- Synthesised card-snap sound ------------------------------------------

export function playCardSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now    = _audioCtx.currentTime;
    const sRate  = _audioCtx.sampleRate;
    const bufLen = Math.floor(sRate * 0.14);
    const buf    = _audioCtx.createBuffer(1, bufLen, sRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    const lp = _audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1100;
    lp.Q.value = 0.4;
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.08, now + 0.010);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
    src.connect(lp); lp.connect(g); g.connect(_audioCtx.destination);
    src.start(now); src.stop(now + 0.14);
}

export function playDrawSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now    = _audioCtx.currentTime;
    const dur    = 0.28;
    const sRate  = _audioCtx.sampleRate;
    const bufLen = Math.floor(sRate * dur);
    const buf    = _audioCtx.createBuffer(1, bufLen, sRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    const lp = _audioCtx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(3000, now);
    lp.frequency.exponentialRampToValueAtTime(280, now + dur);
    lp.Q.value = 2.5;
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.20, now + 0.018);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(lp); lp.connect(g); g.connect(_audioCtx.destination);
    src.start(now); src.stop(now + dur);
}

// ---- Hydraulic whoosh (4-of-a-kind long-press) ----------------------------

export function playLongSelectSound() {
    if (!_audioCtx) return;
    const _play = () => {
        const now   = _audioCtx.currentTime;
        const sRate = _audioCtx.sampleRate;
        const dur   = 0.38;
        // Filtered noise — rising lowpass sweep (the whoosh)
        const bufLen = Math.floor(sRate * dur);
        const buf    = _audioCtx.createBuffer(1, bufLen, sRate);
        const data   = buf.getChannelData(0);
        for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
        const src = _audioCtx.createBufferSource();
        src.buffer = buf;
        const lp = _audioCtx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(180, now);
        lp.frequency.exponentialRampToValueAtTime(3200, now + dur * 0.65);
        lp.frequency.exponentialRampToValueAtTime(700, now + dur);
        lp.Q.value = 4;
        const ng = _audioCtx.createGain();
        ng.gain.setValueAtTime(0.0001, now);
        ng.gain.exponentialRampToValueAtTime(0.45, now + 0.05);
        ng.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        src.connect(lp); lp.connect(ng); ng.connect(_audioCtx.destination);
        src.start(now); src.stop(now + dur);
        // Heavy low sine for the "weight / pressure" feel
        const osc = _audioCtx.createOscillator();
        const og  = _audioCtx.createGain();
        osc.type  = 'sine';
        osc.frequency.setValueAtTime(55, now);
        osc.frequency.exponentialRampToValueAtTime(130, now + 0.18);
        og.gain.setValueAtTime(0.0001, now);
        og.gain.exponentialRampToValueAtTime(0.30, now + 0.04);
        og.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
        osc.connect(og); og.connect(_audioCtx.destination);
        osc.start(now); osc.stop(now + dur);
    };
    if (_audioCtx.state === 'suspended') _audioCtx.resume().then(_play).catch(() => {});
    else _play();
}

export function playClickSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now    = _audioCtx.currentTime;
    const sRate  = _audioCtx.sampleRate;
    const bufLen = Math.floor(sRate * 0.028);
    const buf    = _audioCtx.createBuffer(1, bufLen, sRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = _audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 1.2;
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.011, now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);
    src.connect(bp); bp.connect(g); g.connect(_audioCtx.destination);
    src.start(now); src.stop(now + 0.028);
}

export function playPurchaseSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now   = _audioCtx.currentTime;
    const freqs = [659.25, 783.99, 1046.50, 1318.51]; // E5 G5 C6 E6
    freqs.forEach((f, i) => {
        const osc = _audioCtx.createOscillator();
        const g   = _audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now + i * 0.07);
        g.gain.setValueAtTime(0.0001, now + i * 0.07);
        g.gain.exponentialRampToValueAtTime(0.07, now + i * 0.07 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.07 + 0.28);
        osc.connect(g); g.connect(_audioCtx.destination);
        osc.start(now + i * 0.07);
        osc.stop(now + i * 0.07 + 0.32);
    });
}

export function playBuzzerSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now = _audioCtx.currentTime;
    const osc = _audioCtx.createOscillator();
    const g   = _audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(220, now);
    osc.frequency.exponentialRampToValueAtTime(110, now + 0.22);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.09, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    osc.connect(g); g.connect(_audioCtx.destination);
    osc.start(now); osc.stop(now + 0.32);
}

export function playVIPFanfareSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now = _audioCtx.currentTime;
    const seq = [
        [523.25, 0.00], [659.25, 0.10], [783.99, 0.20],
        [1046.50, 0.32], [1318.51, 0.44], [1046.50, 0.56],
        [1318.51, 0.66], [1567.98, 0.78],
    ];
    seq.forEach(([f, t]) => {
        const osc = _audioCtx.createOscillator();
        const g   = _audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(f, now + t);
        g.gain.setValueAtTime(0.0001, now + t);
        g.gain.exponentialRampToValueAtTime(0.10, now + t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.28);
        osc.connect(g); g.connect(_audioCtx.destination);
        osc.start(now + t);
        osc.stop(now + t + 0.32);
    });
}

export function playDealSound() {
    if (!_audioCtx) return;
    const nowMs = performance.now();
    if (nowMs - _lastDealSoundAt < 90) return;
    _lastDealSoundAt = nowMs;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now     = _audioCtx.currentTime;
    const dur     = 0.09;
    const bufSize = Math.max(1, Math.floor(_audioCtx.sampleRate * dur));
    const buf  = _audioCtx.createBuffer(1, bufSize, _audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufSize);
    const src  = _audioCtx.createBufferSource();
    src.buffer = buf;
    const filt = _audioCtx.createBiquadFilter();
    filt.type = 'bandpass'; filt.frequency.setValueAtTime(900, now); filt.Q.setValueAtTime(0.7, now);
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.05, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filt); filt.connect(g); g.connect(_audioCtx.destination);
    src.start(now); src.stop(now + dur);
}
