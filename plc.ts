/**
 * PLC Runtime
 *
 * Factory function for creating and running a PLC instance.
 */

import type { PlcConfig, Plc, PlcRuntime } from "./types/plc.ts";
import type {
  PlcVariablesConfig,
  PlcVariablesRuntime,
  PlcVariable,
} from "./types/variables.ts";
import { setupNats } from "./nats.ts";
import { createLogger, LogLevel, type Log } from "@joyautomation/coral";

/** Default logger for the PLC module */
const log = createLogger("plc", LogLevel.info);

/**
 * Initialize runtime variables from configuration.
 * Copies config and adds default values.
 */
function initializeVariables<V extends PlcVariablesConfig>(
  config: V,
): PlcVariablesRuntime<V> {
  const runtime = {} as PlcVariablesRuntime<V>;

  for (const [id, variable] of Object.entries(config)) {
    // Create runtime variable with value set to default
    (runtime as Record<string, PlcVariable>)[id] = {
      ...variable,
      value: variable.default,
    } as PlcVariable;
  }

  return runtime;
}

/**
 * Create and start a PLC instance.
 *
 * @param config - PLC configuration
 * @returns Running PLC instance with stop() method
 *
 * @example
 * ```typescript
 * const plc = await createPlc({
 *   projectId: "my-plc",
 *   variables: {
 *     temperature: {
 *       id: "temperature",
 *       description: "Temperature sensor",
 *       datatype: "number",
 *       default: 20,
 *     },
 *   },
 *   tasks: {
 *     main: {
 *       name: "Main Task",
 *       scanRate: 1000,
 *       program: (variables, updateVariable) => {
 *         updateVariable("temperature", variables.temperature.value + 0.1);
 *       },
 *     },
 *   },
 *   nats: { servers: "nats://localhost:4222" },
 * });
 *
 * // Later, to stop:
 * await plc.stop();
 * ```
 */
export async function createPlc<V extends PlcVariablesConfig>(
  config: PlcConfig<V>,
): Promise<Plc<V>> {
  log.info(`Starting PLC: ${config.projectId}`);

  // Initialize runtime state
  const runtime: PlcRuntime<V> = {
    variables: initializeVariables(config.variables),
    taskIntervals: new Map(),
    running: false,
  };

  // Setup NATS connection
  const natsManager = await setupNats(
    config.nats,
    runtime.variables as Record<string, PlcVariable>,
    config.projectId,
    (variableId, value) => {
      // Handle incoming NATS commands
      const variable = runtime.variables[variableId as keyof V];
      if (variable) {
        log.debug(`[NATS] ${String(variableId)} <- ${value}`);
        (variable as PlcVariable).value = value;
      }
    },
  );

  // Create updateVariable function for tasks
  const createUpdateVariable = () => {
    return <K extends keyof V>(
      variableId: K,
      value: number | boolean | string | Record<string, unknown>,
    ) => {
      const variable = runtime.variables[variableId];
      if (variable) {
        (variable as PlcVariable).value = value as PlcVariable["value"];
        // Publish to NATS
        natsManager.publish(
          variableId as string,
          value as number | boolean | string | Record<string, unknown>,
          (variable as PlcVariable).datatype,
        ).catch((err) => {
          log.error(`Failed to publish ${String(variableId)}:`, err);
        });
      }
    };
  };

  // Start tasks
  log.info(`Starting ${Object.keys(config.tasks).length} task(s)...`);
  for (const [taskId, task] of Object.entries(config.tasks)) {
    log.info(`  [${taskId}] ${task.name} @ ${task.scanRate}ms`);

    const updateVariable = createUpdateVariable();
    const interval = setInterval(async () => {
      try {
        await task.program(runtime.variables, updateVariable);
      } catch (error) {
        log.error(`Error in task ${taskId}:`, error);
      }
    }, task.scanRate);

    runtime.taskIntervals.set(taskId, interval);
  }

  runtime.running = true;

  // Publish initial values for all variables so downstream services know about them
  log.info("Publishing initial variable values...");
  for (const [variableId, variable] of Object.entries(runtime.variables)) {
    const v = variable as PlcVariable;
    await natsManager.publish(variableId, v.value, v.datatype);
  }

  log.info(`PLC running. Project: ${config.projectId}`);
  log.info(`Publishing to: plc.data.${config.projectId}.<variableId>`);
  log.info(`Listening on: ${config.projectId}/<variableId>`);

  // Return PLC instance
  return {
    config,
    runtime,
    stop: async () => {
      log.info("Stopping PLC...");
      runtime.running = false;

      // Stop all tasks
      for (const [taskId, interval] of runtime.taskIntervals) {
        clearInterval(interval);
        log.debug(`  Stopped task: ${taskId}`);
      }
      runtime.taskIntervals.clear();

      // Disconnect NATS
      await natsManager.disconnect();
      log.info("PLC stopped.");
    },
  };
}

// Re-export coral for downstream projects
export { createLogger, LogLevel, type Log } from "@joyautomation/coral";
