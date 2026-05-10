"use client";

import { createContext, ReactNode, useCallback, useContext, useMemo } from "react";
import { Toaster, toast as sonnerToast } from "sonner";

type ToastVariant = "success" | "error" | "info";

type ToastInput = {
  title?: string;
  description: string;
  variant?: ToastVariant;
  durationMs?: number;
};

type ToastContextValue = {
  toast: (input: ToastInput) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const toast = useCallback((input: ToastInput) => {
    const variant = input.variant ?? "info";
    const options = {
      description: input.title ? input.description : undefined,
      duration: input.durationMs ?? 2600,
      className: "!border-[var(--color-border)] !bg-[var(--color-surface)] !text-[var(--color-foreground)] !shadow-[var(--shadow-lg)]",
      descriptionClassName: "!text-[var(--color-foreground-muted)]",
    };

    if (input.title) {
      if (variant === "success") {
        sonnerToast.success(input.title, options);
        return;
      }
      if (variant === "error") {
        sonnerToast.error(input.title, options);
        return;
      }
      sonnerToast(input.title, options);
      return;
    }

    if (variant === "success") {
      sonnerToast.success(input.description, { ...options, description: undefined });
      return;
    }
    if (variant === "error") {
      sonnerToast.error(input.description, { ...options, description: undefined });
      return;
    }
    sonnerToast(input.description, { ...options, description: undefined });
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster position="top-right" richColors />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast 必须在 ToastProvider 内使用");
  }
  return ctx;
}
