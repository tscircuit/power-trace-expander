import type { SimpleRouteJson, SimplifiedPcbTrace } from "@tscircuit/core";

const definedNames = (names: Array<string | null | undefined>) =>
  names.filter((name): name is string => Boolean(name));

/**
 * Canonicalizes the aliases used for one electrical net in SimpleRouteJson.
 * Imported subcircuits often use a different source-trace name at their
 * boundary, but both routes still share a pcb_port_id. Pads and vias also
 * carry the complete connectedTo alias set, so unioning these identifiers
 * reproduces the connectivity semantics used by @tscircuit/checks.
 */
export class ConnectionNameResolver {
  private readonly parent = new Map<string, string>();

  constructor(
    simpleRouteJson: SimpleRouteJson,
    traces: SimplifiedPcbTrace[] = simpleRouteJson.traces ?? [],
  ) {
    for (const connection of simpleRouteJson.connections) {
      this.unionAll(
        definedNames([
          connection.name,
          connection.source_trace_id,
          connection.rootConnectionName,
          ...(connection.mergedConnectionNames ?? []),
          ...connection.pointsToConnect.flatMap((point) => [
            point.pointId,
            point.pcb_port_id,
          ]),
        ]),
      );
    }
    for (const trace of traces) {
      this.unionAll(
        definedNames([
          trace.pcb_trace_id,
          trace.connection_name,
          trace.source_trace_id,
          trace.rootConnectionName,
          ...(trace.mergedConnectionNames ?? []),
          ...(trace.connectsTo ?? []),
        ]),
      );
    }
    for (const obstacle of simpleRouteJson.obstacles) {
      this.unionAll(obstacle.connectedTo);
    }
  }

  canonicalize(names: string[]) {
    return [...new Set(names.map((name) => this.find(name)))];
  }

  private unionAll(names: string[]) {
    const first = names[0];
    if (!first) return;
    this.add(first);
    for (let index = 1; index < names.length; index++) {
      this.union(first, names[index]!);
    }
  }

  private add(name: string) {
    if (!this.parent.has(name)) this.parent.set(name, name);
  }

  private find(name: string): string {
    this.add(name);
    const parent = this.parent.get(name)!;
    if (parent === name) return name;
    const root = this.find(parent);
    this.parent.set(name, root);
    return root;
  }

  private union(a: string, b: string) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootB, rootA);
  }
}
