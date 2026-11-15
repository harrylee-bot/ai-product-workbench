// Derived from Onlook, Copyright 2024 On Off, Inc., Apache-2.0.
// apps/web/client/src/app/project/[id]/_components/editor-bar/frame-selected/device-selector.tsx
// @ 423e2e924366419e418ee049093872d535eea41a
// Changes: controlled frozen-preview size; native accessible select; no editor engine persistence.
"use client";
import { DEVICE_OPTIONS } from "./devices";
import { DraftableInput } from "./draftable-input";
type Size = { width: number; height: number };
export function DeviceSelector({
  size,
  onChange,
}: {
  size: Size;
  onChange: (size: Size) => void;
}) {
  const device = Object.entries(DEVICE_OPTIONS)
    .flatMap(([category, devices]) =>
      Object.entries(devices).map(([name, dimensions]) => ({
        category,
        name,
        dimensions,
      })),
    )
    .find((d) => d.dimensions === `${size.width}x${size.height}`);
  const handleDeviceChange = (value: string) => {
    const [category, name] = value.split(":");
    const dimensions = DEVICE_OPTIONS[category!]?.[name!];
    if (!dimensions || dimensions === "Custom") return;
    const [width, height] = dimensions.split("x").map(Number);
    if (Number.isFinite(width) && Number.isFinite(height))
      onChange({ width: Math.round(width!), height: Math.round(height!) });
  };
  const bound = (value: string, min: number) =>
    Math.max(min, Math.min(2560, Number(value) || min));
  return (
    <>
      <select
        aria-label="预览尺寸"
        value={device ? `${device.category}:${device.name}` : "Custom:Custom"}
        onChange={(e) => handleDeviceChange(e.target.value)}
      >
        {Object.entries(DEVICE_OPTIONS).map(([category, devices]) => (
          <optgroup key={category} label={category}>
            {Object.entries(devices).map(([name, dimensions]) => (
              <option key={name} value={`${category}:${name}`}>
                {dimensions === "Custom"
                  ? "自定义尺寸"
                  : `${name} · ${dimensions.replace("x", "×")}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <details>
        <summary>尺寸</summary>
        <label>
          宽
          <DraftableInput
            aria-label="预览宽度"
            type="number"
            min={280}
            max={2560}
            value={String(size.width)}
            onChangeValue={(v) => onChange({ ...size, width: bound(v, 280) })}
          />
        </label>
        <label>
          高
          <DraftableInput
            aria-label="预览高度"
            type="number"
            min={320}
            max={2560}
            value={String(size.height)}
            onChangeValue={(v) => onChange({ ...size, height: bound(v, 320) })}
          />
        </label>
        <button
          type="button"
          onClick={() => onChange({ width: size.height, height: size.width })}
        >
          横竖切换
        </button>
      </details>
    </>
  );
}
