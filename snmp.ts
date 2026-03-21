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

import {
  resolveRbe,
  type DeadBandConfig,
  type PlcVariableBooleanConfig,
  type PlcVariableConfig,
  type PlcVariableNumberConfig,
  type PlcVariableStringConfig,
  type PlcVariableUdtConfig,
  type RbeOverride,
  type RbeRule,
  type UdtTemplateDefinition,
  type VariableSource,
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
  readonly structTags?: Readonly<Record<string, string>>;
};

/** Map of SNMP table type names to their template definitions */
export type SnmpTableTemplateMap = Readonly<Record<string, UdtTemplateDefinition & {
  readonly members: ReadonlyArray<{
    readonly name: string;
    readonly datatype: "number" | "boolean" | "string";
    readonly subId: number;
  }>;
}>>;

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
  /** Default RBE deadband applied to all numeric variables (lowest priority) */
  deadband?: DeadBandConfig;
  /** Disable RBE checking on all variables (lowest priority) */
  disableRBE?: boolean;
  /** Override scan rate for all variables */
  scanRate?: number;
  /** Pattern-based RBE rules — first matching rule wins (overrides default deadband/disableRBE) */
  rbeRules?: RbeRule[];
  /** Per-tag RBE overrides — highest priority */
  rbeOverrides?: Record<string, RbeOverride>;
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
  const rbe = resolveRbe(key, bulkOptions);
  const base = {
    id,
    description: "",
    source: makeSource(device, oid, bulkOptions?.scanRate),
    ...(rbe.disableRBE ? { disableRBE: true } : {}),
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
        ...(rbe.deadband ? { deadband: rbe.deadband } : {}),
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

/** Build a default value object from a table template */
function buildTableDefault(
  template: UdtTemplateDefinition,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const member of template.members) {
    switch (member.datatype) {
      case "boolean":
        result[member.name] = false;
        break;
      case "number":
        result[member.name] = 0;
        break;
      default:
        result[member.name] = "";
        break;
    }
  }
  return result;
}

/** Build per-member SNMP sources for a table instance.
 *  Each column gets its own SNMP OID subscription. */
function buildTableMemberSources(
  device: SnmpDevice,
  instanceKey: string,
  template: UdtTemplateDefinition & { members: ReadonlyArray<{ name: string; subId?: number }> },
  bulkOptions?: SnmpBulkOptions,
): Record<string, VariableSource> {
  const sources: Record<string, VariableSource> = {};
  for (const member of template.members) {
    // Look up the per-instance column OID from the device's oids map
    // Codegen places these as "instanceKey_columnName" keys
    const memberOidKey = `${instanceKey}_${member.name}`;
    // Also try the direct resolved name pattern: "columnName.instanceSuffix"
    const info = (device.oids as Record<string, { oid: string }>)[memberOidKey];
    if (!info) continue;

    sources[member.name] = makeSource(device, info.oid, bulkOptions?.scanRate);
  }
  return sources;
}

/** Create a UDT variable for an SNMP table instance */
function makeSnmpUdtVar(
  device: SnmpDevice,
  instanceKey: string,
  template: UdtTemplateDefinition & { members: ReadonlyArray<{ name: string; subId?: number }> },
  bulkOptions?: SnmpBulkOptions,
): PlcVariableUdtConfig {
  const id = instanceKey.replace(/[^a-zA-Z0-9_]/g, "_");
  const rbe = resolveRbe(instanceKey, bulkOptions);
  return {
    id,
    description: `${template.name} instance`,
    datatype: "udt",
    default: buildTableDefault(template),
    udtTemplate: template,
    memberSources: buildTableMemberSources(device, instanceKey, template, bulkOptions),
    ...(rbe.deadband ? { deadband: rbe.deadband } : {}),
    ...(rbe.disableRBE ? { disableRBE: true } : {}),
  };
}

/**
 * Bulk-create PlcVariableConfigs for ALL OIDs on a device (atomic + table structs).
 * When templates are provided, table instances become UDT variables with memberSources.
 * Without templates, all OIDs are treated as atomic variables.
 */
export function snmpAll<D extends SnmpDevice>(
  device: D,
  templates?: SnmpTableTemplateMap,
): { [K in keyof D["oids"] & string]: PlcVariableConfig };
export function snmpAll<D extends SnmpDevice>(
  device: D,
  templates: SnmpTableTemplateMap | undefined,
  options: SnmpBulkOptions,
): Record<string, PlcVariableConfig>;
// Legacy overload: no templates, just options
export function snmpAll<D extends SnmpDevice>(
  device: D,
  options: SnmpBulkOptions,
): Record<string, PlcVariableConfig>;
export function snmpAll(
  device: SnmpDevice,
  templatesOrOptions?: SnmpTableTemplateMap | SnmpBulkOptions,
  maybeOptions?: SnmpBulkOptions,
): Record<string, PlcVariableConfig> {
  // Disambiguate overloads: if second arg has match/exclude/deadband, it's options
  let templates: SnmpTableTemplateMap | undefined;
  let options: SnmpBulkOptions | undefined;

  if (templatesOrOptions && ("match" in templatesOrOptions || "exclude" in templatesOrOptions || "deadband" in templatesOrOptions || "disableRBE" in templatesOrOptions || "scanRate" in templatesOrOptions || "rbeRules" in templatesOrOptions)) {
    options = templatesOrOptions as SnmpBulkOptions;
  } else {
    templates = templatesOrOptions as SnmpTableTemplateMap | undefined;
    options = maybeOptions;
  }

  const result: Record<string, PlcVariableConfig> = {};
  const structTags = device.structTags as Record<string, string> | undefined;

  // Build UDT variables first from structTags
  const includedStructNames = new Set<string>();
  if (templates && structTags) {
    for (const [instanceKey, typeName] of Object.entries(structTags)) {
      if (!passesFilter(instanceKey, options)) continue;
      const template = templates[typeName];
      if (!template) continue;
      includedStructNames.add(instanceKey);
      result[instanceKey] = makeSnmpUdtVar(device, instanceKey, template, options);
    }
  }

  // Add remaining atomic OIDs (skip those that belong to included table instances)
  for (const [key, info] of Object.entries(device.oids)) {
    // Skip OIDs that are columns of included table instances
    if (includedStructNames.size > 0) {
      const underscoreIdx = key.indexOf("_");
      if (underscoreIdx !== -1) {
        // Check if any structTag key is a prefix of this OID key
        let isColumn = false;
        for (const structKey of includedStructNames) {
          if (key.startsWith(structKey + "_")) {
            isColumn = true;
            break;
          }
        }
        if (isColumn) continue;
      }
    }
    if (!passesFilter(key, options)) continue;
    result[key] = makeAtomicVar(device, key, info.oid, info.datatype, options);
  }

  return result;
}
