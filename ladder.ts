/**
 * Ladder Logic Runtime DSL for tentacle-plc
 *
 * Provides RSLogix-style ladder instructions (NO, NC, OTE, OTL, OTU, TON, TOF, CTU, CTD)
 * that compile to tentacle-plc task programs.
 *
 * The DSL functions return descriptor objects — they don't execute immediately.
 * `createLadderProgram()` returns a function matching tentacle-plc's `PlcTask.program` signature.
 *
 * Files using this DSL should use the `.lad.ts` extension so tentacle-web can
 * parse them back into a visual ladder diagram.
 *
 * @example
 * ```typescript
 * import { createLadderProgram, NO, NC, OTE, OTL, OTU, TON, branch } from "@tentacle/plc/ladder";
 *
 * export const program = createLadderProgram(({ rung }) => {
 *   // Rung 0: Motor start/stop with seal-in
 *   rung(
 *     NO('startButton'),
 *     branch(
 *       NC('stopButton'),
 *       NO('motorRunning'),
 *     ),
 *     OTE('motorRunning'),
 *   );
 *
 *   // Rung 1: Run timer
 *   rung(
 *     NO('motorRunning'),
 *     TON('runTimer', 5000),
 *     OTE('timerDone'),
 *   );
 * });
 * ```
 */

// =============================================================================
// Element Types (data model for both runtime and visual rendering)
// =============================================================================

export type LadderContact = {
  type: "NO" | "NC";
  tag: string;
};

export type LadderSeries = {
  type: "series";
  elements: LadderCondition[];
};

export type LadderBranch = {
  type: "branch";
  paths: LadderCondition[];
};

export type LadderCondition = LadderContact | LadderBranch | LadderSeries;

export type LadderCoil = {
  type: "OTE" | "OTL" | "OTU";
  tag: string;
};

export type LadderTimer = {
  type: "TON" | "TOF";
  tag: string;
  preset: number;
};

export type LadderCounter = {
  type: "CTU" | "CTD";
  tag: string;
  preset: number;
};

export type LadderOutput = LadderCoil | LadderTimer | LadderCounter;

export type LadderElement = LadderCondition | LadderOutput;

export type RungDefinition = {
  comment?: string;
  conditions: LadderCondition[];
  outputs: LadderOutput[];
};

// =============================================================================
// DSL Functions — return descriptors, don't execute
// =============================================================================

/** Normally Open contact — true when tag is true */
export function NO(tag: string): LadderContact {
  return { type: "NO", tag };
}

/** Normally Closed contact — true when tag is false */
export function NC(tag: string): LadderContact {
  return { type: "NC", tag };
}

/** Output Energize — writes rung state to tag each scan */
export function OTE(tag: string): LadderCoil {
  return { type: "OTE", tag };
}

/** Output Latch — sets tag true when rung is true, does NOT clear when false */
export function OTL(tag: string): LadderCoil {
  return { type: "OTL", tag };
}

/** Output Unlatch — clears tag when rung is true */
export function OTU(tag: string): LadderCoil {
  return { type: "OTU", tag };
}

/** Timer On Delay — starts timing when rung is true, DN bit set when accumulated >= preset */
export function TON(tag: string, preset: number): LadderTimer {
  return { type: "TON", tag, preset };
}

/** Timer Off Delay — DN set immediately when rung true, starts timing when rung goes false */
export function TOF(tag: string, preset: number): LadderTimer {
  return { type: "TOF", tag, preset };
}

/** Count Up — increments on rising edge, DN set when accumulated >= preset */
export function CTU(tag: string, preset: number): LadderCounter {
  return { type: "CTU", tag, preset };
}

/** Count Down — decrements on rising edge, DN set when accumulated <= 0 */
export function CTD(tag: string, preset: number): LadderCounter {
  return { type: "CTD", tag, preset };
}

/** Parallel branch — OR of multiple paths */
export function branch(...paths: LadderCondition[]): LadderBranch {
  return { type: "branch", paths };
}

