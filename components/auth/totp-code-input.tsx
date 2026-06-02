"use client";

import { useRef } from "react";
import { cn } from "@/lib/shared/utils";

type TotpCodeInputProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
  required?: boolean;
};

function normalizeCode(value: string) {
  return value.replace(/\D/g, "").slice(0, 6);
}

export function TotpCodeInput({
  id,
  value,
  onChange,
  autoFocus,
  disabled,
  required,
}: TotpCodeInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cells = Array.from({ length: 6 }, (_, index) => value[index] ?? "");

  return (
    <div
      className={cn(
        "group relative grid grid-cols-6 gap-2 rounded-lg",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-text",
      )}
      onClick={() => inputRef.current?.focus()}
    >
      <input
        ref={inputRef}
        id={id}
        name={id}
        type="text"
        value={value}
        onChange={(event) => onChange(normalizeCode(event.target.value))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        pattern="[0-9]{6}"
        maxLength={6}
        autoFocus={autoFocus}
        disabled={disabled}
        required={required}
        aria-label="验证码"
        className="absolute inset-0 z-10 h-full w-full cursor-text rounded-lg border-0 bg-transparent px-0 text-[16px] text-transparent caret-transparent opacity-[0.01] outline-none"
      />
      {cells.map((digit, index) => (
        <div
          key={index}
          aria-hidden="true"
          className={cn(
            "flex h-12 min-w-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-hover)] font-mono text-xl font-semibold tabular-nums text-[var(--color-foreground)] shadow-[var(--shadow-sm)] transition-colors duration-150",
            "group-hover:border-[var(--color-border-hover)]",
            "group-focus-within:border-[var(--color-accent)] group-focus-within:ring-2 group-focus-within:ring-[var(--color-accent)]/20",
          )}
        >
          {digit || <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-foreground-subtle)]/45" />}
        </div>
      ))}
    </div>
  );
}
