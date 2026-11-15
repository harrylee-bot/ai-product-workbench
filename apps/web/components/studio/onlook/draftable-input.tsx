// Derived from Onlook, Copyright 2024 On Off, Inc., Apache-2.0.
// packages/ui/src/components/draftable-input.tsx @ 423e2e924366419e418ee049093872d535eea41a
// Changes: native change listener replaced by blur/Enter; supports Escape and IME.
"use client";
import * as React from "react";
import { Input } from "./input";
export function useDraftValue<T>(
  value: T,
  onChange: (value: T) => void,
): [T, (value: T) => void, () => void] {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return [draft, setDraft, () => onChange(draft)];
}
export function DraftableInput({
  value,
  onChangeValue,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & {
  value: string;
  onChangeValue: (value: string) => void;
}) {
  const [draft, setDraft, commit] = useDraftValue(value, onChangeValue);
  const cancelled = React.useRef(false);
  return (
    <Input
      {...props}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        if (!cancelled.current) commit();
        cancelled.current = false;
        props.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          commit();
        }
        if (e.key === "Escape") {
          cancelled.current = true;
          setDraft(value);
          e.currentTarget.blur();
        }
        props.onKeyDown?.(e);
      }}
    />
  );
}
