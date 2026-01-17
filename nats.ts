import { connect, type NatsConnection } from "@nats-io/transport-deno";
import { jetstream, StorageType, DiscardPolicy } from "@nats-io/jetstream";
import {
  type NatsConfig,
  type PlcVariable,
  type PlcVariables,
  type VariableSource,
} from "./types/variables.ts";
import {
  NATS_TOPICS,
  substituteTopic,
  type PlcDataMessage,
  isPlcDataMessage,
} from "../nats-schema/src/mod.ts";

/** Simple KV store wrapper using NATS JetStream */
type KVStore = {
  put: (key: string, value: Uint8Array) => Promise<void>;
  get: (key: string) => Promise<Uint8Array | null>;
  delete: (key: string) => Promise<void>;
};

export type NatsManager<V extends PlcVariables> = {
  connection: NatsConnection;
  projectId: string;
  subscriptions: Map<string, () => Promise<void>>;
  /** Publish a variable update with schema compliance and KV storage */
  publish: (
    variableId: keyof V,
    value: number | boolean | string | Record<string, unknown>,
    datatype: "number" | "boolean" | "string" | "udt",
  ) => Promise<void>;
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
    console.log(`Using existing KV bucket: ${bucketName}`);
  } catch {
    console.log(`Creating new KV bucket: ${bucketName}`);
    await jsm.streams.add({
      name: streamName,
      subjects: [`${subjectPrefix}.>`],
      storage: StorageType.File,
      discard: DiscardPolicy.New,
      max_age: 0, // No TTL for KV
    });
    console.log(`KV bucket created: ${bucketName}`);
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
        // Try to get the last message from the stream
        const msg = await jsm.streams.getMessage(streamName, {
          last_by_subj: subject,
        });
        if (msg) {
          return msg.data;
        }
        return null;
      } catch {
        // Key doesn't exist
        return null;
      }
    },

    delete: (key: string) => {
      const subject = `${subjectPrefix}.${key}`;
      // Delete by publishing a marker (KV delete marker is an empty message)
      js.publish(subject, new Uint8Array(0));
      return Promise.resolve();
    },
  };
}

/**
 * Establish a connection to NATS and set up variable subscriptions.
 * Integrates with @tentacle/nats-schema for automatic schema compliance.
 *
 * @param config - NATS configuration
 * @param variables - PLC variables with NATS sources
 * @param projectId - Project identifier for schema topics
 * @param onVariableUpdate - Callback when a variable is updated from NATS
 * @returns NatsManager for publishing and managing subscriptions
 */
export async function setupNats<V extends PlcVariables>(
  config: NatsConfig,
  variables: V,
  projectId: string,
  onVariableUpdate: (
    variableId: keyof V,
    value: number | boolean | string | Record<string, unknown>,
  ) => void,
): Promise<NatsManager<V>> {
  const nc = await connect({
    servers: config.servers,
    user: config.user,
    pass: config.pass,
    token: config.token,
  });

  const subscriptions = new Map<string, () => Promise<void>>();
  const handlers = new Map<string, SubscriptionHandler>();

  // Initialize centralized KV store for persistence
  const kvBucketName = `plc-variables-${projectId}`;
  let kv: KVStore | null = null;
  try {
    console.log("Initializing centralized KV store...");
    kv = await createKVStore(nc, kvBucketName);
    console.log("KV store initialized successfully");
  } catch (error) {
    console.warn(
      "KV store initialization failed - variable state will not be persisted:",
      error,
    );
  }

  // Restore variable state from KV on startup
  console.log("Restoring variable state from KV...");
  for (const [variableId, variable] of Object.entries(variables)) {
    if (kv) {
      try {
        const kvData = await kv.get(variableId as string);
        if (kvData) {
          const kvValue = JSON.parse(new TextDecoder().decode(kvData)) as {
            value: number | boolean | string | Record<string, unknown>;
          };
          // Directly assign to the variable's value property
          (variable as Record<string, unknown>).value = kvValue.value;
          console.log(`Restored ${variableId} = ${kvValue.value}`);
        }
      } catch {
        // KV entry doesn't exist, keep default value
        console.log(`No persisted state found for ${variableId}, using default`);
      }
    }
  }

  // Set up subscriptions for variables with NATS sources
  for (const [variableId, variable] of Object.entries(variables)) {
    const typedVariable = variable as PlcVariable;
    if (hasNatsSource(typedVariable)) {
      const subject = getSubject(typedVariable, projectId, variableId as string);
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
              const value = msg.string();
              const parsedValue = parseValue(value, typedVariable.datatype);
              onVariableUpdate(variableId as keyof V, parsedValue);
            } catch (error) {
              console.error(
                `Error processing NATS message on subject ${subject}:`,
                error,
              );
            }
          }
        } catch (error) {
          console.error(
            `Error in subscription handler for subject ${subject}:`,
            error,
          );
        }
      })();

      handlers.set(subject, { abort, promise: handlerPromise });
    }
  }

  return {
    connection: nc,
    projectId,
    subscriptions,

    /**
     * Publish a variable update following @tentacle/nats-schema.
     * Automatically publishes to schema topic and stores in KV.
     */
    publish: async (
      variableId: keyof V,
      value: number | boolean | string | Record<string, unknown>,
      datatype: "number" | "boolean" | "string" | "udt",
    ) => {
      // Create schema-compliant message
      const schemaMessage: PlcDataMessage = {
        projectId,
        variableId: variableId as string,
        value,
        timestamp: Date.now(),
        datatype,
      };

      // Validate message against schema
      if (!isPlcDataMessage(schemaMessage)) {
        throw new Error(
          `Invalid PLC message: ${JSON.stringify(schemaMessage)}`,
        );
      }

      // Publish to schema topic
      const schemaSubject = substituteTopic(NATS_TOPICS.plc.data, {
        projectId,
        variableId: variableId as string,
      });

      nc.publish(schemaSubject, JSON.stringify(schemaMessage));

      // Store in KV for state persistence if available
      if (kv) {
        try {
          const kvValue = { value };
          await kv.put(
            variableId as string,
            new TextEncoder().encode(JSON.stringify(kvValue)),
          );
        } catch (error) {
          console.warn(
            `Failed to store variable state in KV: ${String(variableId)}`,
            error,
          );
        }
      }
    },

    /**
     * Low-level publish to a custom subject (backward compatibility).
     * Use publish() for schema-compliant publishing instead.
     */
    publishToSubject: (subject: string, value: string) => {
      nc.publish(subject, value);
    },

    disconnect: async () => {
      // Signal all handlers to stop
      for (const handler of handlers.values()) {
        handler.abort.abort();
      }

      // Unsubscribe from all subjects
      for (const unsubscribe of subscriptions.values()) {
        await unsubscribe();
      }

      // Wait for handlers to finish
      await Promise.all(Array.from(handlers.values()).map((h) => h.promise));

      subscriptions.clear();
      handlers.clear();
      await nc.close();
    },
  };
}

/**
 * Parse a string value based on the PLC variable datatype.
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
      return lower === "true" || lower === "1" || lower === "on" ||
        lower === "yes";
    }
    case "string":
      return value;
    case "udt":
      try {
        return JSON.parse(value);
      } catch {
        console.warn(
          `Failed to parse UDT value as JSON, returning as string: ${value}`,
        );
        return value;
      }
    default:
      console.warn(`Unknown datatype: ${datatype}, returning value as string`);
      return value;
  }
}
