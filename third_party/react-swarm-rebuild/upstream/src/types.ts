import type { RefObject } from 'react';

export type SwarmPhase = 'idle' | 'scanning' | 'intro' | 'transition' | 'building' | 'complete' | 'exiting' | 'live' | 'paused';
export interface SwarmState {
    phase: SwarmPhase;
    completed: number;
    total: number;
    progress: number;
    agents: number;
    speed: number;
    sound: boolean;
    tour: boolean;
}
export interface SwarmOptions {
    /** A selector, element, or React ref. Defaults to document.body. */
    target?: string | HTMLElement | RefObject<HTMLElement | null>;
    /** Component targets are clipped to their visible bounds by default. */
    scope?: 'target' | 'viewport';
    /** Keep orbiting without taking a snapshot until content is ready. Default true. */
    ready?: boolean;
    /** Number of workers, between 2 and 48. Default: 16. */
    cursorCount?: number;
    /** Start children/duplicates once their backing surface is underway. Default true. */
    parallelDrawing?: boolean;
    /** Scale the stronger intro/idle oscillations, 0.25–3. Default 1. */
    floatAmplitude?: number;
    /** Scale the intro/idle oscillation speed, 0.25–3. Default 1. */
    floatSpeed?: number;
    /** Playback multiplier, between 0.25 and 8. Default: 1. */
    speed?: number;
    /** Synthesized audio; requires a browser user gesture. Default: false. */
    sound?: boolean;
    /** Follow the next unfinished layer by scrolling the page. Default: false. */
    tour?: boolean;
    /** Optional playback toolbar or status only. Default false; click the effect to skip. */
    controls?: boolean | 'minimal';
    /** Show horizontal/vertical rulers. Default false. */
    showRulers?: boolean;
    /** Show red alignment/duplicate measurement guides. Default false. */
    showGuides?: boolean;
    /** Click/tap inside the covered component to skip. Default true. */
    clickToSkip?: boolean;
    /** Gently bob and breathe during the intro orbit. Default true. */
    floatingIntro?: boolean;
    /** Idle workers drift locally rather than following the user's mouse. Default true. */
    floatingIdle?: boolean;
    /** Ease the orbit into the reconstruction with staggered departures. Default true. */
    smoothTransition?: boolean;
    /** Handoff duration in real milliseconds. Default 480. */
    transitionDuration?: number;
    /** Fade in cursors/decorations over the opaque cover. Default true. */
    fadeIn?: boolean;
    /** Entrance duration in real milliseconds. Default 360. */
    fadeInDuration?: number;
    /** Type graphemes with a colored caret at the measured text position. Default true. */
    typing?: boolean;
    /** Graphemes per animation second, before speed multiplier. Default 45. */
    typingSpeed?: number;
    /** Send cursors radially out of the component before going live. Default true. */
    burstOnComplete?: boolean;
    /** Radial exit duration in real milliseconds. Default 700. */
    exitDuration?: number;
    /** Cooperative snapshot budget per frame in milliseconds, 1–12. Default 4. */
    snapshotBudget?: number;
    /** Show collaborator names. Default: false, matching the minimal cursor look. */
    showNames?: boolean;
    names?: readonly string[];
    colors?: readonly string[];
    /** Intro orbit duration in milliseconds. Default: 1600. */
    introDuration?: number;
    /** Maximum number of visual layers. Default: 2500. */
    maxLayers?: number;
    zIndex?: number;
    background?: string;
    /** Skip animation for prefers-reduced-motion users. Default: true. */
    respectReducedMotion?: boolean;
    /** Default 'live' removes the overlay on completion. Use 'flock' to keep cursors. */
    finishBehavior?: 'flock' | 'live';
    onStateChange?: (state: SwarmState) => void;
    onComplete?: () => void;
    onError?: (error: Error) => void;
}
export interface SwarmController {
    start: () => void;
    replay: () => void;
    pause: () => void;
    resume: () => void;
    goLive: () => void;
    stop: () => void;
    setSpeed: (speed: number) => void;
    setSound: (enabled: boolean) => void;
    setTour: (enabled: boolean) => void;
    setReady: (ready: boolean) => void;
    /** Change the worker pool without restarting. Busy excess workers finish first. */
    setCursorCount: (count: number) => void;
    getState: () => SwarmState;
    destroy: () => void;
}

