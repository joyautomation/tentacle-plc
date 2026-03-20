/**
 * SNMP Source Helpers
 *
 * Provides type-safe helpers for sourcing PLC variables from SNMP devices.
 * Use with generated device types from `codegen.ts` for compile-time OID validation.
 *
 * @example
 * ```typescript
 * import { snmpAll } from "@tentacle/plc";
 * import { mySwitch } from "./generated/snmp.ts";
 *
 * // All OIDs at once (preserves key autocomplete):
 * const variables = { ...snmpAll(mySwitch) };
 *
 * // Filtered:
 * const variables = { ...snmpVars(mySwitch, { match: /^ifDescr/ }) };
 *
 * // Single OID with overrides:
 * import { snmpVar } from "@tentacle/plc";
 * const uptime = snmpVar(mySwitch, "sysUpTime_0", {
 *   description: "System uptime in centiseconds",
 * });
 * ```
 */

import type {
  DeadBandConfig,
  PlcVariableBooleanConfig,
  PlcVariableConfig,
  PlcVariableNumberConfig,
  PlcVariableStringConfig,
} from "./types/variables.ts";

/** Shape of a generated SNMP device constant (from codegen) */
export type SnmpDevice = {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly version: "v1" | "v2c" | "v3";
  readonly community?: string;
  readonly v3Auth?: {
    readonly username: string;
    readonly authProtocol?: string;
    readonly authPassword?: string;
    readonly privProtocol?: string;
    readonly privPassword?: string;
    readonly securityLevel: string;
  };
  readonly oids: Readonly<
    Record<
      string,
      {
        readonly oid: string;
        readonly datatype: string;
        readonly snmpType: string;
        readonly displayName?: string;
      }
    >
  >;
};

/** Source descriptor for an SNMP OID */
export type SnmpSource = {
  deviceId: string;
  host: string;
  port: number;
  version: "v1" | "v2c" | "v3";
  community?: string;
  v3Auth?: SnmpDevice["v3Auth"];
  oid: string;
  scanRate?: number;
};

/** Optional overrides for snmpVar */
type SnmpVarOptions = {
  id?: string;
  description?: string;
  deadband?: DeadBandConfig;
  disableRBE?: boolean;
  scanRate?: number;
};

/** Filter options for bulk functions */
type SnmpBulkOptions = {
  /** Only include OIDs whose key matches this pattern */
  match?: RegExp;
  /** Exclude OIDs whose key matches this pattern */
  exclude?: RegExp;
  /** RBE deadband applied to all numeric variables */
  deadband?: DeadBandConfig;
  /** Disable RBE checking on all variables */
  disableRBE?: boolean;
  /** Override scan rate for all variables */
  scanRate?: number;
};

/**
 * Create a type-safe SNMP source for a PLC variable.
 */
export function snmpTag<D extends SnmpDevice>(
  device: D,
  oidKey: keyof D["oids"] & string,
): { snmp: SnmpSource } {
  const info = device.oids[oidKey];
  return {
    snmp: {
      deviceId: device.id,
      host: device.host,
      port: device.port,
      version: device.version,
      ...(device.community ? { community: device.community } : {}),
      ...(device.v3Auth ? { v3Auth: device.v3Auth } : {}),
      oid: info.oid,
    },
  };
}

