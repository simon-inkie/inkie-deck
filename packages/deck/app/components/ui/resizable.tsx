/**
 * ui/resizable.tsx - shadcn-shape wrappers around react-resizable-panels
 * (TASK-456).
 *
 * Hand-written in this repo's ui/ style (no CLI scaffold), following the
 * shadcn source shape: PanelGroup / Panel re-exported with our class
 * defaults, plus a Handle with an optional visible grip. The handle is
 * keyboard-operable out of the box (role=separator, arrow keys).
 *
 * VERSION PIN: react-resizable-panels@3 deliberately. v4 is a full API
 * rewrite (Group/Panel/Separator, autoSaveId removed in favour of
 * useDefaultLayout) - the shadcn shape and the free localStorage
 * persistence both live in v3. Upgrade is its own ticket when shadcn moves.
 *
 * No .server imports - FND-02. ASCII only - no em-dashes - FND-05.
 */
import { GripVertical } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "~/lib/utils";

function ResizablePanelGroup({
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelGroup>) {
  return (
    <ResizablePrimitive.PanelGroup
      className={cn(
        "flex h-full w-full data-[panel-group-direction=vertical]:flex-col",
        className
      )}
      {...props}
    />
  );
}

const ResizablePanel = ResizablePrimitive.Panel;

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.PanelResizeHandle> & {
  withHandle?: boolean;
}) {
  return (
    <ResizablePrimitive.PanelResizeHandle
      className={cn(
        "relative flex w-px items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1.5 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[resize-handle-state=drag]:bg-primary data-[resize-handle-state=hover]:bg-primary/60",
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className="z-10 flex h-6 w-3.5 items-center justify-center rounded-sm border border-border bg-card">
          <GripVertical className="size-2.5 text-muted-foreground" />
        </div>
      ) : null}
    </ResizablePrimitive.PanelResizeHandle>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
