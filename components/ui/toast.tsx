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
      sonnerToast.success(input.description, { duration: options.duration });
      return;
    }
    if (variant === "error") {
      sonnerToast.error(input.description, { duration: options.duration });
      return;
    }
    sonnerToast(input.description, { duration: options.duration });
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster
        position="top-right"
        richColors
        toastOptions={{
          className: "!border-white/10 !bg-[rgba(10,15,27,0.96)] !text-zinc-100",
          descriptionClassName: "!text-zinc-400",
        }}
      />
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
