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
};

/** Report By Exception (RBE) deadband configuration */
export type DeadBandConfig = {
  /** Threshold value: only publish if change exceeds this amount (for numeric types) */
  value: number;
  /** Maximum time (ms) between publishes regardless of change. Forces publish if exceeded. */
  maxTime?: number;
};

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

export type PlcVariableUdtConfig<T = Record<string, unknown>> = PlcVariableConfigBase & {
  datatype: "udt";
  default: T;
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
