/**
 * PLC Configuration Types
 *
 * Defines the structure for configuring and running a PLC.
 */

import type {
  NatsConfig,
  PlcVariablesConfig,
  PlcVariablesRuntime,
} from "./variables.ts";

/**
 * PLC Task Definition
 *
 * Tasks are programs that run on a scan rate, with access to variables.
 */
export type PlcTask<V extends PlcVariablesConfig> = {
  /** Task name for identification */
  name: string;
  /** Human-readable description */
  description: string;
  /** Scan rate in milliseconds */
  scanRate: number;
  /** Program function executed each scan */
  program: (
    variables: PlcVariablesRuntime<V>,
    updateVariable: <K extends keyof V>(
      variableId: K,
      value: V[K] extends { datatype: "number" } ? number
        : V[K] extends { datatype: "boolean" } ? boolean
        : V[K] extends { datatype: "string" } ? string
        : V[K] extends { datatype: "udt" } ? V[K]["default"]
        : never,
    ) => void,
  ) => Promise<void> | void;
};

/**
 * PLC Configuration
 *
 * The main configuration object for creating a PLC instance.
 */
export type PlcConfig<V extends PlcVariablesConfig> = {
  /** Unique project identifier (used for NATS topics and KV buckets) */
  projectId: string;
  /** Variable definitions */
  variables: V;
  /** Task definitions (map of task ID to task config) */
  tasks: Record<string, PlcTask<V>>;
  /** NATS connection configuration */
  nats: NatsConfig;
};

/**
 * PLC Runtime State
 *
 * The runtime state of a running PLC instance.
 */
export type PlcRuntime<V extends PlcVariablesConfig> = {
  /** Runtime variables with current values */
  variables: PlcVariablesRuntime<V>;
  /** Active task intervals */
  taskIntervals: Map<string, ReturnType<typeof setInterval>>;
  /** Whether the PLC is running */
  running: boolean;
};

/**
 * PLC Instance
 *
 * A running PLC instance with runtime state and control methods.
 */
export type Plc<V extends PlcVariablesConfig> = {
  /** Original configuration */
  config: PlcConfig<V>;
  /** Runtime state */
  runtime: PlcRuntime<V>;
  /** Stop the PLC and clean up resources */
  stop: () => Promise<void>;
};
