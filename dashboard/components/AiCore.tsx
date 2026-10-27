"use client";

/**
 * The animated AI core: three rings, a glowing center, and a waveform. The state sets the color and the speed.
 * The motion is CSS only and stops when the visitor asks for reduced motion. The word for the state is always
 * on the page, so the color never carries the meaning alone.
 */
import { CORE_STATE_LABEL, type CoreState } from "@/lib/core";

const BARS = 21;

export default function AiCore({ state }: { state: CoreState }) {
  return (
    <div className={`ai-core ai-core-${state}`} role="img" aria-label={`TITAN core: ${CORE_STATE_LABEL[state]}`}>
      <div className="ai-core-ring ai-core-ring-a" aria-hidden="true" />
      <div className="ai-core-ring ai-core-ring-b" aria-hidden="true" />
      <div className="ai-core-ring ai-core-ring-c" aria-hidden="true" />
      <div className="ai-core-orb" aria-hidden="true">
        <span className="ai-core-glyph">T</span>
      </div>
      <div className="ai-core-wave" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <span key={i} style={{ ["--i" as string]: i }} />
        ))}
      </div>
    </div>
  );
}
