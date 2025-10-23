#!/usr/bin/env bun

import { join } from "node:path";
import { stat } from "node:fs/promises";

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Ajv } from "ajv";
import type { ArgumentsCamelCase } from "yargs";

import {
  createElementSchema,
  type ToolModule,
  type Element,
} from "./schema.ts";
import { PipelineContext } from "./context.ts";
import { DependencyResolver, DependencyError } from "./dependency-resolver.ts";
import { normalizeKeys } from "./utils/string.ts";
import { runPromisePool } from "./utils/promise-pool.ts";
import { info, failure, success, debug } from "./utils/logger.ts";

await yargs(hideBin(Bun.argv))
  .command<{ element?: string[] }>(
    "install",
    "Install all the elements found relative to the cwd",
    (cmdYargs) =>
      cmdYargs.option("element", {
        type: "string",
        array: true,
        describe:
          "Run only the specified element(s). Can be passed multiple times.",
      }),
    async (argv: ArgumentsCamelCase<{ element?: string[] }>) => {
      const tools = await importTools();
      const storageDirectory = await findStorageDirectory(process.cwd());
      let elements = (await importElements(tools)) as Element[];
      const originalCount = elements.length;
      const elementFilters = argv.element ?? [];

      if (elementFilters.length > 0) {
        const elementLookup = new Map(elements.map((el) => [el.name, el]));
        const missing = elementFilters.filter(
          (name) => !elementLookup.has(name),
        );

        if (missing.length > 0) {
          failure(
            `Requested element(s) not found: ${missing
              .map((name) => `"${name}"`)
              .join(", ")}`,
          );
          process.exit(1);
        }

        const required = new Set<string>();
        const stack = [...elementFilters];

        while (stack.length > 0) {
          const current = stack.pop()!;
          if (required.has(current)) continue;

          const element = elementLookup.get(current);
          if (!element) {
            failure(
              `Element "${current}" is referenced but not defined in the available elements.`,
            );
            process.exit(1);
          }

          required.add(current);
          const dependencies = element.metadata?.dependencies || [];
          for (const dep of dependencies) {
            if (!required.has(dep)) {
              if (!elementLookup.has(dep)) {
                failure(
                  `Element "${current}" depends on "${dep}" which was not found.`,
                );
                process.exit(1);
              }
              stack.push(dep);
            }
          }
        }

        elements = elements.filter((element) => required.has(element.name));

        const extraDependencies = [...required].filter(
          (name) => !elementFilters.includes(name),
        );

        info(
          `Element filter applied: ${elementFilters.join(", ")}${
            extraDependencies.length > 0
              ? ` (including dependencies: ${extraDependencies.join(", ")})`
              : ""
          }`,
        );
      }

      info(
        `Installing ${elements.length} element(s)${
          elementFilters.length > 0
            ? ` (filtered from ${originalCount})`
            : ""
        }...`,
      );

      try {
        const resolver = new DependencyResolver(elements as Element[]);
        const orderedElements = resolver.resolveExecutionOrder();
        const independentElements = resolver.getIndependentElements();
        const independentSet = new Set(
          independentElements.map((element) => element.name),
        );

        debug(`Execution order: ${orderedElements.map(e => e.name).join(' → ')}`);

        const maxParallelIndependent = 4;

        if (independentElements.length > 0) {
          debug(
            `Executing independent elements in parallel: ${independentElements
              .map((element) => element.name)
              .join(", ")}`,
          );
          await runPromisePool(
            independentElements.map((element) => () =>
              executeElement(element, tools, storageDirectory)
            ),
            maxParallelIndependent,
          );
        }

        for (const element of orderedElements) {
          if (independentSet.has(element.name)) {
            continue;
          }
          await executeElement(element, tools, storageDirectory);
        }

        success("All elements processed successfully");
      } catch (error) {
        if (error instanceof DependencyError) {
          failure("Dependency resolution failed:", error);
          process.exit(1);
        }
        throw error;
      }
    },
  )
  .strictCommands()
  .demandCommand(0)
  .parseAsync();

