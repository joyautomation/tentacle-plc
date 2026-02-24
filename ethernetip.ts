/**
 * EtherNet/IP Source Helper
 *
 * Provides type-safe helpers for sourcing PLC variables from EtherNet/IP devices.
 * Use with generated device types from `codegen.ts` for compile-time tag validation.
 *
 * @example
 * ```typescript
 * import { eipTag } from "@tentacle/plc/ethernetip";
 * import { rtu45 } from "./generated/ethernetip.ts";
 *
 * const variables = {
 *   motorSpeed: {
 *     id: "motorSpeed",
 *     datatype: "number",
 *     default: 0,
 *     source: eipTag(rtu45, "Program:MainProgram.Motor_Speed"),
 *     //                     ^-- autocomplete + compile error if invalid
 *   } satisfies PlcVariableNumberConfig,
 * };
 * ```
 */

/** Shape of a generated EIP device constant (from codegen) */
export type EipDevice = {
  readonly id: string;
  readonly host: string;
  readonly port: number;
  readonly tags: Readonly<Record<string, { readonly datatype: string }>>;
};

/** Source descriptor for an EtherNet/IP tag */
export type EthernetIPSource = {
  deviceId: string;
  host: string;
  port: number;
  tag: string;
};

/**
 * Create a type-safe EtherNet/IP source for a PLC variable.
 *
 * @param device - Generated device constant (from codegen)
 * @param tag - Tag name (autocompleted and type-checked against the device)
 * @returns VariableSource with `ethernetip` field set
 */
export function eipTag<D extends EipDevice>(
  device: D,
  tag: keyof D["tags"] & string,
): { ethernetip: EthernetIPSource } {
  return {
    ethernetip: {
      deviceId: device.id,
      host: device.host,
      port: device.port,
      tag,
    },
  };
}
