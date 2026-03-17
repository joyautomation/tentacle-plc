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
  cipType?: string;
  quality: string;
  origin: string;
  lastUpdated: number;
};

/** UDT member from browse response */
type UdtMemberExport = {
  name: string;
  datatype: string;
  udtType?: string;
  isArray: boolean;
};

/** UDT template from browse response */
type UdtExport = {
  name: string;
  members: UdtMemberExport[];
};

/** Browse result with UDT info */
type BrowseResult = {
  variables: VariableInfo[];
  udts: Record<string, UdtExport>;
  structTags: Record<string, string>;
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

/** Map EIP PLC datatypes to TypeScript types */
function eipToTsType(datatype: string): string {
  switch (datatype) {
    case "BOOL":
      return "boolean";
    case "SINT": case "INT": case "DINT": case "LINT":
    case "USINT": case "UINT": case "UDINT": case "ULINT":
    case "REAL": case "LREAL":
      return "number";
    case "STRING":
      return "string";
    case "STRUCT":
      // Struct member whose UDT type couldn't be resolved (e.g. Rockwell built-in
      // TIMER, COUNTER, CONTROL, etc.) — use Record<string, unknown>
      return "Record<string, unknown>";
    default:
      // NATS datatypes from browse
      if (datatype === "boolean") return "boolean";
      if (datatype === "number") return "number";
      if (datatype === "string") return "string";
      return "Record<string, unknown>";
  }
}

/** Map a browse member datatype to PLC variable datatype */
function eipMemberToPlcDatatype(datatype: string): "number" | "boolean" | "string" {
  switch (datatype) {
    case "BOOL":
    case "boolean":
      return "boolean";
    case "STRING":
    case "string":
      return "string";
    case "STRUCT":
      return "string";
    default:
      return "number";
  }
}

/** Generate a TypeScript interface for a UDT, recursively resolving nested UDTs */
function generateUdtInterface(
  udt: UdtExport,
  allUdts: Record<string, UdtExport>,
  indent: string = "",
): string[] {
  const safeName = udt.name.replace(/[^a-zA-Z0-9_]/g, "_");
  const lines: string[] = [];
  lines.push(`${indent}export type ${safeName} = {`);
  for (const member of udt.members) {
    if (member.udtType && allUdts[member.udtType]) {
      // Nested UDT — reference the generated type
      const safeType = member.udtType.replace(/[^a-zA-Z0-9_]/g, "_");
      lines.push(`${indent}  ${member.name}: ${safeType};`);
    } else {
      lines.push(`${indent}  ${member.name}: ${eipToTsType(member.datatype)};`);
    }
  }
  lines.push(`${indent}};`);
  return lines;
}

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

    type DeviceBrowseData = {
      host: string;
      port: number;
      tags: Map<string, { datatype: string; cipType: string }>;
      udts: Record<string, UdtExport>;
      structTags: Record<string, string>;
    };
    const deviceData = new Map<string, DeviceBrowseData>();

    for (const device of devices) {
      const port = device.port ?? 44818;

      // Generate browseId client-side so we can subscribe before sending
      // the request — avoids a race where the scanner publishes the result
      // before our subscription is active.
      const browseId = crypto.randomUUID();

      const browsePayload = JSON.stringify({
        deviceId: device.id,
        host: device.host,
        port,
        browseId,
      });

      console.log(`  Browsing ${device.id} (${device.host}:${port})...`);

      // Subscribe to progress + result topics BEFORE sending the request
      const progressSub = nc.subscribe(`ethernetip.browse.progress.${browseId}`);
      const resultSub = nc.subscribe(`ethernetip.browse.result.${browseId}`);

      // Start browse (async — returns browseId immediately)
      await nc.request(
        "ethernetip.browse",
        new TextEncoder().encode(browsePayload),
        { timeout: 10_000 },
      );

      let variables: VariableInfo[] = [];
      let udts: Record<string, UdtExport> = {};
      let structTags: Record<string, string> = {};
      let completed = false;
      let failed = false;
      let failMessage = "";

      const timeoutId = setTimeout(() => {
        if (!completed && !failed) {
          failed = true;
          failMessage = `Browse of ${device.id} timed out after ${timeout / 1000}s`;
          progressSub.unsubscribe();
          resultSub.unsubscribe();
        }
      }, timeout);

      // Print progress updates in background
      const progressHandler = (async () => {
        for await (const msg of progressSub) {
          try {
            const progress = JSON.parse(msg.string()) as BrowseProgressMessage;
            if (progress.phase === "failed") {
              failed = true;
              failMessage = progress.message || "Browse failed";
              clearTimeout(timeoutId);
              await resultSub.unsubscribe();
              break;
            }
            if (progress.message) {
              console.log(`    [${progress.phase}] ${progress.message}`);
            }
          } catch { /* ignore */ }
        }
      })();

      // Wait for result
      for await (const msg of resultSub) {
        const raw = JSON.parse(msg.string());
        const result = raw as BrowseResult;
        variables = result.variables ?? [];
        udts = result.udts ?? {};
        structTags = result.structTags ?? {};
        completed = true;
        clearTimeout(timeoutId);
        await progressSub.unsubscribe();
        await resultSub.unsubscribe();
        break;
      }

      await progressHandler.catch(() => {});

      if (failed) {
        throw new Error(failMessage);
      }

      const tags = new Map<string, { datatype: string; cipType: string }>();
      for (const v of variables) {
        if (v.deviceId === device.id) {
          tags.set(v.variableId, { datatype: v.datatype, cipType: v.cipType ?? "" });
        }
      }

      if (tags.size === 0) {
        console.warn(
          `  Warning: No tags found for ${device.id} (${device.host})`,
        );
      }

      const udtCount = Object.keys(udts).length;
      const structCount = Object.keys(structTags).length;
      if (udtCount > 0) {
        console.log(`  Found ${udtCount} UDT type(s), ${structCount} struct tag(s)`);
      }

      deviceData.set(device.id, { host: device.host, port, tags, udts, structTags });
    }

    const totalTags = [...deviceData.values()].reduce(
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

    // Collect all unique UDTs across devices and generate type definitions
    const allUdts: Record<string, UdtExport> = {};
    for (const data of deviceData.values()) {
      for (const [name, udt] of Object.entries(data.udts)) {
        allUdts[name] = udt;
      }
    }

    // Build set of readable members per UDT type by checking which members
    // have actual readable tags in the browse result. This filters out array
    // members and any other internal/system members the PLC exposes in metadata
    // but doesn't allow reading.
    const readableMembersByUdt = new Map<string, Set<string>>();
    for (const data of deviceData.values()) {
      const allTags = data.tags;
      for (const [structTag, udtName] of Object.entries(data.structTags)) {
        if (!readableMembersByUdt.has(udtName)) {
          readableMembersByUdt.set(udtName, new Set());
        }
        const readable = readableMembersByUdt.get(udtName)!;
        const udt = allUdts[udtName];
        if (!udt) continue;
        for (const member of udt.members) {
          const memberTag = `${structTag}.${member.name}`;
          if (allTags.has(memberTag)) {
            // Direct atomic member is readable
            readable.add(member.name);
          } else if (member.udtType && allUdts[member.udtType]) {
            // Nested UDT — check if ANY of its sub-members are readable
            const nestedUdt = allUdts[member.udtType];
            const hasReadableChild = nestedUdt.members.some(
              (sub) => allTags.has(`${memberTag}.${sub.name}`),
            );
            if (hasReadableChild) readable.add(member.name);
          }
        }
      }
    }

    // Filter UDT members to only readable ones
    for (const [udtName, udt] of Object.entries(allUdts)) {
      const readable = readableMembersByUdt.get(udtName);
      if (readable && readable.size > 0) {
        udt.members = udt.members.filter((m) => readable.has(m.name));
      }
      // Also filter nested UDTs recursively (they may have been used transitively)
    }

    if (Object.keys(allUdts).length > 0) {
      lines.push("// ═══════════════════════════════════════════════════════════");
      lines.push("// UDT Type Definitions");
      lines.push("// ═══════════════════════════════════════════════════════════");
      lines.push("");

      // Sort UDTs for deterministic output
      const sortedUdtNames = Object.keys(allUdts).sort();
      for (const name of sortedUdtNames) {
        const udt = allUdts[name];
        const udtLines = generateUdtInterface(udt, allUdts);
        lines.push(...udtLines);
        lines.push("");
      }
    }

    lines.push("// ═══════════════════════════════════════════════════════════");
    lines.push("// Device Definitions");
    lines.push("// ═══════════════════════════════════════════════════════════");
    lines.push("");

    for (const [deviceId, deviceInfo] of deviceData) {
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

      for (const [tagName, tagInfo] of sortedTags) {
        const parts = [`datatype: ${JSON.stringify(tagInfo.datatype)}`];
        if (tagInfo.cipType) {
          parts.push(`cipType: ${JSON.stringify(tagInfo.cipType)}`);
        }
        lines.push(
          `    ${JSON.stringify(tagName)}: { ${parts.join(", ")} },`,
        );
      }

      lines.push(`  },`);

      // Add structTags mapping if there are any
      if (Object.keys(deviceInfo.structTags).length > 0) {
        lines.push(`  structTags: {`);
        const sortedStructTags = Object.entries(deviceInfo.structTags).sort((a, b) =>
          a[0].localeCompare(b[0]),
        );
        for (const [tagName, udtName] of sortedStructTags) {
          lines.push(
            `    ${JSON.stringify(tagName)}: ${JSON.stringify(udtName)},`,
          );
        }
        lines.push(`  },`);
      }

      lines.push(`} as const;`);
      lines.push("");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Generate UDT template definitions (for Sparkplug B)
    // ═══════════════════════════════════════════════════════════════════════

    if (Object.keys(allUdts).length > 0) {
      lines.push("// ═══════════════════════════════════════════════════════════");
      lines.push("// UDT Template Definitions (for Sparkplug B)");
      lines.push("// ═══════════════════════════════════════════════════════════");
      lines.push("");

      const sortedUdtNames = Object.keys(allUdts).sort();
      for (const name of sortedUdtNames) {
        const udt = allUdts[name];
        const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
        lines.push(`export const ${safeName}Template = {`);
        lines.push(`  name: ${JSON.stringify(name)},`);
        lines.push(`  version: "1.0",`);
        lines.push(`  members: [`);
        for (const member of udt.members) {
          const memberDatatype = member.udtType && allUdts[member.udtType]
            ? "string"
            : eipMemberToPlcDatatype(member.datatype);
          const parts = [
            `name: ${JSON.stringify(member.name)}`,
            `datatype: ${JSON.stringify(memberDatatype)}`,
          ];
          if (member.udtType && allUdts[member.udtType]) {
            parts.push(`templateRef: ${JSON.stringify(member.udtType)}`);
          }
          lines.push(`    { ${parts.join(", ")} },`);
        }
        lines.push(`  ],`);
        lines.push(`} as const;`);
        lines.push("");
      }

      // Generate udtTemplates map: UDT name → template constant
      lines.push("/** Map of UDT type names to their template definitions (pass to eipAll/eipUdtVars) */");
      lines.push("export const udtTemplates = {");
      for (const name of sortedUdtNames) {
        const safeName = name.replace(/[^a-zA-Z0-9_]/g, "_");
        lines.push(`  ${JSON.stringify(name)}: ${safeName}Template,`);
      }
      lines.push("} as const;");
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
      `Generated ${outputPath} with ${deviceData.size} device(s), ${totalTags} tag(s), and ${Object.keys(allUdts).length} UDT type(s)`,
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