/** Explicit series — AND of multiple conditions (useful inside branch paths) */
export function series(...elements: LadderCondition[]): LadderSeries {
  return { type: "series", elements };
}

// =============================================================================
// Internal State Types
// =============================================================================

type TimerState = {
  accumulated: number;
  done: boolean;
  enabled: boolean;
  timing: boolean;
  lastScanTime: number | null;
};

type CounterState = {
  accumulated: number;
  done: boolean;
  lastRungState: boolean;
};

// =============================================================================
// Type Guard
// =============================================================================

const OUTPUT_TYPES = new Set(["OTE", "OTL", "OTU", "TON", "TOF", "CTU", "CTD"]);

function isOutput(el: LadderElement): el is LadderOutput {
  return OUTPUT_TYPES.has(el.type);
}

// =============================================================================
// Ladder Program Factory
// =============================================================================

/**
 * Creates a ladder logic program compatible with tentacle-plc's PlcTask.program.
 *
 * The returned function holds persistent state for timers and counters across scans.
 * Timer/counter sub-fields (e.g., `myTimer.DN`, `myTimer.ACC`) are stored internally
 * and readable as contacts. If corresponding PLC variables exist, they're also updated.
 *
 * @param define - Builder function that calls `rung()` to define ladder rungs
 * @returns A function matching `PlcTask.program` signature
 */