async function importTools(): Promise<ToolModule[]> {
  const toolsGlob = new Bun.Glob("**/tools/*.ts");
  debug(import.meta.dir);
  const foundToolFiles = await Array.fromAsync(
    toolsGlob.scan({ cwd: import.meta.dir }),
  );

  if (foundToolFiles.length === 0) {
    failure("No tool files found in src/tools/ directory.");
    process.exit(1);
  }

  const tools: ToolModule[] = [];

  try {
    for (const file of foundToolFiles) {
      const toolModule = await import(`./${file}`);

      if (!toolModule.name || !toolModule.schema || !toolModule.execute) {
        failure(
          `Invalid tool module: ${file}. Must export name, schema, and execute.`,
        );
        process.exit(1);
      }

      tools.push({
        name: toolModule.name,
        schema: toolModule.schema,
        execute: toolModule.execute,
      });
    }
  } catch (error) {
    failure("Error importing tool files:", error as Error);
    process.exit(1);
  }

  debug(`Loaded ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
  return tools;
}

type StorageDirectoryCandidate = "configs" | "dotfiles";

function hasErrnoCode(error: unknown): error is { code?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      throw new Error(`Path "${path}" exists but is not a directory.`);
    }
    return true;
  } catch (error) {
    if (hasErrnoCode(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function findStorageDirectory(cwd: string): Promise<string> {
  const candidates: StorageDirectoryCandidate[] = ["configs", "dotfiles"];
  const matches: string[] = [];

  for (const candidate of candidates) {
    const fullPath = join(cwd, candidate);
    try {
      if (await isDirectory(fullPath)) {
        matches.push(fullPath);
      }
    } catch (error) {
      failure(
        `Failed to inspect storage directory candidate "${candidate}".`,
        error as Error,
      );
      process.exit(1);
    }
  }

  if (matches.length > 1) {
    failure(
      `Both "configs" and "dotfiles" directories exist (${matches
        .map((match) => `"${match}"`)
        .join(", ")}). Only one storage directory may be present.`,
    );
    process.exit(1);
  }

  if (matches.length === 0) {
    failure(
      'No storage directory found. Expected either a "configs" or "dotfiles" directory relative to the current working directory.',
    );
    process.exit(1);
  }

  const storageDirectory = matches[0];
  debug(`Storage directory resolved: ${storageDirectory}`);
  return storageDirectory;
}

async function importElements(tools: ToolModule[]) {
  const cwd = process.cwd();

  const elementsGlob = new Bun.Glob("**/elements/*.{yml,yaml}");
  const foundYamlFiles = await Array.fromAsync(elementsGlob.scan({ cwd }));

  if (foundYamlFiles.length === 0) {
    failure(
      "The found elements directory does not exists or does not contain any {yml,yaml} files.",
    );
    process.exit(1);
  }

  let parsedYamlFiles: Record<string, unknown>[] = [];

  try {
    parsedYamlFiles = await Promise.all(
      foundYamlFiles.map(async (file) => {
        try {
          const content = await Bun.file(file).text();
          return (globalThis as any).Bun.YAML.parse(
            content,
          ) as (typeof parsedYamlFiles)[number];
        } catch (error) {
          // Include file context in the error message
          failure(`Error parsing YAML file: ${file}`, error);
          process.exit(1);
        }
      }),
    );
  } catch (error) {
    failure("Error parsing elements yaml files:", error);
    process.exit(1);
  }

  const ajv = new Ajv({ discriminator: true });
  const elementSchema = createElementSchema(tools);
  const validate = ajv.compile(elementSchema);

  return await Promise.all(
    parsedYamlFiles.map(async (file, index) => {
      const isValid = validate(file);
      if (!isValid) {
        // Pass the errors array and include file name
        failure(`Invalid element file: ${foundYamlFiles[index]}`, validate.errors);
        process.exit(1);
      }
      return normalizeKeys(file);
    }),
  );
}

async function executeElement(
  element: Element,
  tools: ToolModule[],
  storageDirectory: string,
): Promise<void> {
  const versionLabel = element.metadata?.version
    ? ` (v${element.metadata.version})`
    : "";
  info(`Processing element: ${element.name}${versionLabel}`);

  const context = new PipelineContext(element as Record<string, unknown>);

  context.set("ctx.storageDirectory", storageDirectory);

  const toolMap = new Map<string, ToolModule>();
  for (const tool of tools) {
    toolMap.set(tool.name, tool);
  }

  for (let i = 0; i < element.pipeline.length; i++) {
    const pipelineItem = element.pipeline[i];
    if (!pipelineItem) continue;

    const tool = toolMap.get(pipelineItem.tool);

    if (!tool) {
      throw new Error(`Unknown tool: ${pipelineItem.tool}`);
    }

    debug(`Step ${i + 1}: ${pipelineItem.tool}`);

    try {
      const processedParams = context.processObjectTemplate(pipelineItem.with);

      await tool.execute(processedParams, context);

      debug(`Step ${i + 1} completed successfully`);
    } catch (error) {
      failure(`Step ${i + 1} failed:`, error as Error);
      throw new Error(
        `Pipeline failed at step ${i + 1} (${pipelineItem.tool}): ${error}`,
      );
    }
  }

  debug(`Element "${element.name}" completed successfully`);
  debug(`Context variables created: [${context.getAssignedKeys().join(", ")}]`);
}
