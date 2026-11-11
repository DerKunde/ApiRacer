import { TOP_SPEED } from './carPhysics';
import type { Viewport } from './splitScreenLayout';

// Engine sound of every car, synthesized with the Web Audio API: no sample files, and any pitch sounds natural.
// Split screen shares one pair of speakers between up to four views, so nothing is spatial: every engine is heard
// exactly once, like a player's own kart in split screen Mario Kart – never mixed in a second time for another view.

// Pitch of the engine pulses in Hz, standing still … at top speed. One gear, like a go-kart: the pitch follows the
// speed all the way.
const IDLE_FREQUENCY = 30;
const TOP_FREQUENCY = 160;
// One factor per start slot: four engines at the same speed would otherwise melt into one tone
const SLOT_PITCH = [1, 1.12, 0.9, 1.25];
// Square wave one octave below: makes every second pulse stronger – the uneven rumble of an engine instead of the
// even buzz of a single sawtooth
const SUB_OCTAVE_LEVEL = 0.6;
// Soft clipping before the filter: higher = more growl
const DRIVE = 3;
// Low pass cutoff = this × pitch, plus the throttle share: an engine under load sounds brighter
const CUTOFF_PER_PITCH = 5;
const CUTOFF_THROTTLE = 900;
// Slight peak at the cutoff, like the resonance of an exhaust pipe
const FILTER_Q = 3;
// Volume of one engine: idling, plus the shares of speed and throttle (each 0 … 1)
const IDLE_VOLUME = 0.25;
const SPEED_VOLUME = 0.2;
const THROTTLE_VOLUME = 0.35;
// Random pitch wobble: makes the pulses irregular, like a real engine. 0 = off.
const JITTER_CENTS = 30;
// About how often per second the wobble changes direction
const JITTER_RATE = 40;
const JITTER_BUFFER_SECONDS = 2;
// Stereo position of a view = its horizontal center on the screen, scaled by this. 1: a view in the left half sits
// halfway to the left (−0.5) – both speakers still play it, the left one louder.
const STEREO_WIDTH = 1;
// Of the whole mix, in front of the compressor
const MASTER_VOLUME = 0.5;
// Time constant in s that every value follows its target with. The values change every frame – set directly,
// each change would be a step in the waveform, and the steps crackle.
const SMOOTHING = 0.05;
// Fade out of a removed car's engine: cut off at once, it clicks
const FADE_OUT = 0.1;

// Stereo position (−1 left … +1 right) of a split screen view. Full screen and top/bottom (2 players) sit in the
// middle, only the 2 × 2 split has a left and a right column.
export function viewportPan(viewport: Viewport): number {
    return (viewport.x + viewport.width / 2 - 0.5) * 2 * STEREO_WIDTH;
}

// All engines → mix (scaled with the engine count) → master (volume slider, silent in edit mode) → compressor → speakers
export class RaceAudio {

    private readonly context = new AudioContext();
    private readonly mix: GainNode;
    private readonly master: GainNode;
    // Shared by all engines; each one plays it from its own random offset
    private readonly jitterBuffer: AudioBuffer;
    private engineCount = 0;
    // Browsers only start audio after a click or key press on the page. Set once that has happened.
    private unlocked = false;
    // 0 … 1, set by the volume slider on the host page
    private volume = 1;
    private silent = false;

