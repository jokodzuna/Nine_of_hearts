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

function _createReverb(decaySec = 1.4) {
    const sRate  = _audioCtx.sampleRate;
    const length = Math.floor(sRate * decaySec);
    const ir     = _audioCtx.createBuffer(2, length, sRate);
    for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < length; i++)
            d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.2);
    }
    const conv = _audioCtx.createConvolver();
    conv.buffer = ir;
    return conv;
}

export function playDrawSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const now    = _audioCtx.currentTime;
    const dur    = 0.55;
    const sRate  = _audioCtx.sampleRate;
    const bufLen = Math.floor(sRate * dur);
    const buf    = _audioCtx.createBuffer(1, bufLen, sRate);
    const data   = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = _audioCtx.createBufferSource();
    src.buffer = buf;
    const bp = _audioCtx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(300, now);
    bp.frequency.exponentialRampToValueAtTime(2000, now + 0.30);
    bp.frequency.exponentialRampToValueAtTime(550, now + dur);
    bp.Q.value = 0.65;
    const g = _audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.09, now + 0.13);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(bp); bp.connect(g);
    const dry = _audioCtx.createGain(); dry.gain.value = 0.55;
    const wet = _audioCtx.createGain(); wet.gain.value = 0.45;
    const rev = _createReverb();
    g.connect(dry); dry.connect(_audioCtx.destination);
    g.connect(rev); rev.connect(wet); wet.connect(_audioCtx.destination);
    src.start(now); src.stop(now + dur);
}

// ---- Botfather door open: clunk → hiss → whine → thud (2.5 s, with reverb) -

