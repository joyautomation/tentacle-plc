export type NatsConfig = {
  servers: string | string[];
  user?: string;
  pass?: string;
  token?: string;
};

export type VariableSource = {
  subject?: string;
  bidirectional?: boolean;
  onResponse?: (value: number | boolean | string) => void;
  onSend?: (value: number | boolean | string) => void;
};

/** Report By Exception (RBE) deadband configuration */
export type DeadBandConfig = {
  /** Threshold value: only publish if change exceeds this amount (for numeric types) */
  value: number;
  /** Maximum time (ms) between publishes regardless of change. Forces publish if exceeded. */
  maxTime?: number;
};

export type PlcVariableBase = {
  id: string;
  description: string;
  source?: VariableSource;
  /** RBE deadband configuration - if not specified, all changes are published */
  deadband?: DeadBandConfig;
  /** Disable RBE checking - forces publish of all changes (for debugging) */
  disableRBE?: boolean;
};

export type PlcVariableNumber = PlcVariableBase & {
  datatype: "number";
  default: number;
  value: number;
};

export type PlcVariableBoolean = PlcVariableBase & {
  datatype: "boolean";
  default: boolean;
  value: boolean;
};

export type PlcVariableString = PlcVariableBase & {
  datatype: "string";
  default: string;
  value: string;
};

export type PlcVariableUdt<T> = PlcVariableBase & {
  datatype: "udt";
  default: T;
  value: T;
};

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

/**
 * Type guard to check if a variable is a boolean PLC variable.
 * @param variable - The variable to check
 * @returns True if the variable is a boolean PLC variable
 * @public
 */
export const isVariableBoolean = (
  variable: unknown,
): variable is PlcVariableBoolean =>
  isVariableType<PlcVariableBoolean>(variable, "boolean");

/**
 * Type guard to check if a variable is a string PLC variable.
 * @param variable - The variable to check
 * @returns True if the variable is a string PLC variable
 * @public
 */
export const isVariableString = (
  variable: unknown,
): variable is PlcVariableString =>
  isVariableType<PlcVariableString>(variable, "string");

/**
 * Type guard to check if a variable is a user-defined type (UDT) PLC variable.
 * @param variable - The variable to check
 * @returns True if the variable is a UDT PLC variable
 * @public
 */
export const isVariableUdt = (
  variable: unknown,
): variable is PlcVariableUdt<unknown> =>
  isVariableType<PlcVariableUdt<unknown>>(variable, "udt");

export type PlcVariable =
  | PlcVariableNumber
  | PlcVariableBoolean
  | PlcVariableString
  | PlcVariableUdt<unknown>;

export type PlcVariables<
  V extends Record<string, PlcVariable> = Record<
    string,
    PlcVariable
  >,
> = V;
