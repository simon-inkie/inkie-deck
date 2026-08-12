/**
 * ui/avatar.tsx - agent avatar: real image when one exists, initials fallback.
 *
 * TASK-457: optional src renders the agent's avatar.png (served by
 * /avatars/:agent with an mtime cache-bust). No src - or an image that
 * fails to load - falls back to the v1 initials disc, so the worst avatar
 * outcome is exactly the original render.
 *
 * The initials tint is picked deterministically from the name so each agent
 * keeps a stable colour across the sidebar, app bar and bubbles
 * (teal / burnt-orange / magenta / gold - the Inkie accent set).
 * No Radix needed. ASCII only - no em-dashes (FND-05).
 */
import { useState } from "react";
import { cn } from "~/lib/utils";

// Inkie accent set (token-aligned). Deterministic pick by name hash.
const TINTS = [
  "bg-[#1a7a7a]/15 text-[#1a7a7a]", // teal (primary)
  "bg-[#e8752a]/15 text-[#e8752a]", // burnt-orange (accent)
  "bg-[#c2356b]/15 text-[#c2356b]", // magenta (destructive)
  "bg-[#d4a029]/20 text-[#9a7414]", // gold
] as const;

function tintFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return TINTS[Math.abs(hash) % TINTS.length]!;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function Avatar({
  name,
  src,
  className,
}: {
  name: string;
  /** Avatar image URL (TASK-457). Absent or broken -> initials fallback. */
  src?: string;
  className?: string;
}) {
  // Remember WHICH src failed - a replaced file arrives as a new ?v= URL,
  // so the retry happens naturally without a remount.
  const [erroredSrc, setErroredSrc] = useState<string | undefined>(undefined);
  const showImage = src !== undefined && src !== erroredSrc;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full font-display text-sm font-bold uppercase tracking-tight",
        // Tint only matters for the initials render; harmless under an image.
        tintFor(name),
        className
      )}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={() => setErroredSrc(src)}
          data-testid="avatar-image"
        />
      ) : (
        initialsFor(name)
      )}
    </span>
  );
}
