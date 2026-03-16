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
import { setupNats, type NatsManager } from "./nats.ts";
import { enableNatsLogging, createPlcLogger } from "./logger.ts";

const log = createPlcLogger("plc");

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

  // Create stop function reference so shutdown handler can call it
  let stopFn: (() => Promise<void>) | null = null;

  // Deferred publish — assigned after setupNats returns
  let natsPublish: NatsManager["publish"] | null = null;

  // UDT member update: debounce and publish parent UDT once per batch.
  const pendingUdtPublish = new Set<string>();
  let udtPublishTimer: ReturnType<typeof setTimeout> | null = null;

  const flushUdtPublishes = () => {
    udtPublishTimer = null;
    for (const udtVarId of pendingUdtPublish) {
      const udtVar = runtime.variables[udtVarId as keyof V] as PlcVariable | undefined;
      if (udtVar && udtVar.datatype === "udt") {
        natsPublish?.(udtVarId, udtVar.value, "udt").catch((err) => {
          log.error(`Failed to publish UDT ${udtVarId}:`, err);
        });
      }
    }
    pendingUdtPublish.clear();
  };

  /** Set a value at a dotted path (e.g., "timer.ACC") in a nested object */
  const setNestedValue = (obj: Record<string, unknown>, path: string, value: unknown) => {
    const parts = path.split(".");
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof current[parts[i]] !== "object" || current[parts[i]] === null) {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  };

  /** Called by nats.ts when a UDT member's EIP data arrives */
  const handleUdtMemberUpdate = (udtVarId: string, memberPath: string, value: number | boolean | string) => {
    const udtVar = runtime.variables[udtVarId as keyof V] as PlcVariable | undefined;
    if (udtVar && udtVar.datatype === "udt" && typeof udtVar.value === "object" && udtVar.value !== null) {
      setNestedValue(udtVar.value as Record<string, unknown>, memberPath, value);
      pendingUdtPublish.add(udtVarId);
      if (!udtPublishTimer) {
        udtPublishTimer = setTimeout(flushUdtPublishes, 0);
      }
    }
  };

  // Setup NATS connection (with shutdown callback)
  const natsManager = await setupNats(
    config.nats,
    runtime.variables as Record<string, PlcVariable>,
    config.projectId,
    (variableId, value) => {
      // Handle incoming variable updates (from EIP, NATS sources, etc.)
      const variable = runtime.variables[variableId as keyof V];
      if (variable) {
        const v = variable as PlcVariable;
        // Skip if value hasn't actually changed (RBE at PLC level)
        if (v.value === value) return;
        if (typeof value === "object" && value !== null &&
            typeof v.value === "object" && v.value !== null &&
            JSON.stringify(v.value) === JSON.stringify(value)) return;
        log.debug(`[NATS] ${String(variableId)} <- ${value}`);
        v.value = value as PlcVariable["value"];
        // Re-publish so downstream services (MQTT, etc.) see the update
        natsPublish?.(
          variableId,
          value,
          v.datatype,
        ).catch((err) => {
          log.error(`Failed to re-publish ${String(variableId)}:`, err);
        });
      }
    },
    handleUdtMemberUpdate,
    async () => {
      // Shutdown callback — triggered when shutdown command received via NATS
      if (stopFn) {
        await stopFn();
      }
      Deno.exit(0);
    },
  );

  // Wire up deferred publish now that natsManager exists
  natsPublish = natsManager.publish;

  // Enable NATS log streaming for all loggers
  enableNatsLogging(natsManager.connection, "plc", config.projectId);

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
  // Skip UDT members — they're represented inside their parent UDT template
  log.info("Publishing initial variable values...");
  for (const [variableId, variable] of Object.entries(runtime.variables)) {
    const v = variable as PlcVariable;
    await natsManager.publish(variableId, v.value, v.datatype);
  }

  log.info(`PLC running. Project: ${config.projectId}`);
  log.info(`Publishing to: plc.data.${config.projectId}.<variableId>`);
  log.info(`Listening on: ${config.projectId}/<variableId>`);

  // Define stop function
  const stop = async () => {
    log.info("Stopping PLC...");
    runtime.running = false;

    // Cancel pending UDT debounce
    if (udtPublishTimer) {
      clearTimeout(udtPublishTimer);
      udtPublishTimer = null;
    }

    // Stop all tasks
    for (const [taskId, interval] of runtime.taskIntervals) {
      clearInterval(interval);
      log.debug(`  Stopped task: ${taskId}`);
    }
    runtime.taskIntervals.clear();

    // Disconnect NATS (also cleans up heartbeat)
    await natsManager.disconnect();
    log.info("PLC stopped.");
  };

  // Wire up shutdown callback
  stopFn = stop;

  // Return PLC instance
  return {
    config,
    runtime,
    stop,
  };
}

// Re-export coral for downstream projects
export { createLogger, LogLevel, type Log } from "@joyautomation/coral";
export { createPlcLogger } from "./logger.ts";
