/**
 * Lightweight pure-TypeScript MIB parser for SNMP OID-to-name resolution.
 *
 * Parses standard SMIv1/SMIv2 MIB files to extract OBJECT IDENTIFIER and
 * OBJECT-TYPE definitions. Builds a resolution tree that maps numeric OIDs
 * to human-readable names.
 *
 * Not a full ASN.1 compiler — handles the common patterns found in RFC and
 * vendor MIBs using regex-based extraction.
 */

/** Parsed MIB node */
export type MibNode = {
  name: string;
  oid: string;
  parent?: string;
  index?: number;
  syntax?: string;
  maxAccess?: string;
  description?: string;
};

/** OID-to-name resolution tree */
export type MibTree = {
  byOid: Map<string, MibNode>;
  byName: Map<string, string>;
};

/** Well-known OID roots that don't need to be defined in any MIB file */
const WELL_KNOWN_ROOTS: Record<string, string> = {
  iso: ".1",
  org: ".1.3",
  dod: ".1.3.6",
  internet: ".1.3.6.1",
  directory: ".1.3.6.1.1",
  mgmt: ".1.3.6.1.2",
  "mib-2": ".1.3.6.1.2.1",
  system: ".1.3.6.1.2.1.1",
  interfaces: ".1.3.6.1.2.1.2",
  at: ".1.3.6.1.2.1.3",
  ip: ".1.3.6.1.2.1.4",
  icmp: ".1.3.6.1.2.1.5",
  tcp: ".1.3.6.1.2.1.6",
  udp: ".1.3.6.1.2.1.7",
  egp: ".1.3.6.1.2.1.8",
  transmission: ".1.3.6.1.2.1.10",
  snmp: ".1.3.6.1.2.1.11",
  experimental: ".1.3.6.1.3",
  private: ".1.3.6.1.4",
  enterprises: ".1.3.6.1.4.1",
  security: ".1.3.6.1.5",
  snmpV2: ".1.3.6.1.6",
  snmpDomains: ".1.3.6.1.6.1",
  snmpProxys: ".1.3.6.1.6.2",
  snmpModules: ".1.3.6.1.6.3",
};

type RawDefinition = {
  name: string;
  parent: string;
  index: number;
  syntax?: string;
  maxAccess?: string;
};

/** Strip comments and collapse multi-line definitions for easier parsing */
function preprocess(text: string): string {
  // Remove -- comments
  return text.replace(/--.*$/gm, "");
}

/**
 * Parse a single MIB file and extract all OID definitions.
 * Returns raw definitions that still need parent resolution.
 */
function parseMibText(text: string): RawDefinition[] {
  const clean = preprocess(text);
  const definitions: RawDefinition[] = [];

  // Pattern 1: OBJECT IDENTIFIER ::= { parent index }
  // e.g., netSnmpObjects OBJECT IDENTIFIER ::= {netSnmp 1}
  const oidPattern =
    /(\w+)\s+OBJECT\s+IDENTIFIER\s*::=\s*\{\s*(\w+)\s+(\d+)\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = oidPattern.exec(clean)) !== null) {
    definitions.push({
      name: match[1],
      parent: match[2],
      index: parseInt(match[3], 10),
    });
  }

  // Pattern 2: MODULE-IDENTITY ::= { parent index }
  // e.g., netSnmp MODULE-IDENTITY ... ::= { enterprises 8072 }
  const moduleIdentityPattern =
    /(\w+)\s+MODULE-IDENTITY[\s\S]*?::=\s*\{\s*(\w+)\s+(\d+)\s*\}/g;
  while ((match = moduleIdentityPattern.exec(clean)) !== null) {
    // Don't add if already captured by OBJECT IDENTIFIER pattern
    if (!definitions.some((d) => d.name === match![1])) {
      definitions.push({
        name: match[1],
        parent: match[2],
        index: parseInt(match[3], 10),
      });
    }
  }

  // Pattern 3: OBJECT-TYPE with SYNTAX and ::= { parent index }
  // e.g., sysDescr OBJECT-TYPE SYNTAX DisplayString ... ::= { system 1 }
  const objectTypePattern =
    /(\w+)\s+OBJECT-TYPE\s+([\s\S]*?)::=\s*\{\s*(\w+)\s+(\d+)\s*\}/g;
  while ((match = objectTypePattern.exec(clean)) !== null) {
    const name = match[1];
    const body = match[2];
    if (definitions.some((d) => d.name === name)) continue;

    let syntax: string | undefined;
    const syntaxMatch = body.match(/SYNTAX\s+([\w().\-\s]+?)(?:\s+(?:MAX-ACCESS|ACCESS|STATUS|DESCRIPTION|INDEX|DEFVAL|AUGMENTS|REFERENCE)\s)/);
    if (syntaxMatch) {
      syntax = syntaxMatch[1].trim();
    }

    let maxAccess: string | undefined;
    const accessMatch = body.match(/(?:MAX-ACCESS|ACCESS)\s+([\w-]+)/);
    if (accessMatch) {
      maxAccess = accessMatch[1];
    }

    definitions.push({
      name,
      parent: match[3],
      index: parseInt(match[4], 10),
      syntax,
      maxAccess,
    });
  }

  // Pattern 4: OBJECT IDENTITY ::= { parent index }
  const objectIdentityPattern =
    /(\w+)\s+OBJECT-IDENTITY[\s\S]*?::=\s*\{\s*(\w+)\s+(\d+)\s*\}/g;
  while ((match = objectIdentityPattern.exec(clean)) !== null) {
    if (!definitions.some((d) => d.name === match![1])) {
      definitions.push({
        name: match[1],
        parent: match[2],
        index: parseInt(match[3], 10),
      });
    }
  }

  // Pattern 5: NOTIFICATION-TYPE ::= { parent index }
  const notificationPattern =
    /(\w+)\s+NOTIFICATION-TYPE[\s\S]*?::=\s*\{\s*(\w+)\s+(\d+)\s*\}/g;
  while ((match = notificationPattern.exec(clean)) !== null) {
    if (!definitions.some((d) => d.name === match![1])) {
      definitions.push({
        name: match[1],
        parent: match[2],
        index: parseInt(match[3], 10),
      });
    }
  }

  return definitions;
}

