/**
 * ui/switch.tsx - shadcn-style Switch using a native checkbox (no Radix dep).
 * @radix-ui/react-switch is not installed; this is a styled checkbox that
 * renders as a pill toggle matching the Inkie design system.
 * ASCII only - no em-dashes (FND-05).
 */
import * as React from "react";
import { cn } from "~/lib/utils";

export interface SwitchProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Label shown next to the toggle (optional). */
  label?: string;
}

export const Switch = React.forwardRef<HTMLInputElement, SwitchProps>(
  ({ className, label, id, ...props }, ref) => (
    <label
      htmlFor={id}
      className="inline-flex cursor-pointer items-center gap-2"
    >
      <span className="relative inline-flex shrink-0">
        <input
          id={id}
          ref={ref}
          type="checkbox"
          className="peer sr-only"
          {...props}
        />
        <span
          className={cn(
            "block h-5 w-9 rounded-full border border-border bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
            className
          )}
        />
        <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform peer-checked:translate-x-4" />
      </span>
      {label ? <span className="text-sm font-medium">{label}</span> : null}
    </label>
  )
);
Switch.displayName = "Switch";