    constructor() {
        const { context } = this;
        // Only a safety net against clipping when everyone floors it – below the threshold it leaves the mix alone
        const compressor = new DynamicsCompressorNode(context, { threshold: -6, knee: 6, ratio: 12, attack: 0.003, release: 0.25 });
        compressor.connect(context.destination);
        this.master = new GainNode(context, { gain: MASTER_VOLUME });
        this.master.connect(compressor);
        this.mix = new GainNode(context);
        this.mix.connect(this.master);
        this.jitterBuffer = createJitterBuffer(context);

        // The context starts suspended without a user gesture – and the cars already drive in the lobby, before
        // anyone clicks "Rennen starten". So any click or key press anywhere on the page starts it.
        const unlock = (): void => void context.resume();
        const events = ['click', 'keydown'] as const;
        for (const event of events) window.addEventListener(event, unlock, { capture: true });
        context.addEventListener('statechange', () => {
            if (context.state !== 'running' || this.unlocked) return;
            this.unlocked = true;
            for (const event of events) window.removeEventListener(event, unlock, { capture: true });
        });

        // A background tab pauses the render loop, so the engines would keep droning with their last values
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) void context.suspend();
            else if (this.unlocked) void context.resume();
        });
    }

    // slot: start grid slot of the car, picks its pitch
    addEngine(slot: number): EngineSound {
        const engine = new EngineSound(this.context, this.mix, this.jitterBuffer, SLOT_PITCH[slot % SLOT_PITCH.length]);
        this.engineCount++;
        this.updateMixVolume();
        return engine;
    }

    removeEngine(engine: EngineSound): void {
        engine.stop();
        this.engineCount--;
        this.updateMixVolume();
    }

    // volume: 0 … 1 (slider position)
    setVolume(volume: number): void {
        this.volume = Math.min(Math.max(volume, 0), 1);
        this.updateMasterVolume();
    }

    // Edit mode: the cars are hidden and stand still
    setSilent(silent: boolean): void {
        this.silent = silent;
        this.updateMasterVolume();
    }

    // Squared: we hear loudness roughly logarithmically – with a linear gain, the upper half of the slider would
    // barely change anything
    private updateMasterVolume(): void {
        const target = this.silent ? 0 : MASTER_VOLUME * this.volume ** 2;
        const now = this.context.currentTime;
        // A dragged slider sends dozens of values per second. Without cancelling, a suspended context (frozen clock)
        // would pile them all up at the same time.
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(target, now, SMOOTHING);
    }

    // Engines don't add up in phase, so their loudness grows with √n, not n: dividing by √n keeps the mix of four
    // cars as loud as a single one
    private updateMixVolume(): void {
        this.mix.gain.setTargetAtTime(1 / Math.sqrt(Math.max(1, this.engineCount)), this.context.currentTime, SMOOTHING);
    }
}

// Sawtooth plus a square wave one octave below, soft clipped and low pass filtered. Starts silent; the first update
// fades it in.
export class EngineSound {

    private readonly context: AudioContext;
    private readonly pitch: number;
    private readonly main: OscillatorNode;
    private readonly sub: OscillatorNode;
    private readonly jitter: AudioBufferSourceNode;
    private readonly filter: BiquadFilterNode;
    private readonly volume: GainNode;
    private readonly panner: StereoPannerNode;

    // pitch: factor on the whole frequency range, so engines differ
    constructor(context: AudioContext, destination: AudioNode, jitterBuffer: AudioBuffer, pitch: number) {
        this.context = context;
        this.pitch = pitch;
        const frequency = IDLE_FREQUENCY * pitch;
        this.main = new OscillatorNode(context, { type: 'sawtooth', frequency });
        this.sub = new OscillatorNode(context, { type: 'square', frequency: frequency / 2 });
        const subLevel = new GainNode(context, { gain: SUB_OCTAVE_LEVEL });
        const shaper = new WaveShaperNode(context, { curve: softClipCurve(DRIVE), oversample: '2x' });
        this.filter = new BiquadFilterNode(context, { type: 'lowpass', frequency: frequency * CUTOFF_PER_PITCH, Q: FILTER_Q });
        this.volume = new GainNode(context, { gain: 0 });
        this.panner = new StereoPannerNode(context);

        this.main.connect(shaper);
        this.sub.connect(subLevel).connect(shaper);
        shaper.connect(this.filter).connect(this.volume).connect(this.panner).connect(destination);

        // Detune is in cents and adds to the frequency: the wobble bends both oscillators together
        this.jitter = new AudioBufferSourceNode(context, { buffer: jitterBuffer, loop: true });
        const jitterDepth = new GainNode(context, { gain: JITTER_CENTS });
        this.jitter.connect(jitterDepth);
        jitterDepth.connect(this.main.detune);
        jitterDepth.connect(this.sub.detune);

        this.main.start();
        this.sub.start();
        // Random offset: four engines with the same wobble would pulse in sync
        this.jitter.start(0, Math.random() * jitterBuffer.duration);
    }

