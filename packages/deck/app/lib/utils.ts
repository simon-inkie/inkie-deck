/**
 * utils.ts - shared client+server UI helpers.
 *
 * cn(): the standard shadcn class-merger. clsx resolves conditional class
 * inputs, tailwind-merge dedupes conflicting Tailwind utilities (last wins).
 *
 * No .server suffix: pure, importable from components.
 * ASCII only - no em-dashes.
 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
