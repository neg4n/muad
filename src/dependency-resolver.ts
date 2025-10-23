import type { Element } from "./schema.ts";
import { failure, debug } from "./utils/logger.ts";

export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

export class DependencyResolver {
  private elements: Element[] = [];
  private elementMap = new Map<string, Element>();
  private adjacencyList = new Map<string, Set<string>>();
  private inDegree = new Map<string, number>();

  constructor(elements: Element[]) {
    this.elements = elements;
    this.buildElementMap();
    this.validateDependencies();
    this.buildGraph();
  }

  resolveExecutionOrder(): Element[] {
    debug(`Resolving execution order for ${this.elements.length} elements`);

    const result = this.topologicalSort();

    if (result.length !== this.elements.length) {
      const cycle = this.detectCycle();
      throw new DependencyError(`Circular dependency detected: ${cycle}`);
    }

    debug(`Resolved execution order: ${result.map((e) => e.name).join(" → ")}`);
    return result;
  }

  getIndependentElements(): Element[] {
    return this.elements.filter((element) => {
      const dependencies = element.metadata?.dependencies || [];
      return dependencies.length === 0;
    });
  }

  private buildElementMap() {
    this.elementMap.clear();

    for (const element of this.elements) {
      if (this.elementMap.has(element.name)) {
        throw new DependencyError(`Duplicate element name: "${element.name}"`);
      }
      this.elementMap.set(element.name, element);
    }
  }

  private validateDependencies() {
    for (const element of this.elements) {
      const dependencies = element.metadata?.dependencies || [];

      for (const depName of dependencies) {
        if (depName === element.name) {
          throw new DependencyError(
            `Element "${element.name}" cannot depend on itself`,
          );
        }

        if (!this.elementMap.has(depName)) {
          throw new DependencyError(
            `Element "${element.name}" depends on "${depName}" which does not exist`,
          );
        }
      }
    }
  }

  private buildGraph() {
    this.adjacencyList.clear();
    this.inDegree.clear();

    for (const element of this.elements) {
      this.adjacencyList.set(element.name, new Set());
      this.inDegree.set(element.name, 0);
    }

    for (const element of this.elements) {
      const dependencies = element.metadata?.dependencies || [];

      for (const depName of dependencies) {
        this.adjacencyList.get(depName)?.add(element.name);
        this.inDegree.set(
          element.name,
          (this.inDegree.get(element.name) || 0) + 1,
        );
      }
    }

    debug(`Built dependency graph with ${this.adjacencyList.size} nodes`);
  }

  private topologicalSort(): Element[] {
    const result: Element[] = [];
    const queue: string[] = [];

    for (const [elementName, degree] of this.inDegree.entries()) {
      if (degree === 0) {
        queue.push(elementName);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const element = this.elementMap.get(current)!;
      result.push(element);

      const neighbors = this.adjacencyList.get(current) || new Set();
      for (const neighbor of neighbors) {
        const newDegree = (this.inDegree.get(neighbor) || 0) - 1;
        this.inDegree.set(neighbor, newDegree);

        if (newDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return result;
  }

  private detectCycle(): string {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): string | null => {
      if (recursionStack.has(node)) {
        const cycleStartIndex = path.indexOf(node);
        return path.slice(cycleStartIndex).concat([node]).join(" → ");
      }

      if (visited.has(node)) {
        return null;
      }

      visited.add(node);
      recursionStack.add(node);
      path.push(node);

      const dependencies =
        this.elementMap.get(node)?.metadata?.dependencies || [];
      for (const dep of dependencies) {
        const cycleFound = dfs(dep);
        if (cycleFound) {
          return cycleFound;
        }
      }

      recursionStack.delete(node);
      path.pop();
      return null;
    };

    for (const elementName of this.elementMap.keys()) {
      if (!visited.has(elementName)) {
        const cycle = dfs(elementName);
        if (cycle) {
          return cycle;
        }
      }
    }

    return "Unknown cycle detected";
  }
}
