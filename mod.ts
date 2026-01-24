/**
 * @tentacle/plc
 *
 * A lightweight PLC runtime for Deno with NATS integration.
 *
 * @example
 * ```typescript
 * import { createPlc, type PlcVariableNumberConfig } from "@tentacle/plc";
 *
 * const variables = {
 *   temperature: {
 *     id: "temperature",
 *     description: "Temperature sensor",
 *     datatype: "number",
 *     default: 20,
 *     source: { bidirectional: true },
 *   } satisfies PlcVariableNumberConfig,
 * };
 *
 * const plc = await createPlc({
 *   projectId: "my-plc",
 *   variables,
 *   tasks: {
 *     main: {
 *       name: "Main Task",
 *       description: "Main control loop",
 *       scanRate: 1000,
 *       program: (vars, update) => {
 *         update("temperature", vars.temperature.value + 0.1);
 *       },
 *     },
 *   },
 *   nats: { servers: "nats://localhost:4222" },
 * });
 *
 * // Graceful shutdown
 * Deno.addSignalListener("SIGINT", () => plc.stop());
 * ```
 */

// Main factory function
export { createPlc, createLogger, LogLevel, type Log } from "./plc.ts";

// Configuration types
export type {
  PlcConfig,
  PlcTask,
  PlcRuntime,
  Plc,
} from "./types/plc.ts";

// Variable configuration types (what user defines)
export type {
  PlcVariableNumberConfig,
  PlcVariableBooleanConfig,
  PlcVariableStringConfig,
  PlcVariableUdtConfig,
  PlcVariableConfig,
  PlcVariablesConfig,
  PlcVariablesRuntime,
  VariableSource,
  DeadBandConfig,
  NatsConfig,
} from "./types/variables.ts";

// Variable runtime types (with values)
export type {
  PlcVariableNumber,
  PlcVariableBoolean,
  PlcVariableString,
  PlcVariableUdt,
  PlcVariable,
  PlcVariables,
} from "./types/variables.ts";

// Type guards
export {
  isVariableNumber,
  isVariableBoolean,
  isVariableString,
  isVariableUdt,
  isVariableType,
} from "./types/variables.ts";

// NATS utilities (for advanced usage)
export { parseValue } from "./nats.ts";
export type { NatsManager } from "./nats.ts";
