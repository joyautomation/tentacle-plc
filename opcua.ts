/**
 * OPC UA Source Helper
 *
 * Provides type-safe helpers for sourcing PLC variables from OPC UA servers.
 * Use with generated device types from `codegen.ts` for compile-time NodeId validation.
 *
 * @example
 * ```typescript
 * import { opcuaTag } from "@tentacle/plc/opcua";
 * import { myServer } from "./generated/opcua.ts";
 *
 * const variables = {
 *   temperature: {
 *     id: "temperature",
 *     datatype: "number",
 *     default: 0,
 *     source: opcuaTag(myServer, "ns=2;s=Temperature"),
 *     //                          ^-- autocomplete + compile error if invalid
 *   } satisfies PlcVariableNumberConfig,
 * };
 * ```
 */

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