    // Called every frame. speed: m/s along the car, either direction. throttle: 0 … 1. pan: −1 (left) … +1 (right).
    update(speed: number, throttle: number, pan: number): void {
        // A suspended context has a frozen clock: every call would pile up one more event per value at the same time
        if (this.context.state !== 'running') return;

        const targets = engineTargets(speed, throttle, pan, this.pitch);
        const now = this.context.currentTime;
        this.main.frequency.setTargetAtTime(targets.frequency, now, SMOOTHING);
        this.sub.frequency.setTargetAtTime(targets.frequency / 2, now, SMOOTHING);
        this.filter.frequency.setTargetAtTime(targets.cutoff, now, SMOOTHING);
        this.volume.gain.setTargetAtTime(targets.gain, now, SMOOTHING);
        this.panner.pan.setTargetAtTime(targets.pan, now, SMOOTHING);
    }

    // Use RaceAudio.removeEngine, which also keeps the mix volume right
    stop(): void {
        const now = this.context.currentTime;
        // Time constant a fifth of the fade: down to below 1 % when the sources stop
        this.volume.gain.setTargetAtTime(0, now, FADE_OUT / 5);
        for (const source of [this.main, this.sub, this.jitter]) source.stop(now + FADE_OUT);
        // Nothing plays anymore → disconnected, the nodes can be garbage collected
        this.main.addEventListener('ended', () => this.panner.disconnect());
    }
}

export interface EngineTargets {
    // Of the sawtooth, in Hz; the square wave plays half of it
    frequency: number;
    // Of the low pass, in Hz
    cutoff: number;
    gain: number;
    pan: number;
}

// What EngineSound.update sets, as numbers only: testable without Web Audio. Arguments as in update, pitch see
// SLOT_PITCH. Every input is clamped first (see clamp) – the throttle comes unchecked from a phone.
export function engineTargets(speed: number, throttle: number, pan: number, pitch: number): EngineTargets {
    const speedShare = clamp(Math.abs(speed) / TOP_SPEED, 0, 1);
    const throttleShare = clamp(throttle, 0, 1);
    const frequency = (IDLE_FREQUENCY + (TOP_FREQUENCY - IDLE_FREQUENCY) * speedShare) * pitch;
    return {
        frequency,
        cutoff: frequency * CUTOFF_PER_PITCH + throttleShare * CUTOFF_THROTTLE,
        gain: IDLE_VOLUME + speedShare * SPEED_VOLUME + throttleShare * THROTTLE_VOLUME,
        pan: clamp(pan, -1, 1),
    };
}

// AudioParam methods throw on NaN and ±Infinity, and EngineSound.update runs in the render loop before anything is
// drawn: one broken value would freeze the picture for everyone. Infinity ends up at min or max, NaN (also from a
// value that isn't a number at all) at 0 – min ≤ 0 ≤ max.
function clamp(value: number, min: number, max: number): number {
    const clamped = Math.min(Math.max(value, min), max);
    return Number.isNaN(clamped) ? 0 : clamped;
}

// tanh: nearly linear for quiet input, rounds off the peaks of loud input. Normalized so ±1 stays ±1.
function softClipCurve(drive: number): Float32Array<ArrayBuffer> {
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
        const x = i / (curve.length - 1) * 2 - 1;
        curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
    }
    return curve;
}

// White noise through a one-pole low pass at JITTER_RATE, normalized to ±1: random values that drift instead of jump
function createJitterBuffer(context: AudioContext): AudioBuffer {
    const buffer = context.createBuffer(1, Math.round(context.sampleRate * JITTER_BUFFER_SECONDS), context.sampleRate);
    const data = buffer.getChannelData(0);
    const smoothing = 1 - Math.exp(-2 * Math.PI * JITTER_RATE / context.sampleRate);
    let value = 0;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
        value += (Math.random() * 2 - 1 - value) * smoothing;
        data[i] = value;
        peak = Math.max(peak, Math.abs(value));
    }
    for (let i = 0; i < data.length; i++) data[i] /= peak;
    return buffer;
}
