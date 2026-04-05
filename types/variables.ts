/**
 * PLC Variable Type Definitions
 *
 * Separates configuration types (what user defines) from runtime types (with values).
 */

export type NatsConfig = {
  servers: string | string[];
  user?: string;
  pass?: string;
  token?: string;
};

/** NATS source configuration for bidirectional communication */
export type VariableSource = {
  /** Custom subject override. Defaults to: ${projectId}/${variableId} */
  subject?: string;
  /** Enable bidirectional communication (receive commands from NATS) */
  bidirectional?: boolean;
  /** Transform incoming values before applying */
  onResponse?: (value: number | boolean | string) => number | boolean | string;
  /** Transform outgoing values before publishing */
  onSend?: (value: number | boolean | string) => number | boolean | string;
  /** EtherNet/IP tag source — subscribes to ethernetip scanner for this tag */
  ethernetip?: { deviceId: string; host: string; port: number; tag: string; cipType?: string; scanRate?: number };
  /** OPC UA node source — subscribes to opcua scanner for this node */
  opcua?: { deviceId: string; endpointUrl: string; nodeId: string; scanRate?: number };
  /** Modbus tag source — subscribes to modbus scanner for this tag */
  modbus?: {
    deviceId: string;
    host: string;
    port: number;
    unitId: number;
    tag: string;
    address: number;
    functionCode: "coil" | "discrete" | "holding" | "input";
    modbusDatatype: string;
    byteOrder: string;
    scanRate?: number;
  };
  /** SNMP OID source — subscribes to SNMP scanner for this OID */
  snmp?: {
    deviceId: string;
    host: string;
    port: number;
    version: "v1" | "v2c" | "v3";
    community?: string;
    v3Auth?: {
      username: string;
      authProtocol?: string;
      authPassword?: string;
      privProtocol?: string;
      privPassword?: string;
      securityLevel: string;
    };
    oid: string;
    scanRate?: number;
  };
};

/** Report By Exception (RBE) deadband configuration */
export type DeadBandConfig = {
  /** Threshold value: only publish if change exceeds this amount (for numeric types) */
  value: number;
  /** Minimum time (ms) between publishes. Suppresses rapid changes. */
  minTime?: number;
  /** Maximum time (ms) between publishes regardless of change. Forces publish if exceeded. */
  maxTime?: number;
};

/** Pattern-based RBE rule for bulk variable configuration */
export type RbeRule = {
  /** Tags matching this pattern get the specified RBE config */
  match: RegExp;
  /** Deadband configuration for matching tags */
  deadband?: DeadBandConfig;
  /** Disable RBE checking for matching tags */
  disableRBE?: boolean;
};

/** Per-tag RBE override (highest priority) */
export type RbeOverride = {
  deadband?: DeadBandConfig;
  disableRBE?: boolean;
};

/**
 * Resolve RBE configuration for a tag using priority: override > rule > default.
 * Returns { deadband, disableRBE } with undefined for unset fields.
 */
export function resolveRbe(
  tagName: string,
  options?: {
    deadband?: DeadBandConfig;
    disableRBE?: boolean;
    rbeRules?: RbeRule[];
    rbeOverrides?: Record<string, RbeOverride>;
  },
): { deadband?: DeadBandConfig; disableRBE?: boolean } {
  if (!options) return {};
  // Per-tag override (highest priority)
  if (options.rbeOverrides?.[tagName]) {
    return options.rbeOverrides[tagName];
  }
  // First matching rule wins
  if (options.rbeRules) {
    for (const rule of options.rbeRules) {
      if (rule.match.test(tagName)) {
        return { deadband: rule.deadband, disableRBE: rule.disableRBE };
      }
    }
  }
  // Default
  return { deadband: options.deadband, disableRBE: options.disableRBE };
}

// =============================================================================
// Configuration Types (what user defines - no runtime value)
// =============================================================================

export type PlcVariableConfigBase = {
  id: string;
  description: string;
  source?: VariableSource;
  /** RBE deadband configuration - if not specified, all changes are published */
  deadband?: DeadBandConfig;
  /** Disable RBE checking - forces publish of all changes (for debugging) */
  disableRBE?: boolean;
};

export type PlcVariableNumberConfig = PlcVariableConfigBase & {
  datatype: "number";
  default: number;
};

export type PlcVariableBooleanConfig = PlcVariableConfigBase & {
  datatype: "boolean";
  default: boolean;
};

