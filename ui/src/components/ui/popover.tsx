import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/lib/utils";

// Wired to real MOZI CSS variables, not shadcn's default tokens (bg-popover,
// text-popover-foreground, border) which this project's Tailwind config does
// not define — using them would render a transparent, colorless popover.

const Popover = PopoverPrimitive.Root;

const PopoverTrigger = PopoverPrimitive.Trigger;

const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(({ className, align = "center", sideOffset = 6, style, ...props }, ref) => (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={12}
      className={cn(
        "z-50 rounded-xl border p-2 shadow-2xl outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className,
      )}
      style={{
        background: "var(--surface-overlay)",
        borderColor: "var(--border-medium)",
        boxShadow: "var(--composer-shadow-active)",
        color: "var(--text-primary)",
        ...style,
      }}
      {...props}
    />
  </PopoverPrimitive.Portal>
));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent };
