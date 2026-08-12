/**
 * ui/select.tsx - shadcn-style Select using native HTML (no Radix dep).
 * @radix-ui/react-select is not installed; this is a styled native wrapper
 * that matches the Inkie design system.
 * ASCII only - no em-dashes (FND-05).
 */
import * as React from "react";
import { cn } from "~/lib/utils";

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "flex h-9 w-full appearance-none rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";

export function SelectItem({
  value,
  children,
  ...props
}: React.OptionHTMLAttributes<HTMLOptionElement> & { value: string }) {
  return (
    <option value={value} {...props}>
      {children}
    </option>
  );
}
