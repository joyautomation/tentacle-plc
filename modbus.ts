/**
 * Modbus Source Helper
 *
 * Provides type-safe helpers for sourcing PLC variables from Modbus TCP devices.
 * Use with generated device types from `codegen.ts` for compile-time tag validation.
 *
 * @example
 * ```typescript
 * import { modbusTag } from "@tentacle/plc/modbus";
 * import { pumpSkid } from "./generated/modbus.ts";
 *
 * const variables = {
 *   pumpSpeed: {
 *     id: "pumpSpeed",
 *     datatype: "number",
 *     default: 0,
 *     source: modbusTag(pumpSkid, "pump_speed"),
 *     //                          ^-- autocomplete + compile error if invalid
 *   } satisfies PlcVariableNumberConfig,
 * };
 * ```
 */

/** Shape of a generated Modbus device constant (from codegen) */
export type ModbusDevice = {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly unitId: number;
  readonly byteOrder: string;
  readonly tags: Readonly<
    Record<
      string,
      {
        readonly datatype: string;
        readonly address: number;
        readonly functionCode: string;
        readonly modbusDatatype: string;
        readonly byteOrder: string;
      }
    >
  >;
};

/** Source descriptor for a Modbus tag */
export type ModbusSource = {
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

/**
 * Create a type-safe Modbus source for a PLC variable.
 *
 * @param device - Generated device constant (from codegen)
 * @param tagId - Tag ID (autocompleted and type-checked against the device)
 * @param options - Optional overrides (scanRate)
 * @returns VariableSource with `modbus` field set
 */
export function modbusTag<D extends ModbusDevice>(
  device: D,
  tagId: keyof D["tags"] & string,
  options?: { scanRate?: number },
): { modbus: ModbusSource } {
  const tag = device.tags[tagId];
  return {
    modbus: {
      deviceId: device.id,
      host: device.host,
      port: device.port,
      unitId: device.unitId,
      tag: tagId,
      address: tag.address,
      functionCode: tag.functionCode as "coil" | "discrete" | "holding" | "input",
      modbusDatatype: tag.modbusDatatype,
      byteOrder: tag.byteOrder,
      ...options,
    },
  };
}
