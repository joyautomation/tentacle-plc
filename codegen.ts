/**
 * Codegen — Browse EtherNet/IP and OPC UA devices and generate TypeScript type definitions.
 * Also generates Modbus device types from a static register map schema (no live connection needed).
 *
 * Sends browse requests to running scanner instances with connection info,
 * then generates typed device objects that include connection details for runtime use.
 *
 * @example
 * ```typescript
 * import { generateEipTypes, generateOpcuaTypes, generateModbusTypes } from "@tentacle/plc/codegen";
 *
 * await generateEipTypes({
 *   nats: { servers: "nats://localhost:4222" },
 *   devices: [{ id: "plc1", host: "192.168.1.10" }],
 *   outputDir: "./generated",
 * });
 *
 * await generateOpcuaTypes({
 *   nats: { servers: "nats://localhost:4222" },
 *   devices: [{ id: "server1", endpointUrl: "opc.tcp://192.168.1.20:4840" }],
 *   outputDir: "./generated",
 * });
 *
 * // Modbus needs no live connection — define the register map directly:
 * await generateModbusTypes({
 *   devices: [{
 *     id: "pump-skid",
 *     host: "192.168.1.100",
 *     port: 502,
 *     unitId: 1,
 *     byteOrder: "ABCD",
 *     tags: [
 *       { id: "pump_speed", address: 0, functionCode: "holding", datatype: "float32" },
 *       { id: "pump_running", address: 0, functionCode: "coil", datatype: "boolean" },
 *     ],
 *   }],
 *   outputDir: "./generated",
 * });
 * ```
 */

import { connect } from "@nats-io/transport-deno";
import type { NatsConfig } from "./types/variables.ts";

/** Variable info returned by ethernetip.variables request */
type VariableInfo = {
  moduleId: string;
  deviceId: string;
  variableId: string;
  value: number | boolean | string | null;
  datatype: string;
  quality: string;
  origin: string;
  lastUpdated: number;
};

/** Browse progress message from ethernetip */
type BrowseProgressMessage = {
  browseId: string;
  moduleId: string;
  deviceId: string;
  phase: string;
  totalTags: number;
  completedTags: number;
  errorCount: number;
  message?: string;
  timestamp: number;
};

/** Device definition for codegen — tells ethernetip which PLCs to connect to */
export type EipDeviceConfig = {
  /** Unique device ID (used as KV key and in generated code) */
  id: string;
  /** Hostname or IP address of the EtherNet/IP device */
  host: string;
  /** Port number (default: 44818) */
  port?: number;
  /** Scan rate in ms (default: 1000) */
  scanRate?: number;
};

export type GenerateEipTypesOptions = {
  nats: NatsConfig;
  /** EtherNet/IP devices to browse */
  devices: EipDeviceConfig[];
  /** Directory to write generated files to (default: "./generated") */
  outputDir?: string;
  /** Timeout in ms per device for the browse to complete (default: 300000). Browse reads all tags from the PLC so it can take a while. */
  timeout?: number;
};

/**
 * Browse EtherNet/IP devices and generate typed device definitions.
 * Sends browse requests with connection info directly — no KV persistence needed.
 */
