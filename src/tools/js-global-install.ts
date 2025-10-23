import type { JSONSchemaType } from "ajv";
import semver from "semver";
import type {
  JsGlobalInstallParams,
  JsGlobalInstallYamlParams,
} from "../schema.ts";
import type { PipelineContext } from "../context.ts";
import { enforceSafeEnv } from "../utils/env.ts";
import { failure, success, debug, warn } from "../utils/logger.ts";

export const name = "js-global-install";

export const schema: JSONSchemaType<JsGlobalInstallYamlParams> = {
  type: "object",
  properties: {
    "package-manager": {
      type: "string",
      enum: ["bun", "npm", "yarn", "pnpm"],
      nullable: true,
    },
    handle: { type: "string" },
    registry: { type: "string", nullable: true },
  },
  required: ["handle"],
  additionalProperties: false,
};

interface ParsedPackage {
  name: string;
  version?: string;
}

function parsePackageHandle(handle: string): ParsedPackage {
  const atIndex = handle.lastIndexOf("@");

  let packageName: string;
  let version: string | undefined;

  if (handle.startsWith("@") && atIndex > 0) {
    // Scoped package like @org/package@version
    packageName = handle.substring(0, atIndex);
    version = handle.substring(atIndex + 1);
  } else if (atIndex > 0) {
    // Regular package@version
    packageName = handle.substring(0, atIndex);
    version = handle.substring(atIndex + 1);
  } else {
    // No version specified, will install latest
    return { name: handle };
  }

  // Validate and coerce version if specified
  if (version) {
    // First try to validate the version as-is
    const validVersion = semver.valid(version);

    if (validVersion) {
      // Version is already valid
      return { name: packageName, version: validVersion };
    }

    // Try to coerce the version
    const coercedVersion = semver.coerce(version);

    if (coercedVersion) {
      // Version was successfully coerced
      warn(
        `Version "${version}" was coerced to "${coercedVersion.version}" for package ${packageName}`,
      );
      return { name: packageName, version: coercedVersion.version };
    }

    // Version cannot be validated or coerced
    throw new Error(
      `Invalid version syntax: "${version}" for package ${packageName}`,
    );
  }

  return { name: packageName, version };
}

function buildVersionCheckCommand(
  packageManager: string,
  packageName: string,
  version: string,
  registry?: string,
): string[] {
  const registryArgs = registry ? ["--registry", registry] : [];

  switch (packageManager) {
    case "npm":
      return ["npm", "view", `${packageName}@${version}`, ...registryArgs];
    case "yarn":
      return [
        "yarn",
        "info",
        `${packageName}@${version}`,
        "--json",
        ...registryArgs,
      ];
    case "pnpm":
      return ["pnpm", "view", `${packageName}@${version}`, ...registryArgs];
    case "bun":
      // Bun doesn't have its own view command, fallback to npm
      return ["npm", "view", `${packageName}@${version}`, ...registryArgs];
    default:
      throw new Error(`Unsupported package manager: ${packageManager}`);
  }
}

function buildInstallCommand(
  packageManager: string,
  packageName: string,
  version: string | undefined,
  registry?: string,
): string[] {
  const fullPackage = version ? `${packageName}@${version}` : packageName;
  const registryArgs = registry ? ["--registry", registry] : [];

  switch (packageManager) {
    case "npm":
      return ["npm", "install", "-g", fullPackage, ...registryArgs];
    case "yarn":
      return ["yarn", "global", "add", fullPackage, ...registryArgs];
    case "pnpm":
      return ["pnpm", "add", "-g", fullPackage, ...registryArgs];
    case "bun":
      return ["bun", "add", "-g", fullPackage, ...registryArgs];
    default:
      throw new Error(`Unsupported package manager: ${packageManager}`);
  }
}

export const execute = async (
  params: JsGlobalInstallParams,
  context: PipelineContext,
): Promise<void> => {
  const processedHandle = context.processTemplate(params.handle);
  const packageManager = params.packageManager || "bun";
  const processedRegistry = params.registry
    ? context.processTemplate(params.registry)
    : undefined;

  const parsed = parsePackageHandle(processedHandle);

  debug(
    `Installing package: ${parsed.name}${parsed.version ? `@${parsed.version}` : " (latest)"}`,
  );
  debug(`Package manager: ${packageManager}`);
  if (processedRegistry) {
    debug(`Registry: ${processedRegistry}`);
  }

  try {
    // Check if specific version exists in registry (if version is specified)
    if (parsed.version) {
      debug(
        `Checking if version ${parsed.version} exists for package ${parsed.name}`,
      );

      const checkCommand = buildVersionCheckCommand(
        packageManager,
        parsed.name,
        parsed.version,
        processedRegistry,
      );

      try {
        await Bun.$`${checkCommand}`.env(enforceSafeEnv(process.env)).quiet();
        debug(`Version ${parsed.version} confirmed to exist`);
      } catch (error) {
        throw new Error(
          `Version ${parsed.version} not found for package ${parsed.name}`,
        );
      }
    }

    // Proceed with installation
    const installCommand = buildInstallCommand(
      packageManager,
      parsed.name,
      parsed.version,
      processedRegistry,
    );

    debug(`Running: ${installCommand.join(" ")}`);

    const installResult = Bun.$`${installCommand}`
      .env(enforceSafeEnv(process.env))
      .quiet();
    await installResult;

    debug(
      `Successfully installed ${processedHandle} globally using ${packageManager}`,
    );
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const installError = error as { stderr: { toString(): string } };
      throw new Error(
        `Package installation failed: ${installError.stderr.toString()}`,
      );
    }

    throw new Error(`Package installation failed: ${error}`);
  }
};
