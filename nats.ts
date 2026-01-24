/**
 * NATS Integration Module
 *
 * Handles NATS connection, subscriptions, and KV storage for PLC variables.
 */

import { connect, type NatsConnection } from "@nats-io/transport-deno";
import { jetstream, StorageType, DiscardPolicy } from "@nats-io/jetstream";
import type {
  NatsConfig,
  PlcVariable,
  VariableSource,
} from "./types/variables.ts";
import {
  NATS_TOPICS,
  substituteTopic,
  type PlcDataMessage,
  isPlcDataMessage,
} from "../nats-schema/src/mod.ts";
import { createLogger, LogLevel } from "@joyautomation/coral";

/** Logger for the NATS module */
const log = createLogger("nats", LogLevel.info);

/** Simple KV store wrapper using NATS JetStream */
type KVStore = {
  put: (key: string, value: Uint8Array) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
  delete: (key: string) => Promise<void>;
};

export type NatsManager = {
  connection: NatsConnection;
  projectId: string;
  subscriptions: Map<string, () => Promise<void>>;
  /** Publish a variable update with schema compliance and KV storage */
  publish: (
    variableId: string,
    value: number | boolean | string | Record<string, unknown>,
    datatype: "number" | "boolean" | "string" | "udt",
  ) => Promise<void>;
  /** Publish all variables - useful for initial state or on request */
  publishAll: () => Promise<void>;
  /** Low-level publish to custom subject (backward compatibility) */
  publishToSubject: (subject: string, value: string) => void;
  disconnect: () => Promise<void>;
};

type SubscriptionHandler = {
  abort: AbortController;
  promise: Promise<void>;
};

/**
 * Type guard to check if a value has a NATS source configuration
 */
function hasNatsSource(
  variable: PlcVariable,
): variable is PlcVariable & { source: VariableSource } {
  return variable.source !== undefined;
}

/**
 * Get or derive the NATS subject for a variable.
 * If subject is not specified, derives it as: ${projectId}/${variableId}
 */
function getSubject(
  variable: PlcVariable & { source: VariableSource },
  projectId: string,
  variableId: string,
): string {
  return variable.source.subject ?? `${projectId}/${variableId}`;
}

/**
 * Create a NATS KV store using JetStream streams
 */
async function createKVStore(
  nc: NatsConnection,
  bucketName: string,
): Promise<KVStore> {
  const js = jetstream(nc);
  const jsm = await js.jetstreamManager();

  const streamName = `$KV_${bucketName}`;
  const subjectPrefix = `$KV.${bucketName}`;

  // Create or get the stream
  try {
    await jsm.streams.info(streamName);
    log.debug(`Using existing KV bucket: ${bucketName}`);
  } catch {
    log.info(`Creating new KV bucket: ${bucketName}`);
    await jsm.streams.add({
      name: streamName,
      subjects: [`${subjectPrefix}.>`],
      storage: StorageType.File,
      discard: DiscardPolicy.New,
      max_age: 0, // No TTL for KV
    });
    log.info(`KV bucket created: ${bucketName}`);
  }

  // Return KV store interface
  return {
    put: (key: string, value: Uint8Array) => {
      const subject = `${subjectPrefix}.${key}`;
      js.publish(subject, value);
      return Promise.resolve();
    },

    get: async (key: string): Promise<Uint8Array | null> => {
      const subject = `${subjectPrefix}.${key}`;
      try {
        const msg = await jsm.streams.getMessage(streamName, {
          last_by_subj: subject,
        });
        if (msg) {
          return msg.data;
        }
        return null;
      } catch {
        return null;
      }
    },

    delete: (key: string) => {
      const subject = `${subjectPrefix}.${key}`;
      js.publish(subject, new Uint8Array(0));
      return Promise.resolve();
    },
  };
}

/**
 * Establish a connection to NATS and set up variable subscriptions.
 *
 * @param config - NATS configuration
 * @param variables - PLC runtime variables
 * @param projectId - Project identifier for schema topics
 * @param onVariableUpdate - Callback when a variable is updated from NATS
 * @returns NatsManager for publishing and managing subscriptions
 */