export function playDoorOpenSound() {
    if (!_audioCtx) return;
    if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
    const ctx = _audioCtx;
    const now = ctx.currentTime;
    const sr  = ctx.sampleRate;
    const out = ctx.destination;

    // ---------- Light convolution reverb ----------
    const revLen = Math.floor(sr * 1.4);
    const revBuf = ctx.createBuffer(2, revLen, sr);
    for (let c = 0; c < 2; c++) {
        const ch = revBuf.getChannelData(c);
        for (let i = 0; i < revLen; i++)
            ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / revLen, 2.5);
    }
    const conv = ctx.createConvolver(); conv.buffer = revBuf;
    const revSend = ctx.createGain(); revSend.gain.value = 0.22;
    conv.connect(revSend); revSend.connect(out);

    // Helper: connect a gain node to both dry out and reverb input
    function send(gainNode) { gainNode.connect(out); gainNode.connect(conv); }

    // ---- 1. Metallic unlock clunk at T=0 ----
    // Oscillator: sawtooth pitch drop (bolt hitting frame)
    const clkOsc = ctx.createOscillator();
    clkOsc.type = 'sawtooth';
    clkOsc.frequency.setValueAtTime(115, now);
    clkOsc.frequency.exponentialRampToValueAtTime(30, now + 0.14);
    const clkG = ctx.createGain();
    clkG.gain.setValueAtTime(0.0001, now);
    clkG.gain.exponentialRampToValueAtTime(0.65, now + 0.006);
    clkG.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    clkOsc.connect(clkG); send(clkG);
    clkOsc.start(now); clkOsc.stop(now + 0.22);

    // Noise burst for clunk body
    const cnLen = Math.floor(sr * 0.08);
    const cnBuf = ctx.createBuffer(1, cnLen, sr);
    const cnDat = cnBuf.getChannelData(0);
    for (let i = 0; i < cnLen; i++) cnDat[i] = Math.random() * 2 - 1;
    const cnSrc = ctx.createBufferSource(); cnSrc.buffer = cnBuf;
    const cnF = ctx.createBiquadFilter(); cnF.type = 'bandpass'; cnF.frequency.value = 700; cnF.Q.value = 0.7;
    const cnG = ctx.createGain();
    cnG.gain.setValueAtTime(0.0001, now);
    cnG.gain.exponentialRampToValueAtTime(0.55, now + 0.004);
    cnG.gain.exponentialRampToValueAtTime(0.0001, now + 0.075);
    cnSrc.connect(cnF); cnF.connect(cnG); send(cnG);
    cnSrc.start(now); cnSrc.stop(now + 0.08);

    // ---- 2. Hydraulic hiss T=0.08 → T=2.5 ----
    const hLen = Math.floor(sr * 2.5);
    const hBuf = ctx.createBuffer(1, hLen, sr);
    const hDat = hBuf.getChannelData(0);
    for (let i = 0; i < hLen; i++) hDat[i] = Math.random() * 2 - 1;
    const hSrc = ctx.createBufferSource(); hSrc.buffer = hBuf;
    const hLP = ctx.createBiquadFilter(); hLP.type = 'lowpass'; hLP.Q.value = 0.4;
    hLP.frequency.setValueAtTime(4000, now + 0.08);
    hLP.frequency.exponentialRampToValueAtTime(1200, now + 1.0);
    hLP.frequency.exponentialRampToValueAtTime(300,  now + 2.3);
    const hG = ctx.createGain();
    hG.gain.setValueAtTime(0.0001, now + 0.08);
    hG.gain.exponentialRampToValueAtTime(0.28, now + 0.18);
    hG.gain.setValueAtTime(0.28, now + 1.9);
    hG.gain.exponentialRampToValueAtTime(0.0001, now + 2.45);
    hSrc.connect(hLP); hLP.connect(hG); send(hG);
    hSrc.start(now + 0.08); hSrc.stop(now + 2.5);

    // ---- 3. Hydraulic whine T=0.25 → T=2.2 (rising sawtooth) ----
    const whOsc = ctx.createOscillator(); whOsc.type = 'sawtooth';
    whOsc.frequency.setValueAtTime(52, now + 0.25);
    whOsc.frequency.exponentialRampToValueAtTime(260, now + 1.9);
    whOsc.frequency.exponentialRampToValueAtTime(480, now + 2.2);
    const whBP = ctx.createBiquadFilter(); whBP.type = 'bandpass'; whBP.Q.value = 2.5;
    whBP.frequency.setValueAtTime(180, now + 0.25);
    whBP.frequency.exponentialRampToValueAtTime(700, now + 2.2);
    const whG = ctx.createGain();
    whG.gain.setValueAtTime(0.0001, now + 0.25);
    whG.gain.exponentialRampToValueAtTime(0.10, now + 0.45);
    whG.gain.setValueAtTime(0.10, now + 1.9);
    whG.gain.exponentialRampToValueAtTime(0.0001, now + 2.25);
    whOsc.connect(whBP); whBP.connect(whG); send(whG);
    whOsc.start(now + 0.25); whOsc.stop(now + 2.3);

    // ---- 4. Dull thud at T=2.35 (door fully seated in frame) ----
    const tdOsc = ctx.createOscillator(); tdOsc.type = 'sine';
    tdOsc.frequency.setValueAtTime(58, now + 2.35);
    tdOsc.frequency.exponentialRampToValueAtTime(24, now + 2.65);
    const tdG = ctx.createGain();
    tdG.gain.setValueAtTime(0.0001, now + 2.35);
    tdG.gain.exponentialRampToValueAtTime(0.6, now + 2.356);
    tdG.gain.exponentialRampToValueAtTime(0.0001, now + 2.72);
    tdOsc.connect(tdG); send(tdG);
    tdOsc.start(now + 2.35); tdOsc.stop(now + 2.75);

    // Thud noise body
    const tnLen = Math.floor(sr * 0.14);
    const tnBuf = ctx.createBuffer(1, tnLen, sr);
    const tnDat = tnBuf.getChannelData(0);
    for (let i = 0; i < tnLen; i++) tnDat[i] = Math.random() * 2 - 1;
    const tnSrc = ctx.createBufferSource(); tnSrc.buffer = tnBuf;
    const tnF = ctx.createBiquadFilter(); tnF.type = 'lowpass'; tnF.frequency.value = 220;
    const tnG = ctx.createGain();
    tnG.gain.setValueAtTime(0.0001, now + 2.35);
    tnG.gain.exponentialRampToValueAtTime(0.5, now + 2.356);
    tnG.gain.exponentialRampToValueAtTime(0.0001, now + 2.48);
    tnSrc.connect(tnF); tnF.connect(tnG); send(tnG);
    tnSrc.start(now + 2.35); tnSrc.stop(now + 2.5);
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
