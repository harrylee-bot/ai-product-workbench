import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createSwarmRebuild, initialState } from './engine';
import type { SwarmController, SwarmOptions, SwarmState } from './types';
export { createSwarmRebuild } from './engine';
export type { SwarmController, SwarmOptions, SwarmPhase, SwarmState } from './types';

export interface UseSwarmRebuildResult extends SwarmController { state: SwarmState; }
export function useSwarmRebuild(options: SwarmOptions = {}): UseSwarmRebuildResult {
  const optionsRef = useRef(options); optionsRef.current = options;
  const settings = useRef<Pick<SwarmOptions, 'speed' | 'sound' | 'tour' | 'ready' | 'cursorCount'>>({});
  const instance = useRef<SwarmController | null>(null);
  const [state, setState] = useState(() => initialState(options));
  const api = useRef<SwarmController | null>(null);
  if (!api.current) {
    const ensure = () => {
      if (!instance.current) instance.current = createSwarmRebuild({
        ...optionsRef.current,
        ...settings.current,
        onStateChange: next => {
          settings.current = { ...settings.current, speed: next.speed, sound: next.sound, tour: next.tour };
          setState(next); optionsRef.current.onStateChange?.(next);
        },
        onComplete: () => optionsRef.current.onComplete?.(),
        onError: error => { if (optionsRef.current.onError) optionsRef.current.onError(error); else console.error('[react-swarm-rebuild]', error); },
      });
      return instance.current;
    };
    api.current = {
      start: () => { instance.current?.destroy(); instance.current = null; ensure().start(); },
      replay: () => api.current!.start(),
      pause: () => instance.current?.pause(), resume: () => instance.current?.resume(),
      goLive: () => instance.current?.goLive(), stop: () => instance.current?.stop(),
      setSpeed: value => ensure().setSpeed(value),
      setSound: value => ensure().setSound(value),
      setTour: value => ensure().setTour(value),
      setReady: value => { settings.current.ready = value; instance.current?.setReady(value); },
      setCursorCount: value => { settings.current.cursorCount = value; instance.current?.setCursorCount(value); },
      getState: () => instance.current?.getState() ?? initialState(optionsRef.current),
      destroy: () => { instance.current?.destroy(); instance.current = null; setState(initialState(optionsRef.current)); },
    };
  }
  useEffect(() => () => { instance.current?.destroy(); instance.current = null; }, []);
  useEffect(() => { if (options.speed !== undefined) instance.current?.setSpeed(options.speed); }, [options.speed]);
  useEffect(() => { if (options.sound !== undefined) instance.current?.setSound(options.sound); }, [options.sound]);
  useEffect(() => { if (options.tour !== undefined) instance.current?.setTour(options.tour); }, [options.tour]);
  useEffect(() => { if (options.ready !== undefined) api.current?.setReady(options.ready); }, [options.ready]);
  useEffect(() => { if (options.cursorCount !== undefined) api.current?.setCursorCount(options.cursorCount); }, [options.cursorCount]);
  return { ...api.current, state };
}

export interface SwarmRebuildProps extends SwarmOptions {
  /** Run on mount and whenever this changes from false to true. Default: true. */
  active?: boolean;
}
/** Render once beside the UI to rebuild. It adds no wrapper to your React tree. */
export const SwarmRebuild = forwardRef<SwarmController, SwarmRebuildProps>(function SwarmRebuild({ active = true, ...options }, ref) {
  const swarm = useSwarmRebuild(options);
  useImperativeHandle(ref, () => swarm, [swarm]);
  const { start, stop } = swarm;
  useEffect(() => { if (active) start(); else stop(); return stop; }, [active, start, stop]);
  return null;
});