/**
 * Resolve all raw definitions into full numeric OIDs.
 * Uses well-known roots as starting points, then iteratively resolves
 * children until all reachable definitions have numeric OIDs.
 */
function resolveOids(allDefinitions: RawDefinition[]): MibTree {
  const byOid = new Map<string, MibNode>();
  const byName = new Map<string, string>();

  // Seed with well-known roots
  for (const [name, oid] of Object.entries(WELL_KNOWN_ROOTS)) {
    byName.set(name, oid);
    byOid.set(oid, { name, oid });
  }

  // Build a lookup from parent name to children
  const childrenOf = new Map<string, RawDefinition[]>();
  for (const def of allDefinitions) {
    const list = childrenOf.get(def.parent) || [];
    list.push(def);
    childrenOf.set(def.parent, list);
  }

  // Iteratively resolve: if parent is resolved, resolve children
  const resolved = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const def of allDefinitions) {
      if (resolved.has(def.name)) continue;
      const parentOid = byName.get(def.parent);
      if (parentOid === undefined) continue;

      const oid = `${parentOid}.${def.index}`;
      byName.set(def.name, oid);
      byOid.set(oid, {
        name: def.name,
        oid,
        parent: def.parent,
        index: def.index,
        syntax: def.syntax,
        maxAccess: def.maxAccess,
      });
      resolved.add(def.name);
      changed = true;
    }
  }

  return { byOid, byName };
}

/**
 * Load and parse MIB files from disk paths.
 * Handles cross-MIB references by loading all files first, then resolving.
 */
export async function loadMibs(paths: string[]): Promise<MibTree> {
  const allDefinitions: RawDefinition[] = [];

  for (const path of paths) {
    try {
      const text = await Deno.readTextFile(path);
      const defs = parseMibText(text);
      allDefinitions.push(...defs);
    } catch (err) {
      console.warn(`Warning: could not load MIB file ${path}: ${err}`);
    }
  }

  return resolveOids(allDefinitions);
}

/**
 * Load all MIB files from a directory.
 * Picks up .mib, .txt, .my files, and extensionless files (standard IETF MIBs
 * from snmp-mibs-downloader have no extension).
 */
export async function loadMibDir(dirPath: string): Promise<MibTree> {
  const paths: string[] = [];
  try {
    for await (const entry of Deno.readDir(dirPath)) {
      if (!entry.isFile) continue;
      // Accept known MIB extensions or extensionless files (IETF standard)
      const name = entry.name;
      if (
        name.endsWith(".mib") ||
        name.endsWith(".txt") ||
        name.endsWith(".my") ||
        !name.includes(".")
      ) {
        paths.push(`${dirPath}/${name}`);
      }
    }
  } catch (err) {
    console.warn(`Warning: could not read MIB directory ${dirPath}: ${err}`);
  }
  return loadMibs(paths);
}

/**
 * Resolve a numeric OID to a human-readable name.
 *
 * Strategy:
 * 1. Exact match → return name (e.g., ".1.3.6.1.2.1.1.1" → "sysDescr")
 * 2. Longest prefix match → name + remaining suffix
 *    (e.g., ".1.3.6.1.2.1.2.2.1.2.1" → "ifDescr.1")
 * 3. No match → sanitized OID string (e.g., "oid_1_3_6_1_2_1_1_1_0")
 */
export function resolveOidName(tree: MibTree, oid: string): string {
  // Normalize OID to start with dot
  const normalizedOid = oid.startsWith(".") ? oid : `.${oid}`;

  // Exact match
  const exact = tree.byOid.get(normalizedOid);
  if (exact) return exact.name;

  // Longest prefix match
  const parts = normalizedOid.split(".");
  for (let i = parts.length - 1; i >= 2; i--) {
    const prefix = parts.slice(0, i).join(".");
    const node = tree.byOid.get(prefix);
    if (node) {
      const suffix = parts.slice(i).join(".");
      return `${node.name}.${suffix}`;
    }
  }

  // Fallback: sanitized OID
  return `oid_${normalizedOid.replace(/^\./, "").replace(/\./g, "_")}`;
}

/**
 * Sanitize a resolved name for use as a TypeScript/JavaScript object key.
 * Replaces dots and hyphens with underscores.
 */
export function sanitizeOidKey(name: string): string {
  return name.replace(/[.\-]/g, "_");
}

/**
 * Create an empty MIB tree (useful when no MIBs are loaded).
 */
export function emptyMibTree(): MibTree {
  return resolveOids([]);
}
