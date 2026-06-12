"use client";

import { createContext, ReactNode, useCallback, useContext, useMemo } from "react";
import { Toaster, toast as sonnerToast } from "sonner";

type ToastVariant = "success" | "error" | "warning" | "info";

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

const TOAST_BASE_CLASS = [
  "!rounded-lg",
  "!border",
  "!border-[var(--color-border-strong)]",
  "!bg-[var(--color-popover)]",
  "!px-4",
  "!py-3.5",
  "!text-[var(--color-foreground)]",
  "!shadow-[0_18px_50px_rgba(15,23,42,0.22)]",
  "!backdrop-blur-none",
  "!gap-3",
  "dark:!shadow-[0_20px_56px_rgba(0,0,0,0.55)]",
].join(" ");

const TOAST_VARIANT_CLASS: Record<ToastVariant, string> = {
  success: "!border-l-4 !border-l-emerald-500",
  error: "!border-l-4 !border-l-[var(--color-destructive)]",
  warning: "!border-l-4 !border-l-amber-500",
  info: "!border-l-4 !border-l-[var(--color-accent)]",
};

const TOAST_TITLE_CLASS = "!font-medium !leading-5 !text-[var(--color-foreground)]";
const TOAST_DESCRIPTION_CLASS = "!leading-5 !text-[var(--color-foreground-secondary)]";

export function ToastProvider({ children }: { children: ReactNode }) {
  const toast = useCallback((input: ToastInput) => {
    const variant = input.variant ?? "info";
    const options = {
      description: input.title ? input.description : undefined,
      duration: input.durationMs ?? 2600,
      className: `${TOAST_BASE_CLASS} ${TOAST_VARIANT_CLASS[variant]}`,
      descriptionClassName: TOAST_DESCRIPTION_CLASS,
      classNames: {
        content: "!gap-1",
        description: TOAST_DESCRIPTION_CLASS,
        icon: "!text-inherit",
        title: TOAST_TITLE_CLASS,
      },
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
      if (variant === "warning") {
        sonnerToast.warning(input.title, options);
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
    if (variant === "warning") {
      sonnerToast.warning(input.description, { ...options, description: undefined });
      return;
    }
    sonnerToast(input.description, { ...options, description: undefined });
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster position="top-right" richColors={false} />
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