export async function generateEipTypes(
  options: GenerateEipTypesOptions,
): Promise<void> {
  const {
    nats: natsConfig,
    devices,
    outputDir = "./generated",
    timeout = 300_000,
  } = options;

  if (devices.length === 0) {
    console.log("No EtherNet/IP devices configured — skipping.");
    return;
  }

  const nc = await connect({
    servers: natsConfig.servers,
    user: natsConfig.user,
    pass: natsConfig.pass,
    token: natsConfig.token,
  });

  try {
    console.log(`Browsing ${devices.length} device(s)...`);

    const deviceTags = new Map<string, { host: string; port: number; tags: Map<string, string> }>();

    for (const device of devices) {
      const port = device.port ?? 44818;

      // Send synchronous browse request — returns results directly in the reply.
      // Async mode publishes progress but discards results, so ethernetip.variables
      // returns nothing. Sync mode waits for the full browse and returns the
      // VariableInfo[] in the NATS response.
      const browsePayload = JSON.stringify({
        deviceId: device.id,
        host: device.host,
        port,
      });

      console.log(`  Browsing ${device.id} (${device.host}:${port})...`);

      const browseResponse = await nc.request(
        "ethernetip.browse",
        new TextEncoder().encode(browsePayload),
        { timeout },
      );

      const variables = JSON.parse(
        new TextDecoder().decode(browseResponse.data),
      ) as VariableInfo[];

      const tags = new Map<string, string>();
      for (const v of variables) {
        if (v.deviceId === device.id) {
          tags.set(v.variableId, v.datatype);
        }
      }

      if (tags.size === 0) {
        console.warn(
          `  Warning: No tags found for ${device.id} (${device.host})`,
        );
      }

      deviceTags.set(device.id, { host: device.host, port, tags });
    }

    const totalTags = [...deviceTags.values()].reduce(
      (sum, d) => sum + d.tags.size,
      0,
    );

    if (totalTags === 0) {
      throw new Error(
        "No variables returned after browse. Make sure the devices are reachable.",
      );
    }

    // Generate TypeScript
    const lines: string[] = [
      "// Auto-generated by @tentacle/plc codegen — DO NOT EDIT",
      `// Generated at ${new Date().toISOString()}`,
      "",
    ];

    for (const [deviceId, deviceInfo] of deviceTags) {
      const safeId = deviceId.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`export const ${safeId} = {`);
      lines.push(`  id: ${JSON.stringify(deviceId)},`);
      lines.push(`  host: ${JSON.stringify(deviceInfo.host)},`);
      lines.push(`  port: ${deviceInfo.port},`);
      lines.push(`  tags: {`);

      // Sort tags for deterministic output
      const sortedTags = [...deviceInfo.tags.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      );

      for (const [tagName, datatype] of sortedTags) {
        lines.push(
          `    ${JSON.stringify(tagName)}: { datatype: ${JSON.stringify(datatype)} },`,
        );
      }

      lines.push(`  },`);
      lines.push(`} as const;`);
      lines.push("");
    }

    // Ensure output directory exists
    try {
      await Deno.mkdir(outputDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const outputPath = `${outputDir}/ethernetip.ts`;
    await Deno.writeTextFile(outputPath, lines.join("\n"));

    console.log(
      `Generated ${outputPath} with ${deviceTags.size} device(s) and ${totalTags} tag(s)`,
    );
  } finally {
    await nc.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OPC UA Codegen
// ═══════════════════════════════════════════════════════════════════════════

/** Variable info returned by opcua.variables request */
type OpcUaVariableInfo = {
  moduleId: string;
  deviceId: string;
  variableId: string;
  displayName: string;
  value: number | boolean | string | null;
  datatype: string;
  opcuaDatatype: string;
  quality: string;
  origin: string;
  lastUpdated: number;
};

/** OPC UA auth for browse — mirrors tentacle-opcua types */
export type OpcUaAuthConfig =
  | { type: "anonymous" }
  | { type: "username"; username: string; password: string }
  | { type: "certificate"; certPath: string; keyPath: string };

/** Device definition for OPC UA codegen */
export type OpcUaDeviceConfig = {
  /** Unique device ID (used in generated code) */
  id: string;
  /** OPC UA endpoint URL (e.g., "opc.tcp://192.168.1.10:4840") */
  endpointUrl: string;
  /** Security policy override (default: auto-negotiate best) */
  securityPolicy?: string;
  /** Security mode override (default: auto-negotiate) */
  securityMode?: string;
  /** Authentication (default: anonymous) */
  auth?: OpcUaAuthConfig;
  /** Starting NodeId for browse (default: Objects folder "i=85") */
  startNodeId?: string;
  /** Maximum browse depth (default: 10) */
  maxDepth?: number;
  /** Scan rate in ms (default: 1000) */
  scanRate?: number;
};

export type GenerateOpcuaTypesOptions = {
  nats: NatsConfig;
  /** OPC UA devices to browse */
  devices: OpcUaDeviceConfig[];
  /** Directory to write generated files to (default: "./generated") */
  outputDir?: string;
  /** Timeout in ms per device for the browse to complete (default: 300000) */
  timeout?: number;
};

/**
 * Browse OPC UA servers and generate typed device definitions.
 * Sends browse requests with connection info to a running tentacle-opcua instance.
 */
export async function generateOpcuaTypes(
  options: GenerateOpcuaTypesOptions,
): Promise<void> {
  const {
    nats: natsConfig,
    devices,
    outputDir = "./generated",
    timeout = 300_000,
  } = options;

  if (devices.length === 0) {
    console.log("No OPC UA devices configured — skipping.");
    return;
  }

  const nc = await connect({
    servers: natsConfig.servers,
    user: natsConfig.user,
    pass: natsConfig.pass,
    token: natsConfig.token,
  });

  try {
    console.log(`Browsing ${devices.length} OPC UA device(s)...`);

    const deviceNodes = new Map<
      string,
      { endpointUrl: string; nodes: Map<string, { datatype: string; displayName: string }> }
    >();

    for (const device of devices) {
      // Send browse request with connection info
      const browsePayload = JSON.stringify({
        deviceId: device.id,
        endpointUrl: device.endpointUrl,
        securityPolicy: device.securityPolicy,
        securityMode: device.securityMode,
        auth: device.auth,
        startNodeId: device.startNodeId,
        maxDepth: device.maxDepth,
        async: true,
      });

      console.log(`  Browsing ${device.id} (${device.endpointUrl})...`);

      const browseResponse = await nc.request(
        "opcua.browse",
        new TextEncoder().encode(browsePayload),
        { timeout: 60_000 },
      );

      const { browseId } = JSON.parse(
        new TextDecoder().decode(browseResponse.data),
      ) as { browseId: string };

      // Subscribe to progress updates
      const progressSubject = `opcua.browse.progress.${browseId}`;
      const progressSub = nc.subscribe(progressSubject);

      let completed = false;
      let failed = false;
      let failMessage = "";

      const timeoutId = setTimeout(() => {
        if (!completed && !failed) {
          failed = true;
          failMessage = `Browse of ${device.id} timed out after ${timeout / 1000}s`;
          progressSub.unsubscribe();
        }
      }, timeout);

      for await (const msg of progressSub) {
        const progress = JSON.parse(msg.string()) as BrowseProgressMessage;

        if (progress.message) {
          console.log(`  [${device.id}:${progress.phase}] ${progress.message}`);
        }

        if (
          progress.phase === "completed" &&
          (progress.deviceId === device.id || progress.deviceId === "_all")
        ) {
          completed = true;
          clearTimeout(timeoutId);
          progressSub.unsubscribe();
          break;
        }

        if (
          progress.phase === "failed" &&
          (progress.deviceId === device.id || progress.deviceId === "_all")
        ) {
          failed = true;
          failMessage = progress.message || `Browse of ${device.id} failed`;
          clearTimeout(timeoutId);
          progressSub.unsubscribe();
          break;
        }
      }

      if (failed) {
        throw new Error(failMessage);
      }

      // Fetch variables for this device
      const varsResponse = await nc.request(
        "opcua.variables",
        new TextEncoder().encode(JSON.stringify({ deviceId: device.id })),
        { timeout: 10_000 },
      );

      const variables = JSON.parse(
        new TextDecoder().decode(varsResponse.data),
      ) as OpcUaVariableInfo[];

      const nodes = new Map<string, { datatype: string; displayName: string }>();
      for (const v of variables) {
        if (v.deviceId === device.id) {
          nodes.set(v.variableId, {
            datatype: v.datatype,
            displayName: v.displayName ?? v.variableId,
          });
        }
      }

      if (nodes.size === 0) {
        console.warn(
          `  Warning: No nodes found for ${device.id} (${device.endpointUrl})`,
        );
      }

      deviceNodes.set(device.id, { endpointUrl: device.endpointUrl, nodes });
    }

    const totalNodes = [...deviceNodes.values()].reduce(
      (sum, d) => sum + d.nodes.size,
      0,
    );

    if (totalNodes === 0) {
      throw new Error(
        "No variables returned after browse. Make sure the OPC UA servers are reachable.",
      );
    }

    // Generate TypeScript
    const lines: string[] = [
      "// Auto-generated by @tentacle/plc codegen (OPC UA) — DO NOT EDIT",
      `// Generated at ${new Date().toISOString()}`,
      "",
    ];

    for (const [deviceId, deviceInfo] of deviceNodes) {
      const safeId = deviceId.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`export const ${safeId} = {`);
      lines.push(`  id: ${JSON.stringify(deviceId)},`);
      lines.push(`  endpointUrl: ${JSON.stringify(deviceInfo.endpointUrl)},`);
      lines.push(`  nodes: {`);

      // Sort nodes for deterministic output
      const sortedNodes = [...deviceInfo.nodes.entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      );

      for (const [nodeId, info] of sortedNodes) {
        lines.push(
          `    ${JSON.stringify(nodeId)}: { datatype: ${JSON.stringify(info.datatype)}, displayName: ${JSON.stringify(info.displayName)} },`,
        );
      }

      lines.push(`  },`);
      lines.push(`} as const;`);
      lines.push("");
    }

    // Ensure output directory exists
    try {
      await Deno.mkdir(outputDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const outputPath = `${outputDir}/opcua.ts`;
    await Deno.writeTextFile(outputPath, lines.join("\n"));

    console.log(
      `Generated ${outputPath} with ${deviceNodes.size} device(s) and ${totalNodes} node(s)`,
    );
  } finally {
    await nc.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Modbus Codegen
// ═══════════════════════════════════════════════════════════════════════════

export type ModbusDatatype =
  | "boolean"
  | "int16"
  | "uint16"
  | "int32"
  | "uint32"
  | "float32"
  | "float64";

export type ModbusByteOrder = "ABCD" | "BADC" | "CDAB" | "DCBA";
export type ModbusFunctionCode = "coil" | "discrete" | "holding" | "input";

export type ModbusTagSchema = {
  /** Unique tag ID — used as the key in the generated tags object */
  id: string;
  /** 0-based register/coil address */
  address: number;
  /** Modbus function code group */
  functionCode: ModbusFunctionCode;
  /** Protocol-level datatype for decoding register values */
  datatype: ModbusDatatype;
  /** Byte order override for this tag (defaults to device-level byteOrder) */
  byteOrder?: ModbusByteOrder;
  /** Whether writes are allowed to this tag */
  writable?: boolean;
  description?: string;
};

export type ModbusDeviceSchema = {
  /** Unique device ID */
  id: string;
  /** Hostname or IP address */
  host: string;
  /** TCP port (default: 502) */
  port?: number;
  /** Modbus unit/slave ID (default: 1) */
  unitId?: number;
  /** Device-level byte order default (default: "ABCD") */
  byteOrder?: ModbusByteOrder;
  /** Scan rate in ms (default: 1000) */
  scanRate?: number;
  tags: ModbusTagSchema[];
};

export type GenerateModbusTypesOptions = {
  /** Modbus devices to generate types for */
  devices: ModbusDeviceSchema[];
  /** Directory to write generated files to (default: "./generated") */
  outputDir?: string;
};

/** Map Modbus protocol datatypes to tentacle-plc datatypes */
function modbusToPLCDatatype(dt: ModbusDatatype): "number" | "boolean" {
  return dt === "boolean" ? "boolean" : "number";
}

/**
 * Generate typed Modbus device definitions from a static register map.
 * No live connection needed — the register map is defined directly in code.
 */
export async function generateModbusTypes(
  options: GenerateModbusTypesOptions,
): Promise<void> {
  const { devices, outputDir = "./generated" } = options;

  if (devices.length === 0) {
    console.log("No Modbus devices configured — skipping.");
    return;
  }

  const lines: string[] = [
    "// Auto-generated by @tentacle/plc codegen (Modbus) — DO NOT EDIT",
    `// Generated at ${new Date().toISOString()}`,
    "",
  ];

  let totalTags = 0;

  for (const device of devices) {
    const port = device.port ?? 502;
    const unitId = device.unitId ?? 1;
    const deviceByteOrder = device.byteOrder ?? "ABCD";
    const safeId = device.id.replace(/[^a-zA-Z0-9_]/g, "_");

    lines.push(`export const ${safeId} = {`);
    lines.push(`  id: ${JSON.stringify(device.id)},`);
    lines.push(`  host: ${JSON.stringify(device.host)},`);
    lines.push(`  port: ${port},`);
    lines.push(`  unitId: ${unitId},`);
    lines.push(`  byteOrder: ${JSON.stringify(deviceByteOrder)},`);
    lines.push(`  tags: {`);

    // Sort tags by address for deterministic output
    const sortedTags = [...device.tags].sort((a, b) => a.address - b.address);

    for (const tag of sortedTags) {
      const resolvedByteOrder = tag.byteOrder ?? deviceByteOrder;
      const plcDatatype = modbusToPLCDatatype(tag.datatype);
      lines.push(
        `    ${JSON.stringify(tag.id)}: { datatype: ${JSON.stringify(plcDatatype)}, address: ${tag.address}, functionCode: ${JSON.stringify(tag.functionCode)}, modbusDatatype: ${JSON.stringify(tag.datatype)}, byteOrder: ${JSON.stringify(resolvedByteOrder)} },`,
      );
      totalTags++;
    }

    lines.push(`  },`);
    lines.push(`} as const;`);
    lines.push("");
  }

  try {
    await Deno.mkdir(outputDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  const outputPath = `${outputDir}/modbus.ts`;
  await Deno.writeTextFile(outputPath, lines.join("\n"));

  console.log(
    `Generated ${outputPath} with ${devices.length} device(s) and ${totalTags} tag(s)`,
  );
}