export type PlcVariableStringConfig = PlcVariableConfigBase & {
  datatype: "string";
  default: string;
};

/**
 * Sparkplug B UDT template definition for a PLC UDT variable.
 * When provided, tentacle-mqtt publishes this variable as a Sparkplug B
 * Template Instance rather than a plain JSON string.
 */
export type UdtTemplateDefinition = {
  /** Template type name used as templateRef in Sparkplug B (e.g. "MotorDrive") */
  name: string;
  version?: string;
  members: ReadonlyArray<{
    readonly name: string;
    readonly datatype: "number" | "boolean" | "string";
    readonly description?: string;
    /** For nested struct members: reference to another UDT template by name */
    readonly templateRef?: string;
    /** For array members */
    readonly isArray?: boolean;
  }>;
};

export type PlcVariableUdtConfig<T = Record<string, unknown>> = PlcVariableConfigBase & {
  datatype: "udt";
  default: T;
  /** Optional Sparkplug B template definition. When set, tentacle-mqtt publishes
   *  this variable as a Template Instance rather than a JSON-stringified string. */
  udtTemplate?: UdtTemplateDefinition;
  /** Per-member variable sources keyed by dotted member path (e.g., "AUTOCMD", "timer.ACC").
   *  Each member source drives an individual scanner subscription. The PLC runtime
   *  routes incoming member data into this UDT's value object at the corresponding path. */
  memberSources?: Record<string, VariableSource>;
  /** Per-member RBE deadband config keyed by member name. Resolved from:
   *  instance override → template default → device default. */
  memberDeadbands?: Record<string, DeadBandConfig>;
};

export type PlcVariableConfig =
  | PlcVariableNumberConfig
  | PlcVariableBooleanConfig
  | PlcVariableStringConfig
  | PlcVariableUdtConfig;

/** Map of variable IDs to their configurations */
export type PlcVariablesConfig<
  V extends Record<string, PlcVariableConfig> = Record<string, PlcVariableConfig>
> = V;

// =============================================================================
// Runtime Types (configuration + current value)
// =============================================================================

export type PlcVariableNumber = PlcVariableNumberConfig & {
  value: number;
};

export type PlcVariableBoolean = PlcVariableBooleanConfig & {
  value: boolean;
};

export type PlcVariableString = PlcVariableStringConfig & {
  value: string;
};

export type PlcVariableUdt<T = Record<string, unknown>> = PlcVariableUdtConfig<T> & {
  value: T;
};

export type PlcVariable =
  | PlcVariableNumber
  | PlcVariableBoolean
  | PlcVariableString
  | PlcVariableUdt;

/** Map of variable IDs to their runtime state */
export type PlcVariables<
  V extends Record<string, PlcVariable> = Record<string, PlcVariable>
> = V;

/** Transform config variables to runtime variables with values */
export type PlcVariablesRuntime<V extends PlcVariablesConfig> = {
  [K in keyof V]: V[K] extends PlcVariableNumberConfig
    ? PlcVariableNumber
    : V[K] extends PlcVariableBooleanConfig
      ? PlcVariableBoolean
      : V[K] extends PlcVariableStringConfig
        ? PlcVariableString
        : V[K] extends PlcVariableUdtConfig<infer T>
          ? PlcVariableUdt<T>
          : V[K] extends PlcVariableConfig
            ? PlcVariable
            : never;
};

// =============================================================================
// Type Guards
// =============================================================================

export const isVariableType = <T>(
  variable: unknown,
  datatype: "number" | "boolean" | "string" | "udt",
): variable is T =>
  typeof variable === "object" &&
  variable !== null &&
  "datatype" in variable &&
  variable.datatype === datatype;

export const isVariableNumber = (
  variable: unknown,
): variable is PlcVariableNumber =>
  isVariableType<PlcVariableNumber>(variable, "number");

export const isVariableBoolean = (
  variable: unknown,
): variable is PlcVariableBoolean =>
  isVariableType<PlcVariableBoolean>(variable, "boolean");

export const isVariableString = (
  variable: unknown,
): variable is PlcVariableString =>
  isVariableType<PlcVariableString>(variable, "string");

export const isVariableUdt = (
  variable: unknown,
): variable is PlcVariableUdt =>
  isVariableType<PlcVariableUdt>(variable, "udt");