export async function setupNats(
  config: NatsConfig,
  variables: Record<string, PlcVariable>,
  projectId: string,
  onVariableUpdate: (
    variableId: string,
    value: number | boolean | string | Record<string, unknown>,
  ) => void,
): Promise<NatsManager> {
  const nc = await connect({
    servers: config.servers,
    user: config.user,
    pass: config.pass,
    token: config.token,
  });

  log.info(`Connected to NATS: ${config.servers}`);

  const subscriptions = new Map<string, () => Promise<void>>();
  const handlers = new Map<string, SubscriptionHandler>();

  // Initialize KV store
  const kvBucketName = `plc-variables-${projectId}`;
  let kv: KVStore | null = null;
  try {
    kv = await createKVStore(nc, kvBucketName);
  } catch (error) {
    log.warn("KV store initialization failed:", error);
  }

  // Restore variable state from KV
  for (const [variableId, variable] of Object.entries(variables)) {
    if (kv) {
      try {
        const kvData = await kv.get(variableId);
        if (kvData) {
          const kvValue = JSON.parse(new TextDecoder().decode(kvData)) as {
            value: number | boolean | string | Record<string, unknown>;
          };
          variable.value = kvValue.value;
          log.debug(`Restored ${variableId} = ${JSON.stringify(kvValue.value)}`);
        }
      } catch {
        // No persisted state, keep default
      }
    }
  }

  // Set up subscriptions for variables with NATS sources
  for (const [variableId, variable] of Object.entries(variables)) {
    if (hasNatsSource(variable)) {
      const subject = getSubject(variable, projectId, variableId);
      const abort = new AbortController();

      const sub = nc.subscribe(subject);
      subscriptions.set(subject, async () => {
        abort.abort();
        await sub.unsubscribe();
      });

      // Handle incoming messages
      const handlerPromise = (async () => {
        try {
          for await (const msg of sub) {
            if (abort.signal.aborted) break;
            try {
              const rawValue = msg.string();
              const parsedValue = parseValue(rawValue, variable.datatype);

              // Apply onResponse transform if configured
              const finalValue = variable.source.onResponse
                ? variable.source.onResponse(parsedValue as number | boolean | string)
                : parsedValue;

              onVariableUpdate(variableId, finalValue);
            } catch (error) {
              log.error(`Error processing message on ${subject}:`, error);
            }
          }
        } catch (error) {
          log.error(`Error in subscription for ${subject}:`, error);
        }
      })();

      handlers.set(subject, { abort, promise: handlerPromise });
    }
  }

  // Helper function to publish all variables
  const publishAllVariables = async (
    publishFn: NatsManager["publish"],
  ): Promise<void> => {
    log.info("Publishing all variables...");
    for (const [variableId, variable] of Object.entries(variables)) {
      await publishFn(variableId, variable.value, variable.datatype);
    }
    log.info(`Published ${Object.keys(variables).length} variables`);
  };

  // Subscribe to variable report requests
  const requestSubject = substituteTopic(NATS_TOPICS.plc.variablesRequest, {
    projectId,
  });
  const requestSub = nc.subscribe(requestSubject);
  const requestAbort = new AbortController();

  subscriptions.set(requestSubject, async () => {
    requestAbort.abort();
    await requestSub.unsubscribe();
  });

  // Create the publish function first so it can be used by publishAll
  const publish = async (
    variableId: string,
    value: number | boolean | string | Record<string, unknown>,
    datatype: "number" | "boolean" | "string" | "udt",
  ): Promise<void> => {
    // Get variable config for transforms
    const variable = variables[variableId];
    let finalValue = value;

    // Apply onSend transform if configured
    if (variable?.source?.onSend && typeof value !== "object") {
      finalValue = variable.source.onSend(value as number | boolean | string);
    }

    // Create schema-compliant message
    const schemaMessage: PlcDataMessage = {
      projectId,
      variableId,
      value: finalValue,
      timestamp: Date.now(),
      datatype,
    };

    if (!isPlcDataMessage(schemaMessage)) {
      throw new Error(`Invalid PLC message: ${JSON.stringify(schemaMessage)}`);
    }

    // Publish to schema topic
    const schemaSubject = substituteTopic(NATS_TOPICS.plc.data, {
      projectId,
      variableId,
    });

    nc.publish(schemaSubject, JSON.stringify(schemaMessage));

    // Store in KV with full schema
    if (kv) {
      try {
        const kvValue = {
          projectId,
          variableId,
          value: finalValue,
          datatype,
          lastUpdated: Date.now(),
          source: "plc" as const,
          quality: "good" as const,
          deadband: variable?.deadband,
          disableRBE: variable?.disableRBE,
        };
        await kv.put(variableId, new TextEncoder().encode(JSON.stringify(kvValue)));
      } catch (error) {
        log.warn(`Failed to store in KV: ${variableId}`, error);
      }
    }
  };

  // Create the manager
  const manager: NatsManager = {
    connection: nc,
    projectId,
    subscriptions,
    publish,

    publishAll: () => publishAllVariables(publish),

    publishToSubject: (subject: string, value: string) => {
      nc.publish(subject, value);
    },

    disconnect: async () => {
      // Signal all handlers to stop
      for (const handler of handlers.values()) {
        handler.abort.abort();
      }
      requestAbort.abort();

      // Unsubscribe
      for (const unsubscribe of subscriptions.values()) {
        await unsubscribe();
      }

      // Wait for handlers
      await Promise.all(Array.from(handlers.values()).map((h) => h.promise));

      subscriptions.clear();
      handlers.clear();
      await nc.close();
      log.info("Disconnected from NATS");
    },
  };

  // Handle variable report requests
  (async () => {
    try {
      for await (const msg of requestSub) {
        if (requestAbort.signal.aborted) break;
        log.info(`Received variables request from ${msg.subject}`);
        await manager.publishAll();
      }
    } catch (error) {
      if (!requestAbort.signal.aborted) {
        log.error("Error in variables request handler:", error);
      }
    }
  })();

  log.info(`Listening for variable requests on: ${requestSubject}`);

  return manager;
}

/**
 * Parse a string value based on datatype.
 */
export function parseValue(
  value: string,
  datatype: "number" | "boolean" | "string" | "udt",
): number | boolean | string | Record<string, unknown> {
  switch (datatype) {
    case "number":
      return Number(value);
    case "boolean": {
      const lower = value.toLowerCase().trim();
      return lower === "true" || lower === "1" || lower === "on" || lower === "yes";
    }
    case "string":
      return value;
    case "udt":
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return value;
  }
}
