import type { JSONSchemaType } from "ajv";
import trash from "trash";
import type { SafeCleanupParams, SafeCleanupYamlParams } from "../schema.ts";
import type { PipelineContext } from "../context.ts";
import { failure, success, debug } from "../utils/logger.ts";

export const name = "safe-cleanup";

export const schema: JSONSchemaType<SafeCleanupYamlParams> = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
    },
    quiet: { type: "boolean", nullable: true },
  },
  required: ["paths"],
  additionalProperties: false,
};

async function checkPathExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

export const execute = async (
  params: SafeCleanupParams,
  context: PipelineContext,
): Promise<void> => {
  const processedPaths = params.paths.map((path) =>
    context.processTemplate(path),
  );

  if (!params.quiet) {
    debug(`Safe cleanup requested for ${processedPaths.length} path(s)`);
  }

  const pathsToClean: string[] = [];
  const nonExistentPaths: string[] = [];

  for (const path of processedPaths) {
    if (!params.quiet) {
      debug(`Checking path: ${path}`);
    }

    const exists = await checkPathExists(path);
    if (exists) {
      pathsToClean.push(path);
      if (!params.quiet) {
        debug(`Path exists and will be cleaned: ${path}`);
      }
    } else {
      nonExistentPaths.push(path);
      if (!params.quiet) {
        debug(`Path does not exist, skipping: ${path}`);
      }
    }
  }

  if (nonExistentPaths.length > 0 && !params.quiet) {
    debug(`Skipped ${nonExistentPaths.length} non-existent paths`);
  }

  if (pathsToClean.length === 0) {
    if (!params.quiet) {
      debug("No paths to clean up");
    }
    return;
  }

  try {
    if (!params.quiet) {
      debug(`Moving ${pathsToClean.length} path(s) to trash...`);
    }

    await trash(pathsToClean);

    if (!params.quiet) {
      success(
        `Successfully moved ${pathsToClean.length} path(s) to system trash`,
      );
      for (const path of pathsToClean) {
        debug(`Cleaned: ${path}`);
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Safe cleanup failed: ${errorMessage}`);
  }
};
