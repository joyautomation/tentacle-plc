/**
 * NATS Integration Module
 *
 * Handles NATS connection, subscriptions, and KV storage for PLC variables.
 */

import { connect, type NatsConnection } from "@nats-io/transport-deno";
import { jetstream, StorageType, DiscardPolicy } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
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
} from "@joyautomation/nats-schema";

/** Service heartbeat entry — matches tentacle-nats-schema ServiceHeartbeat */
interface ServiceHeartbeat {
  serviceType: string;
  moduleId: string;
  lastSeen: number;
  startedAt: number;
  version?: string;
  metadata?: Record<string, unknown>;
}
import { createPlcLogger } from "./logger.ts";

const log = createPlcLogger("nats");

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
  onUdtMemberUpdate?: (
    udtVarId: string,
    memberPath: string,
    value: number | boolean | string,
  ) => void,
  onShutdown?: () => Promise<void>,
): Promise<NatsManager> {
  const nc = await connect({
    servers: config.servers,
    user: config.user,
    pass: config.pass,
    token: config.token,
  });

  log.info(`Connected to NATS: ${config.servers}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Heartbeat publishing for service discovery
  // ═══════════════════════════════════════════════════════════════════════════
  const jsClient = jetstream(nc);
  const kvm = new Kvm(jsClient);
  let heartbeatsKv: KV | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  const startedAt = Date.now();

  try {
    heartbeatsKv = await kvm.create("service_heartbeats", {
      history: 1,
      ttl: 60 * 1000, // 1 minute TTL
    });

    const publishHeartbeat = async () => {
      const heartbeat: ServiceHeartbeat = {
        serviceType: "plc",
        moduleId: projectId,
        lastSeen: Date.now(),
        startedAt,
        metadata: {
          cwd: Deno.cwd(),
        },
      };
      try {
        const encoder = new TextEncoder();
        await heartbeatsKv!.put(
          projectId,
          encoder.encode(JSON.stringify(heartbeat)),
        );
      } catch (err) {
        log.warn(`Failed to publish heartbeat: ${err}`);
      }
    };

    await publishHeartbeat();
    log.info(`Service heartbeat started (moduleId: ${projectId})`);
    heartbeatInterval = setInterval(publishHeartbeat, 10000);
  } catch (err) {
    log.warn(`Failed to initialize heartbeat publishing: ${err}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shutdown command listener
  // ═══════════════════════════════════════════════════════════════════════════
  const shutdownSubject = `${projectId}.shutdown`;
  const shutdownSub = nc.subscribe(shutdownSubject);
  const shutdownAbort = new AbortController();

  (async () => {
    try {
      for await (const _msg of shutdownSub) {
        if (shutdownAbort.signal.aborted) break;
        log.info(`Received shutdown command on ${shutdownSubject}`);
        if (onShutdown) {
          await onShutdown();
        }
        break;
      }
    } catch (error) {
      if (!shutdownAbort.signal.aborted) {
        log.error("Error in shutdown listener:", error);
      }
    }
  })();

  log.info(`Listening for shutdown on: ${shutdownSubject}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // Variables request/reply handler — returns all PLC runtime variables
  // ═══════════════════════════════════════════════════════════════════════════
  const variablesSubject = `${projectId}.variables`;
  const variablesSub = nc.subscribe(variablesSubject);
  const variablesAbort = new AbortController();

  (async () => {
    try {
      for await (const msg of variablesSub) {
        if (variablesAbort.signal.aborted) break;
        // Build a lookup of base variable name → UDT template name
        const udtTypeByBase = new Map<string, string>();
        for (const [vid, variable] of Object.entries(variables)) {
          if (variable.datatype === "udt" && "udtTemplate" in variable && (variable as Record<string, unknown>).udtTemplate) {
            udtTypeByBase.set(vid, ((variable as Record<string, unknown>).udtTemplate as { name: string }).name);
          }
        }

        const encoder = new TextEncoder();
        const allVars = Object.entries(variables).map(([variableId, variable]) => {
          const deviceId = variable.source?.ethernetip?.deviceId
            ?? variable.source?.opcua?.deviceId
            ?? variable.source?.modbus?.deviceId
            ?? projectId;
          const entry: Record<string, unknown> = {
            moduleId: projectId,
            deviceId,
            variableId,
            value: variable.value,
            datatype: variable.datatype,
            quality: "good",
            origin: "plc",
            lastUpdated: Date.now(),
          };
          // Include udtTemplate for UDT parent variables
          if (variable.datatype === "udt" && "udtTemplate" in variable && (variable as Record<string, unknown>).udtTemplate) {
            entry.udtTemplate = (variable as Record<string, unknown>).udtTemplate;
          }
          // For member variables (with dots), look up parent's UDT type name
          const dotIdx = variableId.indexOf(".");
          if (dotIdx !== -1) {
            const baseName = variableId.substring(0, dotIdx);
            const udtName = udtTypeByBase.get(baseName);
            if (udtName) entry.structType = udtName;
          }
          return entry;
        });
        msg.respond(encoder.encode(JSON.stringify(allVars)));
      }
    } catch (error) {
      if (!variablesAbort.signal.aborted) {
        log.error("Error in variables handler:", error);
      }
    }
  })();

  log.info(`Listening for variables requests on: ${variablesSubject}`);

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

  // Restore variable state from KV (skip UDT variables — their values are
  // assembled from member updates and stale KV data may have wrong types)
  for (const [variableId, variable] of Object.entries(variables)) {
    if (kv && variable.datatype !== "udt") {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // EtherNet/IP source subscriptions
  // ═══════════════════════════════════════════════════════════════════════════

  // Collect variables sourced from EtherNet/IP (with connection info).
  // For UDT variables with memberSources, each member gets its own EIP subscription.
  // The eipVariables key uses "udtVarId\0memberPath" for UDT members to distinguish
  // them from standalone atomic variables.
  const eipVariables = new Map<
    string,
    { variableId: string; tag: string; deviceId: string; host: string; port: number; cipType?: string; scanRate?: number }
  >();
  // Map from EIP tag → { udtVarId, memberPath } for routing data into UDT values
  const eipTagToUdtMember = new Map<string, { udtVarId: string; memberPath: string }>();

  for (const [variableId, variable] of Object.entries(variables)) {
    if (variable.source?.ethernetip) {
      eipVariables.set(variableId, {
        variableId,
        ...variable.source.ethernetip,
      });
    }
    // Extract member sources from UDT variables
    if (variable.datatype === "udt" && "memberSources" in variable && variable.memberSources) {
      for (const [memberPath, memberSource] of Object.entries(variable.memberSources as Record<string, { ethernetip?: { deviceId: string; host: string; port: number; tag: string; cipType?: string; scanRate?: number } }>)) {
        if (memberSource.ethernetip) {
          const memberKey = `${variableId}\0${memberPath}`;
          eipVariables.set(memberKey, {
            variableId: memberKey,
            ...memberSource.ethernetip,
          });
          eipTagToUdtMember.set(memberSource.ethernetip.tag, { udtVarId: variableId, memberPath });
        }
      }
    }
  }

  let eipRetryInterval: ReturnType<typeof setInterval> | null = null;

  if (eipVariables.size > 0) {
    log.info(
      `Setting up EtherNet/IP sources for ${eipVariables.size} variable(s)`,
    );

    // Sanitize tag names for NATS subjects (same as ethernetip scanner)
    const sanitizeForSubject = (tag: string): string =>
      tag.replace(/\./g, "_");

    // Subscribe to data topics immediately — NATS subscriptions work before
    // ethernetip publishes, so no messages are missed.
    for (const [, eipVar] of eipVariables) {
      const subject = `ethernetip.data.${eipVar.deviceId}.${sanitizeForSubject(eipVar.tag)}`;
      // Skip if already subscribed (multiple UDT members can share a device subject prefix)
      if (subscriptions.has(subject)) continue;

      const abort = new AbortController();
      const sub = nc.subscribe(subject);
      // Look up whether this tag routes to a UDT member
      const udtMapping = eipTagToUdtMember.get(eipVar.tag);

      subscriptions.set(subject, async () => {
        abort.abort();
        await sub.unsubscribe();
      });

      const handlerPromise = (async () => {
        try {
          for await (const msg of sub) {
            if (abort.signal.aborted) break;
            try {
              const data = JSON.parse(msg.string()) as {
                value: number | boolean | string | null;
              };
              if (data.value !== null && data.value !== undefined) {
                if (udtMapping && onUdtMemberUpdate) {
                  onUdtMemberUpdate(udtMapping.udtVarId, udtMapping.memberPath, data.value as number | boolean | string);
                } else {
                  onVariableUpdate(eipVar.variableId, data.value);
                }
              }
            } catch (error) {
              log.error(
                `Error processing EIP data on ${subject}:`,
                error,
              );
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            log.error(`Error in EIP subscription for ${subject}:`, error);
          }
        }
      })();

      handlers.set(subject, { abort, promise: handlerPromise });
      log.debug(`Subscribed to EIP data: ${subject} → ${udtMapping ? `${udtMapping.udtVarId}.${udtMapping.memberPath}` : eipVar.variableId}`);
    }

    // Also subscribe to batch data topics per device
    const deviceIds = new Set(
      [...eipVariables.values()].map((v) => v.deviceId),
    );
    for (const deviceId of deviceIds) {
      const batchSubject = `ethernetip.data.${deviceId}`;
      const abort = new AbortController();
      const sub = nc.subscribe(batchSubject);

      subscriptions.set(batchSubject, async () => {
        abort.abort();
        await sub.unsubscribe();
      });

      // Build a lookup from tag name → variableId for this device
      const tagToVariable = new Map<string, string>();
      for (const [variableId, eipVar] of eipVariables) {
        if (eipVar.deviceId === deviceId) {
          tagToVariable.set(eipVar.tag, variableId);
        }
      }

      const handlerPromise = (async () => {
        try {
          for await (const msg of sub) {
            if (abort.signal.aborted) break;
            try {
              const batch = JSON.parse(msg.string()) as {
                values: Array<{
                  variableId: string;
                  value: number | boolean | string | null;
                }>;
              };
              if (batch.values) {
                for (const entry of batch.values) {
                  if (entry.value === null || entry.value === undefined) continue;
                  // Check if this tag maps to a UDT member
                  const udtMapping = eipTagToUdtMember.get(entry.variableId);
                  if (udtMapping && onUdtMemberUpdate) {
                    onUdtMemberUpdate(udtMapping.udtVarId, udtMapping.memberPath, entry.value as number | boolean | string);
                  } else {
                    const plcVarId = tagToVariable.get(entry.variableId);
                    if (plcVarId) {
                      onVariableUpdate(plcVarId, entry.value);
                    }
                  }
                }
              }
            } catch (error) {
              log.error(
                `Error processing EIP batch on ${batchSubject}:`,
                error,
              );
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            log.error(
              `Error in EIP batch subscription for ${batchSubject}:`,
              error,
            );
          }
        }
      })();

      handlers.set(batchSubject, { abort, promise: handlerPromise });
      log.debug(`Subscribed to EIP batch data: ${batchSubject}`);
    }

    // Group EIP variables by device for per-device subscribe requests
    const deviceGroups = new Map<
      string,
      { host: string; port: number; scanRate: number; tags: string[]; cipTypes: Record<string, string>; structTypes: Record<string, string> }
    >();
    // Build a lookup of base variable name → UDT template name
    const udtTypeByBase = new Map<string, string>();
    for (const [vid, variable] of Object.entries(variables)) {
      if (variable.datatype === "udt" && "udtTemplate" in variable && variable.udtTemplate) {
        udtTypeByBase.set(vid, variable.udtTemplate.name);
      }
    }

    for (const [, eipVar] of eipVariables) {
      const existing = deviceGroups.get(eipVar.deviceId);
      const scanRate = eipVar.scanRate ?? 1000;
      // Base tag name is the part before the first dot
      const baseName = eipVar.tag.includes('.') ? eipVar.tag.substring(0, eipVar.tag.indexOf('.')) : eipVar.tag;
      // Look up UDT template name from the parent variable
      const udtName = udtTypeByBase.get(baseName);
      if (existing) {
        existing.tags.push(eipVar.tag);
        if (eipVar.cipType) existing.cipTypes[eipVar.tag] = eipVar.cipType;
        if (udtName) existing.structTypes[baseName] = udtName;
        // Use fastest scan rate
        if (scanRate < existing.scanRate) {
          existing.scanRate = scanRate;
        }
      } else {
        const cipTypes: Record<string, string> = {};
        const structTypes: Record<string, string> = {};
        if (eipVar.cipType) cipTypes[eipVar.tag] = eipVar.cipType;
        if (udtName) structTypes[baseName] = udtName;
        deviceGroups.set(eipVar.deviceId, {
          host: eipVar.host,
          port: eipVar.port,
          scanRate,
          tags: [eipVar.tag],
          cipTypes,
          structTypes,
        });
      }
    }

    const attemptSubscribe = async (): Promise<boolean> => {
      try {
        let allSuccess = true;
        for (const [deviceId, group] of deviceGroups) {
          const payload = JSON.stringify({
            deviceId,
            host: group.host,
            port: group.port,
            scanRate: group.scanRate,
            tags: group.tags,
            cipTypes: Object.keys(group.cipTypes).length > 0 ? group.cipTypes : undefined,
            structTypes: Object.keys(group.structTypes).length > 0 ? group.structTypes : undefined,
            subscriberId: projectId,
          });
          const response = await nc.request(
            "ethernetip.subscribe",
            new TextEncoder().encode(payload),
            { timeout: 5000 },
          );
          const result = JSON.parse(
            new TextDecoder().decode(response.data),
          ) as { success: boolean };
          if (result.success) {
            log.info(
              `Subscribed ${group.tags.length} tag(s) for device ${deviceId} (${group.host}:${group.port})`,
            );
          } else {
            log.warn(`EtherNet/IP subscribe for ${deviceId} returned success=false`);
            allSuccess = false;
          }
        }
        return allSuccess;
      } catch {
        log.debug(
          "EtherNet/IP subscribe request failed (scanner may not be running yet)",
        );
        return false;
      }
    };

    // Try immediately, then retry every 10s if ethernetip isn't available yet
    if (!(await attemptSubscribe())) {
      log.info(
        "Will retry EtherNet/IP subscribe every 10s until scanner is available",
      );
      eipRetryInterval = setInterval(async () => {
        if (await attemptSubscribe()) {
          clearInterval(eipRetryInterval!);
          eipRetryInterval = null;
        }
      }, 10_000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // OPC UA source subscriptions
  // ═══════════════════════════════════════════════════════════════════════════

  // Collect variables sourced from OPC UA (with connection info)
  const opcuaVariables = new Map<
    string,
    { variableId: string; nodeId: string; deviceId: string; endpointUrl: string; scanRate?: number }
  >();
  for (const [variableId, variable] of Object.entries(variables)) {
    if (variable.source?.opcua) {
      opcuaVariables.set(variableId, {
        variableId,
        ...variable.source.opcua,
      });
    }
  }

  let opcuaRetryInterval: ReturnType<typeof setInterval> | null = null;

  if (opcuaVariables.size > 0) {
    log.info(
      `Setting up OPC UA sources for ${opcuaVariables.size} variable(s)`,
    );

    // Sanitize NodeIds for NATS subjects (same as opcua scanner)
    const sanitizeNodeId = (nodeId: string): string =>
      nodeId.replace(/[.;=]/g, "_");

    // Subscribe to data topics immediately
    for (const [variableId, opcuaVar] of opcuaVariables) {
      const subject = `opcua.data.${opcuaVar.deviceId}.${sanitizeNodeId(opcuaVar.nodeId)}`;
      const abort = new AbortController();
      const sub = nc.subscribe(subject);

      subscriptions.set(subject, async () => {
        abort.abort();
        await sub.unsubscribe();
      });

      const handlerPromise = (async () => {
        try {
          for await (const msg of sub) {
            if (abort.signal.aborted) break;
            try {
              const data = JSON.parse(msg.string()) as {
                value: number | boolean | string | null;
              };
              if (data.value !== null && data.value !== undefined) {
                onVariableUpdate(variableId, data.value);
              }
            } catch (error) {
              log.error(
                `Error processing OPC UA data on ${subject}:`,
                error,
              );
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            log.error(`Error in OPC UA subscription for ${subject}:`, error);
          }
        }
      })();

      handlers.set(subject, { abort, promise: handlerPromise });
      log.debug(`Subscribed to OPC UA data: ${subject} → ${variableId}`);
    }

    // Group OPC UA variables by device for per-device subscribe requests
    const opcuaDeviceGroups = new Map<
      string,
      { endpointUrl: string; scanRate: number; nodeIds: string[] }
    >();
    for (const opcuaVar of opcuaVariables.values()) {
      const existing = opcuaDeviceGroups.get(opcuaVar.deviceId);
      const scanRate = opcuaVar.scanRate ?? 1000;
      if (existing) {
        existing.nodeIds.push(opcuaVar.nodeId);
        if (scanRate < existing.scanRate) {
          existing.scanRate = scanRate;
        }
      } else {
        opcuaDeviceGroups.set(opcuaVar.deviceId, {
          endpointUrl: opcuaVar.endpointUrl,
          scanRate,
          nodeIds: [opcuaVar.nodeId],
        });
      }
    }

    const attemptOpcuaSubscribe = async (): Promise<boolean> => {
      try {
        let allSuccess = true;
        for (const [deviceId, group] of opcuaDeviceGroups) {
          const payload = JSON.stringify({
            deviceId,
            endpointUrl: group.endpointUrl,
            scanRate: group.scanRate,
            nodeIds: group.nodeIds,
            subscriberId: projectId,
          });
          const response = await nc.request(
            "opcua.subscribe",
            new TextEncoder().encode(payload),
            { timeout: 10_000 },
          );
          const result = JSON.parse(
            new TextDecoder().decode(response.data),
          ) as { success: boolean };
          if (result.success) {
            log.info(
              `Subscribed ${group.nodeIds.length} node(s) for OPC UA device ${deviceId} (${group.endpointUrl})`,
            );
          } else {
            log.warn(`OPC UA subscribe for ${deviceId} returned success=false`);
            allSuccess = false;
          }
        }
        return allSuccess;
      } catch {
        log.debug(
          "OPC UA subscribe request failed (scanner may not be running yet)",
        );
        return false;
      }
    };

    // Try immediately, then retry every 10s if opcua isn't available yet
    if (!(await attemptOpcuaSubscribe())) {
      log.info(
        "Will retry OPC UA subscribe every 10s until scanner is available",
      );
      opcuaRetryInterval = setInterval(async () => {
        if (await attemptOpcuaSubscribe()) {
          clearInterval(opcuaRetryInterval!);
          opcuaRetryInterval = null;
        }
      }, 10_000);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Modbus source subscriptions
  // ═══════════════════════════════════════════════════════════════════════════

  // Collect variables sourced from Modbus (with full tag addressing)
  const modbusVariables = new Map<
    string,
    {
      variableId: string;
      tag: string;
      deviceId: string;
      host: string;
      port: number;
      unitId: number;
      address: number;
      functionCode: "coil" | "discrete" | "holding" | "input";
      modbusDatatype: string;
      byteOrder: string;
      scanRate?: number;
    }
  >();
  for (const [variableId, variable] of Object.entries(variables)) {
    if (variable.source?.modbus) {
      modbusVariables.set(variableId, {
        variableId,
        ...variable.source.modbus,
      });
    }
  }

  let modbusRetryInterval: ReturnType<typeof setInterval> | null = null;

  if (modbusVariables.size > 0) {
    log.info(
      `Setting up Modbus sources for ${modbusVariables.size} variable(s)`,
    );

    // Subscribe per device to modbus.data.{deviceId} — Modbus scanner publishes
    // PlcDataMessage there with variableId=tagId, one message per tag per scan.
    const modbusDeviceIds = new Set(
      [...modbusVariables.values()].map((v) => v.deviceId),
    );
    for (const deviceId of modbusDeviceIds) {
      const subject = `modbus.data.${deviceId}`;
      const abort = new AbortController();
      const sub = nc.subscribe(subject);

      subscriptions.set(subject, async () => {
        abort.abort();
        await sub.unsubscribe();
      });

      // Build tagId → variableId lookup for this device
      const tagToVariable = new Map<string, string>();
      for (const [variableId, modbusVar] of modbusVariables) {
        if (modbusVar.deviceId === deviceId) {
          tagToVariable.set(modbusVar.tag, variableId);
        }
      }

      const handlerPromise = (async () => {
        try {
          for await (const msg of sub) {
            if (abort.signal.aborted) break;
            try {
              const data = JSON.parse(msg.string()) as {
                variableId: string;
                value: number | boolean | null;
              };
              const plcVarId = tagToVariable.get(data.variableId);
              if (plcVarId && data.value !== null && data.value !== undefined) {
                onVariableUpdate(plcVarId, data.value);
              }
            } catch (error) {
              log.error(
                `Error processing Modbus data on ${subject}:`,
                error,
              );
            }
          }
        } catch (error) {
          if (!abort.signal.aborted) {
            log.error(`Error in Modbus subscription for ${subject}:`, error);
          }
        }
      })();

      handlers.set(subject, { abort, promise: handlerPromise });
      log.debug(`Subscribed to Modbus data: ${subject}`);
    }

    // Group Modbus variables by device for per-device subscribe requests
    const modbusDeviceGroups = new Map<
      string,
      {
        host: string;
        port: number;
        unitId: number;
        byteOrder: string;
        scanRate: number;
        tags: Array<{
          id: string;
          address: number;
          functionCode: "coil" | "discrete" | "holding" | "input";
          datatype: string;
          byteOrder: string;
        }>;
      }
    >();
    for (const modbusVar of modbusVariables.values()) {
      const existing = modbusDeviceGroups.get(modbusVar.deviceId);
      const scanRate = modbusVar.scanRate ?? 1000;
      const tagEntry = {
        id: modbusVar.tag,
        address: modbusVar.address,
        functionCode: modbusVar.functionCode,
        datatype: modbusVar.modbusDatatype,
        byteOrder: modbusVar.byteOrder,
      };
      if (existing) {
        existing.tags.push(tagEntry);
        if (scanRate < existing.scanRate) existing.scanRate = scanRate;
      } else {
        modbusDeviceGroups.set(modbusVar.deviceId, {
          host: modbusVar.host,
          port: modbusVar.port,
          unitId: modbusVar.unitId,
          byteOrder: modbusVar.byteOrder,
          scanRate,
          tags: [tagEntry],
        });
      }
    }

    const attemptModbusSubscribe = async (): Promise<boolean> => {
      try {
        let allSuccess = true;
        for (const [deviceId, group] of modbusDeviceGroups) {
          const payload = JSON.stringify({
            deviceId,
            host: group.host,
            port: group.port,
            unitId: group.unitId,
            byteOrder: group.byteOrder,
            scanRate: group.scanRate,
            tags: group.tags,
            subscriberId: projectId,
          });
          const response = await nc.request(
            "modbus.subscribe",
            new TextEncoder().encode(payload),
            { timeout: 5000 },
          );
          const result = JSON.parse(
            new TextDecoder().decode(response.data),
          ) as { success: boolean };
          if (result.success) {
            log.info(
              `Subscribed ${group.tags.length} tag(s) for Modbus device ${deviceId} (${group.host}:${group.port})`,
            );
          } else {
            log.warn(`Modbus subscribe for ${deviceId} returned success=false`);
            allSuccess = false;
          }
        }
        return allSuccess;
      } catch {
        log.debug(
          "Modbus subscribe request failed (scanner may not be running yet)",
        );
        return false;
      }
    };

    // Try immediately, then retry every 10s if modbus isn't available yet
    if (!(await attemptModbusSubscribe())) {
      log.info(
        "Will retry Modbus subscribe every 10s until scanner is available",
      );
      modbusRetryInterval = setInterval(async () => {
        if (await attemptModbusSubscribe()) {
          clearInterval(modbusRetryInterval!);
          modbusRetryInterval = null;
        }
      }, 10_000);
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

  // Note: variable report requests are handled by variablesSub (set up earlier)
  // No separate subscription needed here — variablesSub responds via msg.respond()

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
      moduleId: projectId,
      deviceId: projectId, // For tentacle-plc runtime, use projectId as deviceId
      variableId,
      value: finalValue,
      timestamp: Date.now(),
      datatype,
      deadband: variable?.deadband,
      disableRBE: variable?.disableRBE,
    };

    // Include udtTemplate if this UDT variable has a Sparkplug B template definition
    if (datatype === "udt" && variable && "udtTemplate" in variable && variable.udtTemplate) {
      (schemaMessage as Record<string, unknown>).udtTemplate = variable.udtTemplate;
    }

    if (!isPlcDataMessage(schemaMessage)) {
      throw new Error(`Invalid PLC message: ${JSON.stringify(schemaMessage)}`);
    }

    // Publish to schema topic
    const schemaSubject = substituteTopic(NATS_TOPICS.module.data, {
      moduleId: projectId,
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
      // Stop heartbeat publishing
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (heartbeatsKv) {
        try {
          await heartbeatsKv.delete(projectId);
          log.info("Removed service heartbeat");
        } catch {
          // Ignore - may already be expired
        }
      }

      // Clean up EtherNet/IP retry and unsubscribe
      if (eipRetryInterval) {
        clearInterval(eipRetryInterval);
        eipRetryInterval = null;
      }
      if (eipVariables.size > 0) {
        // Group tags by device for per-device unsubscribe
        const unsubGroups = new Map<string, string[]>();
        for (const eipVar of eipVariables.values()) {
          const existing = unsubGroups.get(eipVar.deviceId);
          if (existing) {
            existing.push(eipVar.tag);
          } else {
            unsubGroups.set(eipVar.deviceId, [eipVar.tag]);
          }
        }
        for (const [deviceId, tags] of unsubGroups) {
          try {
            await nc.request(
              "ethernetip.unsubscribe",
              new TextEncoder().encode(
                JSON.stringify({ deviceId, tags, subscriberId: projectId }),
              ),
              { timeout: 2000 },
            );
            log.info(`Unsubscribed ${tags.length} tags from device ${deviceId}`);
          } catch {
            // Best-effort — ethernetip may already be down
          }
        }
      }

      // Clean up OPC UA retry and unsubscribe
      if (opcuaRetryInterval) {
        clearInterval(opcuaRetryInterval);
        opcuaRetryInterval = null;
      }
      if (opcuaVariables.size > 0) {
        const unsubGroups = new Map<string, string[]>();
        for (const opcuaVar of opcuaVariables.values()) {
          const existing = unsubGroups.get(opcuaVar.deviceId);
          if (existing) {
            existing.push(opcuaVar.nodeId);
          } else {
            unsubGroups.set(opcuaVar.deviceId, [opcuaVar.nodeId]);
          }
        }
        for (const [deviceId, nodeIds] of unsubGroups) {
          try {
            await nc.request(
              "opcua.unsubscribe",
              new TextEncoder().encode(
                JSON.stringify({ deviceId, nodeIds, subscriberId: projectId }),
              ),
              { timeout: 2000 },
            );
            log.info(`Unsubscribed ${nodeIds.length} node(s) from OPC UA device ${deviceId}`);
          } catch {
            // Best-effort — opcua scanner may already be down
          }
        }
      }

      // Clean up Modbus retry and unsubscribe
      if (modbusRetryInterval) {
        clearInterval(modbusRetryInterval);
        modbusRetryInterval = null;
      }
      if (modbusVariables.size > 0) {
        const unsubGroups = new Map<string, string[]>();
        for (const modbusVar of modbusVariables.values()) {
          const existing = unsubGroups.get(modbusVar.deviceId);
          if (existing) {
            existing.push(modbusVar.tag);
          } else {
            unsubGroups.set(modbusVar.deviceId, [modbusVar.tag]);
          }
        }
        for (const [deviceId, tagIds] of unsubGroups) {
          try {
            await nc.request(
              "modbus.unsubscribe",
              new TextEncoder().encode(
                JSON.stringify({ deviceId, tagIds, subscriberId: projectId }),
              ),
              { timeout: 2000 },
            );
            log.info(`Unsubscribed ${tagIds.length} tag(s) from Modbus device ${deviceId}`);
          } catch {
            // Best-effort — modbus scanner may already be down
          }
        }
      }

      // Stop shutdown listener
      shutdownAbort.abort();
      await shutdownSub.unsubscribe();

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

  // Variable report requests are handled by variablesSub (set up earlier in this function)

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
