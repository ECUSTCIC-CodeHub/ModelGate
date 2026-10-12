"use client";

import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import { cn } from "@/lib/shared/utils";

function useOverflow(viewportRef: React.RefObject<HTMLDivElement | null>) {
  const [overflowing, setOverflowing] = React.useState(false);
  const rafRef = React.useRef(0);

  // viewportRef 由 useRef 创建、引用终身不变，effect 只在挂载后跑一次即可；
  // 后续几何变化全部走 ResizeObserver 与 scroll 监听。
  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const measure = () => {
      // clientHeight 为 0 时不判定为溢出：Radix 侧比例恒为 0、缩略图不会渲染，
      // 此时显示滚动条只会得到一条可见却无滑块的空条。
      const next = viewport.clientHeight > 0 && viewport.scrollHeight > viewport.clientHeight;
      setOverflowing((prev) => (prev === next ? prev : next));
    };
    const schedule = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(measure);
    };

    schedule();

    // Viewport 自身尺寸变化不足够：内容变高不会改变 Viewport 尺寸，
    // 因此 Radix 的内容 wrapper（Viewport 首个子元素）也要观测。
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    const content = viewport.firstElementChild;
    if (content) observer.observe(content);
    viewport.addEventListener("scroll", schedule, { passive: true });

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
      viewport.removeEventListener("scroll", schedule);
    };
  }, [viewportRef]);

  return overflowing;
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, type = "always", ...props }, ref) => {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const overflowing = useOverflow(viewportRef);

  return (
    // type="always" 是必需的：Radix 默认 type="hover" 下 ScrollAreaScrollbarHover
    // 用 Presence 把滚动条挡在 DOM 之外，不挂载就不会有滚动条可用。
    // 显隐本身不由 type 决定，而由 useOverflow 的溢出判断控制。
    <ScrollAreaPrimitive.Root
      ref={ref}
      type={type}
      data-overflow={overflowing ? "true" : "false"}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className="h-full w-full rounded-[inherit]">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar visible={overflowing} />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
});
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

type ScrollBarProps = React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar> & {
  visible?: boolean;
};

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  ScrollBarProps
>(({ className, orientation = "vertical", visible = true, ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none p-0.5 transition-opacity duration-200",
      orientation === "vertical" && "h-full w-2.5 border-l border-l-transparent",
      orientation === "horizontal" && "h-2.5 flex-col border-t border-t-transparent",
      visible ? "opacity-100" : "pointer-events-none opacity-0",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-[var(--color-accent-muted)] transition-colors duration-200 hover:bg-[var(--color-accent)]" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
