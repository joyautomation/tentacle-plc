/**
 * OPC UA Source Helpers
 *
 * Provides type-safe helpers for sourcing PLC variables from OPC UA servers.
 * Use with generated device types from `codegen.ts` for compile-time NodeId validation.
 *
 * @example
 * ```typescript
 * import { opcuaTag, opcuaAll } from "@tentacle/plc";
 * import { myServer } from "./generated/opcua.ts";
 *
 * // Single node with autocomplete:
 * const variables = {
 *   temperature: {
 *     id: "temperature",
 *     datatype: "number",
 *     default: 0,
 *     source: opcuaTag(myServer, "ns=2;s=Temperature"),
 *   } satisfies PlcVariableNumberConfig,
 * };
 *
 * // All nodes with filter + RBE:
 * const variables = { ...opcuaAll(myServer, {
 *   match: /^ns=2;s=RTU45/,
 *   exclude: /Diagnostic|_System/,
 *   deadband: { value: 1.0 },
 *   rbeRules: [
 *     { match: /PIT_\d+/, deadband: { value: 0.1, maxTime: 30000 } },
 *   ],
 *   rbeOverrides: {
 *     "ns=2;s=RTU45.CriticalPressure": { deadband: { value: 0.01 } },
 *   },
 * }) };
 * ```
 */

import {
  resolveRbe,
  type DeadBandConfig,
  type PlcVariableBooleanConfig,
  type PlcVariableConfig,
  type PlcVariableNumberConfig,
  type PlcVariableStringConfig,
  type RbeOverride,
  type RbeRule,
} from "./types/variables.ts";

/** Shape of a generated OPC UA device constant (from codegen) */
export type OpcUaDevice = {
  readonly id: string;
  readonly endpointUrl: string;
  readonly nodes: Readonly<Record<string, { readonly datatype: string; readonly displayName: string }>>;
};

/** Source descriptor for an OPC UA node */
export type OpcUaSource = {
  deviceId: string;
  endpointUrl: string;
  nodeId: string;
};

/** Optional overrides for opcuaVar */
type OpcUaVarOptions = {
  id?: string;
  description?: string;
  deadband?: DeadBandConfig;
  disableRBE?: boolean;
  scanRate?: number;
};

/** Filter options for bulk functions */
type OpcUaBulkOptions = {
  /** Only include nodes whose NodeId matches this pattern */
  match?: RegExp;
  /** Exclude nodes whose NodeId matches this pattern */
  exclude?: RegExp;
  /** Default RBE deadband applied to all numeric variables (lowest priority) */
  deadband?: DeadBandConfig;
  /** Disable RBE checking on all variables (lowest priority) */
  disableRBE?: boolean;
  /** Override scan rate for all variables */
  scanRate?: number;
  /** Pattern-based RBE rules — first matching rule wins (overrides default deadband/disableRBE) */
  rbeRules?: RbeRule[];
  /** Per-node RBE overrides — highest priority */
  rbeOverrides?: Record<string, RbeOverride>;
};

/**
 * Create a type-safe OPC UA source for a PLC variable.
 *
 * @param device - Generated device constant (from codegen)
 * @param nodeId - NodeId string (autocompleted and type-checked against the device)
 * @returns VariableSource with `opcua` field set
 */
export function opcuaTag<D extends OpcUaDevice>(
  device: D,
  nodeId: keyof D["nodes"] & string,
): { opcua: OpcUaSource } {
  return {
    opcua: {
      deviceId: device.id,
      endpointUrl: device.endpointUrl,
      nodeId,
    },
  };
}

/** Infer PLC variable datatype from OPC UA datatype string */
function inferDatatype(raw: string): "number" | "boolean" | "string" {
  switch (raw) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    default:
      return "string";
  }
}

/** Build an OPC UA source object */
function makeSource(
  device: OpcUaDevice,
  nodeId: string,
  scanRate?: number,
): { opcua: OpcUaSource & { scanRate?: number } } {
  return {
    opcua: {
      deviceId: device.id,
      endpointUrl: device.endpointUrl,
      nodeId,
      ...(scanRate ? { scanRate } : {}),
    },
  };
}

