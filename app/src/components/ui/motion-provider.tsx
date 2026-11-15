"use client";
import type { ReactNode } from "react";
import { LazyMotion } from "motion/react";

const features = () => import("./motion-features").then((m) => m.default);

/**
 * Every animated element is an `m.*` component; the animation features are fetched once, after hydration.
 * Reduced motion is still decided by <MotionConfig reducedMotion="user"> in the app shell (unchanged).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <LazyMotion features={features}>{children}</LazyMotion>;
}