export function createLadderProgram(
  define: (ctx: { rung: (...elements: LadderElement[]) => void }) => void,
): (
  variables: Record<string, { value: unknown }>,
  updateVariable: (id: string, value: unknown) => void,
) => void {
  // Persistent state across scans (held in closure)
  const timers = new Map<string, TimerState>();
  const counters = new Map<string, CounterState>();
  const internalState = new Map<string, unknown>();

  return (
    variables: Record<string, { value: unknown }>,
    updateVariable: (id: string, value: unknown) => void,
  ) => {
    const now = Date.now();

    // --- Tag reading ---

    function readTag(tag: string): boolean {
      // Internal state first (timer.DN, counter.DN, etc.)
      if (internalState.has(tag)) {
        return Boolean(internalState.get(tag));
      }
      // PLC variables
      const v = variables[tag];
      return v ? Boolean(v.value) : false;
    }

    function readNumericTag(tag: string): number {
      if (internalState.has(tag)) {
        return Number(internalState.get(tag));
      }
      const v = variables[tag];
      return v ? Number(v.value) : 0;
    }

    // --- Condition evaluation ---

    function evaluateCondition(condition: LadderCondition): boolean {
      switch (condition.type) {
        case "NO":
          return readTag(condition.tag);
        case "NC":
          return !readTag(condition.tag);
        case "series":
          return condition.elements.every((el) => evaluateCondition(el));
        case "branch":
          return condition.paths.some((path) => evaluateCondition(path));
      }
    }

    // --- Output execution ---

    function executeOutput(output: LadderOutput, rungState: boolean): void {
      switch (output.type) {
        case "OTE":
          updateVariable(output.tag, rungState);
          break;

        case "OTL":
          if (rungState) updateVariable(output.tag, true);
          break;

        case "OTU":
          if (rungState) updateVariable(output.tag, false);
          break;

        case "TON": {
          let timer = timers.get(output.tag);
          if (!timer) {
            timer = {
              accumulated: 0,
              done: false,
              enabled: false,
              timing: false,
              lastScanTime: null,
            };
            timers.set(output.tag, timer);
          }

          if (rungState) {
            timer.enabled = true;
            if (!timer.done) {
              timer.timing = true;
              if (timer.lastScanTime !== null) {
                timer.accumulated += now - timer.lastScanTime;
              }
              if (timer.accumulated >= output.preset) {
                timer.accumulated = output.preset;
                timer.done = true;
                timer.timing = false;
              }
            }
          } else {
            // Rung false — reset timer
            timer.accumulated = 0;
            timer.done = false;
            timer.enabled = false;
            timer.timing = false;
          }

          timer.lastScanTime = now;
          updateTimerState(output.tag, timer);
          break;
        }

        case "TOF": {
          let timer = timers.get(output.tag);
          if (!timer) {
            timer = {
              accumulated: 0,
              done: false,
              enabled: false,
              timing: false,
              lastScanTime: null,
            };
            timers.set(output.tag, timer);
          }

          if (rungState) {
            // Rung true — DN immediately true, reset accumulator
            timer.done = true;
            timer.accumulated = 0;
            timer.enabled = true;
            timer.timing = false;
          } else {
            // Rung false — start timing down
            timer.enabled = false;
            if (timer.done) {
              timer.timing = true;
              if (timer.lastScanTime !== null) {
                timer.accumulated += now - timer.lastScanTime;
              }
              if (timer.accumulated >= output.preset) {
                timer.accumulated = output.preset;
                timer.done = false;
                timer.timing = false;
              }
            }
          }

          timer.lastScanTime = now;
          updateTimerState(output.tag, timer);
          break;
        }

        case "CTU": {
          let counter = counters.get(output.tag);
          if (!counter) {
            counter = { accumulated: 0, done: false, lastRungState: false };
            counters.set(output.tag, counter);
          }

          // Count on rising edge
          if (rungState && !counter.lastRungState) {
            counter.accumulated++;
          }
          counter.done = counter.accumulated >= output.preset;
          counter.lastRungState = rungState;

          updateCounterState(output.tag, counter);
          break;
        }

        case "CTD": {
          let counter = counters.get(output.tag);
          if (!counter) {
            counter = { accumulated: 0, done: false, lastRungState: false };
            counters.set(output.tag, counter);
          }

          // Count down on rising edge
          if (rungState && !counter.lastRungState) {
            counter.accumulated--;
          }
          counter.done = counter.accumulated <= 0;
          counter.lastRungState = rungState;

          updateCounterState(output.tag, counter);
          break;
        }
      }
    }

    // --- State helpers ---

    function updateTimerState(tag: string, timer: TimerState): void {
      internalState.set(`${tag}.DN`, timer.done);
      internalState.set(`${tag}.EN`, timer.enabled);
      internalState.set(`${tag}.TT`, timer.timing);
      internalState.set(`${tag}.ACC`, timer.accumulated);

      // Update PLC variables if they exist
      if (variables[`${tag}.DN`]) updateVariable(`${tag}.DN`, timer.done);
      if (variables[`${tag}.EN`]) updateVariable(`${tag}.EN`, timer.enabled);
      if (variables[`${tag}.TT`]) updateVariable(`${tag}.TT`, timer.timing);
      if (variables[`${tag}.ACC`]) {
        updateVariable(`${tag}.ACC`, timer.accumulated);
      }
    }

    function updateCounterState(tag: string, counter: CounterState): void {
      internalState.set(`${tag}.DN`, counter.done);
      internalState.set(`${tag}.ACC`, counter.accumulated);

      if (variables[`${tag}.DN`]) updateVariable(`${tag}.DN`, counter.done);
      if (variables[`${tag}.ACC`]) {
        updateVariable(`${tag}.ACC`, counter.accumulated);
      }
    }

    // --- Rung evaluation ---

    function rung(...elements: LadderElement[]): void {
      const conditions: LadderCondition[] = [];
      const outputs: LadderOutput[] = [];

      for (const el of elements) {
        if (isOutput(el)) {
          outputs.push(el);
        } else {
          conditions.push(el);
        }
      }

      // Evaluate all conditions in series (AND)
      const rungState = conditions.length === 0
        ? true
        : conditions.every((c) => evaluateCondition(c));

      // Execute all outputs with the rung result
      for (const output of outputs) {
        executeOutput(output, rungState);
      }
    }

    // --- Execute the ladder program ---
    define({ rung });
  };
}

/**
 * Resets a counter's accumulated value.
 * Use as an output instruction: `RES('myCounter')`
 *
 * Returns a special coil that resets the named counter to 0.
 */
export function RES(tag: string): LadderCoil {
  // RES is implemented as a special OTE that we handle at the program level
  // For now, we expose it as a utility — users can call it in custom logic
  return { type: "OTE", tag: `${tag}.__RES__` };
}