/** Create an atomic variable config from a node */
function makeAtomicVar(
  device: OpcUaDevice,
  nodeId: string,
  datatype: string,
  displayName: string,
  bulkOptions?: OpcUaBulkOptions,
): PlcVariableNumberConfig | PlcVariableBooleanConfig | PlcVariableStringConfig {
  const dt = inferDatatype(datatype);
  const id = nodeId.replace(/[^a-zA-Z0-9_]/g, "_");
  const rbe = resolveRbe(nodeId, bulkOptions);
  const base = {
    id,
    description: displayName,
    source: makeSource(device, nodeId, bulkOptions?.scanRate),
    ...(rbe.disableRBE ? { disableRBE: true } : {}),
  };
  switch (dt) {
    case "boolean":
      return { ...base, datatype: "boolean", default: false };
    case "string":
      return { ...base, datatype: "string", default: "" };
    default:
      return { ...base, datatype: "number", default: 0, ...(rbe.deadband ? { deadband: rbe.deadband } : {}) };
  }
}

/**
 * Create a fully-wired PlcVariableConfig for a single OPC UA node.
 */
export function opcuaVar<D extends OpcUaDevice>(
  device: D,
  nodeId: keyof D["nodes"] & string,
  options?: OpcUaVarOptions,
): PlcVariableNumberConfig | PlcVariableBooleanConfig | PlcVariableStringConfig {
  const info = device.nodes[nodeId];
  const dt = inferDatatype(info.datatype);
  const id = options?.id ?? (nodeId as string).replace(/[^a-zA-Z0-9_]/g, "_");
  const base = {
    id,
    description: options?.description ?? info.displayName,
    source: makeSource(device, nodeId, options?.scanRate),
    ...(options?.deadband ? { deadband: options.deadband } : {}),
    ...(options?.disableRBE ? { disableRBE: options.disableRBE } : {}),
  };
  switch (dt) {
    case "boolean":
      return { ...base, datatype: "boolean", default: false } as PlcVariableBooleanConfig;
    case "string":
      return { ...base, datatype: "string", default: "" } as PlcVariableStringConfig;
    default:
      return { ...base, datatype: "number", default: 0 } as PlcVariableNumberConfig;
  }
}

/** Check if a NodeId passes match/exclude filters */
function passesFilter(nodeId: string, options?: OpcUaBulkOptions): boolean {
  if (options?.match && !options.match.test(nodeId)) return false;
  if (options?.exclude && options.exclude.test(nodeId)) return false;
  return true;
}

/**
 * Bulk-create PlcVariableConfigs for all nodes on a device.
 * Without options, preserves NodeId keys for autocomplete.
 */
export function opcuaVars<D extends OpcUaDevice>(
  device: D,
): { [K in keyof D["nodes"] & string]: PlcVariableConfig };
export function opcuaVars<D extends OpcUaDevice>(
  device: D,
  options: OpcUaBulkOptions,
): Record<string, PlcVariableConfig>;
export function opcuaVars(
  device: OpcUaDevice,
  options?: OpcUaBulkOptions,
): Record<string, PlcVariableConfig> {
  const result: Record<string, PlcVariableConfig> = {};
  for (const [nodeId, info] of Object.entries(device.nodes)) {
    if (!passesFilter(nodeId, options)) continue;
    result[nodeId] = makeAtomicVar(device, nodeId, info.datatype, info.displayName, options);
  }
  return result;
}

/**
 * Bulk-create PlcVariableConfigs for ALL nodes on a device.
 * Alias for opcuaVars — OPC UA has no struct/UDT distinction at the browse level.
 * Provided for API consistency with eipAll.
 */
export function opcuaAll<D extends OpcUaDevice>(
  device: D,
): { [K in keyof D["nodes"] & string]: PlcVariableConfig };
export function opcuaAll<D extends OpcUaDevice>(
  device: D,
  options: OpcUaBulkOptions,
): Record<string, PlcVariableConfig>;
export function opcuaAll(
  device: OpcUaDevice,
  options?: OpcUaBulkOptions,
): Record<string, PlcVariableConfig> {
  return opcuaVars(device, options as OpcUaBulkOptions);
}
