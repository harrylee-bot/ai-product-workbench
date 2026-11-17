export const PALETTE = ['#f56551', '#8b5cf6', '#25a9ed', '#31bd8c', '#e35b9d', '#e9a52a', '#526cf5', '#19b8bc'];
export const NAMES = ['Cường', 'Linh', 'Alex', 'Maya', 'Kai', 'An', 'Sam', 'Minh', 'Jules', 'Quinn', 'Rin', 'Noah'];
export function cursorMarkup(color: string) {
  return `<svg class="pointer" width="26" height="29" viewBox="0 0 26 29" fill="none"><path d="M3 2.5L7.4 23.5L12.2 16.5L20.8 15.9L3 2.5Z" fill="${color.replace(/[^#\w(),.%\s-]/g, '')}" stroke="white" stroke-width="1.75" stroke-linejoin="round"/></svg><svg class="cross" width="22" height="22" viewBox="0 0 22 22"><path d="M11 1V21M1 11H21" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="11" cy="11" r="2.2" fill="#fff" stroke="currentColor" stroke-width="1.4"/></svg><svg class="ibeam" width="12" height="24" viewBox="0 0 12 24" preserveAspectRatio="none" aria-hidden="true"><path d="M3 1H9M6 1V23M3 23H9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span class="pen">✒</span>`;
}
export const styles = `
:host{all:initial;color-scheme:light;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff}
.toolbar,.help,.worker{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*,*::before,*::after{box-sizing:border-box}button{font:inherit;cursor:pointer}
.cover{position:fixed;inset:0;overflow:hidden;pointer-events:auto;isolation:isolate}
.stage{position:absolute;inset:0;pointer-events:none;transform-origin:0 0}
.workers{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.worker{position:absolute;left:0;top:0;will-change:transform,opacity;color:var(--color);filter:drop-shadow(0 2px 4px #0000002e)}
.worker .pointer{display:block;transform-origin:4px 3.5px;transform:translate(-3px,-2.5px)}
.worker .cross,.worker .ibeam,.worker .pen{display:none;position:absolute;left:-11px;top:-11px}
.worker[data-tool=cross] .pointer,.worker[data-tool=type] .pointer,.worker[data-tool=pen] .pointer{display:none}
.worker[data-tool=cross] .cross,.worker[data-tool=type] .ibeam,.worker[data-tool=pen] .pen{display:block}
.worker .ibeam{left:-6px;top:0;width:12px;height:var(--caret-height,24px);color:var(--color);transform-origin:6px 0;transform:rotate(var(--caret-angle,0deg));filter:drop-shadow(0 0 1.5px #fff) drop-shadow(0 0 4px var(--color))}
.pen{font:22px/1 serif;transform-origin:2px 20px}
.worker[data-tool=duplicate]::before{content:'⌥';position:absolute;left:-11px;top:-15px;font:600 10px/1.2 ui-monospace,monospace;background:#fff;color:var(--color);border:1px solid var(--color);border-radius:3px;padding:0 3px;box-shadow:0 1px 3px #0002}
.name{display:block;position:absolute;left:13px;top:19px;background:var(--color);border:1px solid #fff6;border-radius:4px;padding:1.5px 6px;color:#fff;font-size:10px;font-weight:500;white-space:nowrap;opacity:.95;box-shadow:0 2px 6px #0002}
.selection{position:absolute;pointer-events:none;border:1.25px solid var(--color);min-width:1px;min-height:1px;box-shadow:0 0 0 1px #ffffff55;border-radius:1px}
.selection::before,.selection::after{content:'';position:absolute;width:6px;height:6px;background:#fff;border:1.5px solid var(--color);border-radius:1.5px;box-shadow:0 1px 2px #0002}
.selection::before{left:-3.5px;top:-3.5px}.selection::after{right:-3.5px;bottom:-3.5px}
.badge{position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);font:600 10px/1.35 ui-monospace,monospace;font-variant-numeric:tabular-nums;padding:2px 6px;background:var(--color);color:white;border-radius:4px;white-space:nowrap;box-shadow:0 2px 6px #00000029}
.guide{position:fixed;top:var(--swarm-top,20px);height:var(--swarm-height,100vh);border-left:1px solid #f16a56;opacity:.65;pointer-events:none}
.measure{position:absolute;top:-19px;left:0;right:0;border-bottom:1px solid #f16a56;color:#f16a56;text-align:center;font:10px/1.5 monospace}
.ruler-x{position:fixed;left:var(--swarm-left,20px);width:var(--swarm-width,100vw);top:var(--swarm-top,0px);height:20px;background:repeating-linear-gradient(90deg,#aaa5 0px,#aaa5 1px,transparent 1px,transparent 10px),#fafafae8;border-bottom:1px solid #ddd8;color:#999;font:9px/18px monospace;pointer-events:none}
.ruler-y{position:fixed;left:var(--swarm-left,0px);top:var(--swarm-top,20px);height:var(--swarm-height,100vh);width:20px;background:repeating-linear-gradient(0deg,#aaa5 0px,#aaa5 1px,transparent 1px,transparent 10px),#fafafae8;border-right:1px solid #ddd8;pointer-events:none}
.toolbar{pointer-events:auto;position:fixed;bottom:var(--swarm-bottom,24px);left:var(--swarm-center-x,50%);transform:translateX(-50%);display:flex;align-items:center;gap:7px;padding:8px 10px;background:#25292eef;color:#f8fafc;border:1px solid #ffffff28;border-radius:14px;box-shadow:0 12px 40px #0003,0 0 0 5px #ffffff80;backdrop-filter:blur(16px);white-space:nowrap;max-width:calc(var(--swarm-width,100vw) - 24px);z-index:5;font-size:11px}
.toolbar button{background:none;color:#dce1e9;border:0;border-radius:6px;padding:6px 8px;min-height:30px;white-space:nowrap}
.toolbar button:hover,.toolbar button[aria-pressed=true]{background:#ffffff18;color:#fff}
.toolbar button:focus-visible{outline:2px solid #7dcfff;outline-offset:2px}
.toolbar .live{background:#e4f5c8;color:#24351c;font-weight:650}
.status{min-width:115px;color:#c4cbd5;font-variant-numeric:tabular-nums}.track{width:54px;height:3px;background:#ffffff24;border-radius:9px;overflow:hidden}.fill{height:100%;background:#b8ee8a;width:0;transition:width .2s}
.avatars{display:flex;padding-left:5px}.avatar{width:16px;height:16px;border:2px solid #30343a;border-radius:50%;margin-left:-5px}
.divider{height:16px;width:1px;background:#ffffff20}.intro{position:fixed;left:var(--swarm-center-x,50%);top:var(--swarm-center-y,46%);transform:translate(-50%,-50%);width:48px;height:48px;display:grid;place-items:center;background:#25292e;color:#e4f5c8;border-radius:14px;font-size:26px;box-shadow:0 6px 24px #00000024,0 0 0 6px #25292e14;transition:opacity .3s,transform .3s}
.help{position:fixed;bottom:calc(var(--swarm-bottom,24px) + 64px);left:var(--swarm-center-x,50%);transform:translateX(-50%);color:#687078;font-size:11px;pointer-events:none;background:#ffffffc9;padding:5px 12px;border-radius:20px}
.toolbar.minimal{gap:12px;box-shadow:0 6px 24px #0002;max-width:calc(var(--swarm-width,100vw) - 24px)}
.toolbar.minimal .status{min-width:0}
@media(max-width:600px){.toolbar{gap:2px;bottom:var(--swarm-bottom,14px);padding:6px}.toolbar button{padding:6px}.avatars,.track,.divider{display:none}.status{min-width:90px;font-size:10px}.name{font-size:9px}.help{bottom:calc(var(--swarm-bottom,14px) + 60px)}}
`;