/** Infer PLC variable datatype from SNMP type */
function inferDatatype(snmpDatatype: string): "number" | "boolean" | "string" {
  switch (snmpDatatype) {
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/** Build an SNMP source object */
function makeSource(
  device: SnmpDevice,
  oid: string,
  scanRate?: number,
): { snmp: SnmpSource } {
  return {
    snmp: {
      deviceId: device.id,
      host: device.host,
      port: device.port,
      version: device.version,
      ...(device.community ? { community: device.community } : {}),
      ...(device.v3Auth ? { v3Auth: device.v3Auth } : {}),
      oid,
      ...(scanRate ? { scanRate } : {}),
    },
  };
}

/** Create an atomic variable config from an OID key */
function makeAtomicVar(
  device: SnmpDevice,
  key: string,
  oid: string,
  datatype: string,
  bulkOptions?: SnmpBulkOptions,
): PlcVariableNumberConfig | PlcVariableBooleanConfig | PlcVariableStringConfig {
  const dt = inferDatatype(datatype);
  const id = key.replace(/[^a-zA-Z0-9_]/g, "_");
  const base = {
    id,
    description: "",
    source: makeSource(device, oid, bulkOptions?.scanRate),
    ...(bulkOptions?.disableRBE ? { disableRBE: true } : {}),
  };
  switch (dt) {
    case "boolean":
      return { ...base, datatype: "boolean", default: false };
    case "string":
      return { ...base, datatype: "string", default: "" };
    default:
      return {
        ...base,
        datatype: "number",
        default: 0,
        ...(bulkOptions?.deadband ? { deadband: bulkOptions.deadband } : {}),
      };
  }
}

/**
 * Create a fully-wired PlcVariableConfig for a single SNMP OID.
 */
export function snmpVar<D extends SnmpDevice>(
  device: D,
  oidKey: keyof D["oids"] & string,
  options?: SnmpVarOptions,
): PlcVariableNumberConfig | PlcVariableBooleanConfig | PlcVariableStringConfig {
  const info = device.oids[oidKey];
  const dt = inferDatatype(info.datatype);
  const id = options?.id ?? (oidKey as string).replace(/[^a-zA-Z0-9_]/g, "_");
  const base = {
    id,
    description: options?.description ?? "",
    source: makeSource(device, info.oid, options?.scanRate),
    ...(options?.deadband ? { deadband: options.deadband } : {}),
    ...(options?.disableRBE ? { disableRBE: options.disableRBE } : {}),
  };
  switch (dt) {
    case "boolean":
      return {
        ...base,
        datatype: "boolean",
        default: false,
      } as PlcVariableBooleanConfig;
    case "string":
      return {
        ...base,
        datatype: "string",
        default: "",
      } as PlcVariableStringConfig;
    default:
      return {
        ...base,
        datatype: "number",
        default: 0,
      } as PlcVariableNumberConfig;
  }
}

/** Check if an OID key passes match/exclude filters */
function passesFilter(key: string, options?: SnmpBulkOptions): boolean {
  if (options?.match && !options.match.test(key)) return false;
  if (options?.exclude && options.exclude.test(key)) return false;
  return true;
}

/**
 * Bulk-create PlcVariableConfigs for all OIDs on a device.
 * Without options, preserves OID key names for autocomplete.
 */
export function snmpVars<D extends SnmpDevice>(
  device: D,
): { [K in keyof D["oids"] & string]: PlcVariableConfig };
export function snmpVars<D extends SnmpDevice>(
  device: D,
  options: SnmpBulkOptions,
): Record<string, PlcVariableConfig>;
export function snmpVars(
  device: SnmpDevice,
  options?: SnmpBulkOptions,
): Record<string, PlcVariableConfig> {
  const result: Record<string, PlcVariableConfig> = {};
  for (const [key, info] of Object.entries(device.oids)) {
    if (!passesFilter(key, options)) continue;
    result[key] = makeAtomicVar(device, key, info.oid, info.datatype, options);
  }
  return result;
}

/**
 * Bulk-create PlcVariableConfigs for ALL OIDs on a device.
 * Alias for snmpVars — SNMP has no struct/UDT distinction.
 * Provided for API consistency with eipAll.
 */
export function snmpAll<D extends SnmpDevice>(
  device: D,
): { [K in keyof D["oids"] & string]: PlcVariableConfig };
export function snmpAll<D extends SnmpDevice>(
  device: D,
  options: SnmpBulkOptions,
): Record<string, PlcVariableConfig>;
export function snmpAll(
  device: SnmpDevice,
  options?: SnmpBulkOptions,
): Record<string, PlcVariableConfig> {
  return snmpVars(device, options as SnmpBulkOptions);
}
