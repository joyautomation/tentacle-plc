/**
 * @tentacle/plc
 *
 * A lightweight PLC runtime for Deno with NATS integration.
 *
 * @example
 * ```typescript
 * import { createPlc, type PlcVariableNumberConfig } from "@tentacle/plc";
 *
 * const variables = {
 *   temperature: {
 *     id: "temperature",
 *     description: "Temperature sensor",
 *     datatype: "number",
 *     default: 20,
 *     source: { bidirectional: true },
 *   } satisfies PlcVariableNumberConfig,
 * };
 *
 * const plc = await createPlc({
 *   projectId: "my-plc",
 *   variables,
 *   tasks: {
 *     main: {
 *       name: "Main Task",
 *       description: "Main control loop",
 *       scanRate: 1000,
 *       program: (vars, update) => {
 *         update("temperature", vars.temperature.value + 0.1);
 *       },
 *     },
 *   },
 *   nats: { servers: "nats://localhost:4222" },
 * });
 *
 * // Graceful shutdown
 * Deno.addSignalListener("SIGINT", () => plc.stop());
 * ```
 */

// Main factory function
export { createPlc, createLogger, createPlcLogger, LogLevel, type Log } from "./plc.ts";

// Configuration types
export type {
  PlcConfig,
  PlcTask,
  PlcRuntime,
  Plc,
} from "./types/plc.ts";

// Variable configuration types (what user defines)
export type {
  PlcVariableNumberConfig,
  PlcVariableBooleanConfig,
  PlcVariableStringConfig,
  PlcVariableUdtConfig,
  PlcVariableConfig,
  PlcVariablesConfig,
  PlcVariablesRuntime,
  VariableSource,
  DeadBandConfig,
  UdtTemplateDefinition,
  NatsConfig,
} from "./types/variables.ts";

// Variable runtime types (with values)
export type {
  PlcVariableNumber,
  PlcVariableBoolean,
  PlcVariableString,
  PlcVariableUdt,
  PlcVariable,
  PlcVariables,
} from "./types/variables.ts";

// Type guards
export {
  isVariableNumber,
  isVariableBoolean,
  isVariableString,
  isVariableUdt,
  isVariableType,
} from "./types/variables.ts";

// EtherNet/IP source helpers
export { eipTag, eipVar, eipUdtVar, eipVars, eipUdtVars, eipAll } from "./ethernetip.ts";
export type { EipDevice, EthernetIPSource, UdtTemplateMap } from "./ethernetip.ts";

// OPC UA source helpers
export { opcuaTag } from "./opcua.ts";
export type { OpcUaDevice, OpcUaSource } from "./opcua.ts";

// Modbus source helpers
export { modbusTag } from "./modbus.ts";
export type { ModbusDevice, ModbusSource } from "./modbus.ts";

// SNMP source helpers
export { snmpTag, snmpVar, snmpVars, snmpAll } from "./snmp.ts";
export type { SnmpDevice, SnmpSource } from "./snmp.ts";

// Ladder logic DSL
export {
  createLadderProgram,
  NO,
  NC,
  OTE,
  OTL,
  OTU,
  TON,
  TOF,
  CTU,
  CTD,
  branch,
  series,
  RES,
} from "./ladder.ts";
export type {
  LadderContact,
  LadderSeries,
  LadderBranch,
  LadderCondition,
  LadderCoil,
  LadderTimer,
  LadderCounter,
  LadderOutput,
  LadderElement,
  RungDefinition,
} from "./ladder.ts";

// NATS utilities (for advanced usage)
export { parseValue } from "./nats.ts";
export type { NatsManager } from "./nats.ts";
