import type { JSONSchemaType } from "ajv";
import { basename, dirname, join, resolve } from "node:path";
import type {
  InstallBinaryParams,
  InstallBinaryYamlParams,
} from "../schema.ts";
import type { PipelineContext } from "../context.ts";
import { enforceSafeEnv } from "../utils/env.ts";
import { debug, info, success, warn } from "../utils/logger.ts";

export const name = "install-binary";

export const schema: JSONSchemaType<InstallBinaryYamlParams> = {
  type: "object",
  properties: {
    "source-path": { type: "string" },
    "binary-name": { type: "string", nullable: true },
    "destination-directory": { type: "string", nullable: true },
    overwrite: { type: "boolean", nullable: true },
    quiet: { type: "boolean", nullable: true },
  },
  required: ["source-path"],
  additionalProperties: false,
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  if (await pathExists(path)) {
    return;
  }

  try {
    if (process.platform === "win32") {
      await Bun.$`powershell -NoProfile -Command New-Item -ItemType Directory -Force -Path ${path}`
        .env(enforceSafeEnv(process.env))
        .quiet();
    } else {
      await Bun.$`mkdir -p ${path}`.env(enforceSafeEnv(process.env)).quiet();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create directory "${path}": ${message}`);
  }
}

function defaultBinaryName(sourcePath: string, requestedName?: string): string {
  if (requestedName) {
    if (process.platform === "win32" && !requestedName.endsWith(".exe")) {
      return `${requestedName}.exe`;
    }
    return requestedName;
  }

  const filename = basename(sourcePath);
  if (process.platform === "win32" && !filename.endsWith(".exe")) {
    return `${filename}.exe`;
  }
  return filename;
}

function resolveCandidateDirectories(
  binaryName: string,
  destinationOverride?: string,
): string[] {
  if (destinationOverride) {
    return [destinationOverride];
  }

  const platform = process.platform;
  const arch = process.arch;
  const candidates = new Set<string>();

  const home =
    Bun.env.HOME ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    process.env.LOCALAPPDATA ||
    "";

  if (platform === "darwin") {
    if (arch === "arm64") {
      candidates.add(join("/opt", binaryName, "bin"));
      candidates.add("/opt/bin");
      candidates.add("/opt/homebrew/bin");
    } else {
      candidates.add("/usr/local/bin");
      candidates.add("/opt/local/bin");
    }
    if (home) {
      candidates.add(join(home, ".local", "bin"));
      candidates.add(join(home, "bin"));
    }
  } else if (platform === "win32") {
    const programFiles = process.env.ProgramFiles;
    const programFilesX86 = process.env["ProgramFiles(x86)"];
    const localAppData = process.env.LOCALAPPDATA;
    const programData = process.env.ProgramData;

    if (programFiles) {
      candidates.add(join(programFiles, binaryName));
    }
    if (programFilesX86) {
      candidates.add(join(programFilesX86, binaryName));
    }
    if (programData) {
      candidates.add(join(programData, binaryName));
    }
    if (localAppData) {
      candidates.add(join(localAppData, "Programs", binaryName));
    }
  } else {
    candidates.add("/usr/local/bin");
    candidates.add("/usr/bin");
    candidates.add("/opt/bin");
    candidates.add("/opt/local/bin");
    if (home) {
      candidates.add(join(home, ".local", "bin"));
      candidates.add(join(home, "bin"));
    }
  }

  return Array.from(candidates);
}

async function makeExecutable(path: string) {
  if (process.platform === "win32") {
    return;
  }

  try {
    await Bun.$`chmod 755 ${path}`.env(enforceSafeEnv(process.env)).quiet();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`Failed to mark "${path}" as executable: ${message}`);
  }
}

async function copyFile(source: string, destination: string, overwrite: boolean) {
  const destinationExists = await pathExists(destination);

  if (destinationExists && !overwrite) {
    throw new Error(
      `Destination "${destination}" already exists. Enable overwrite to replace it.`,
    );
  }

  try {
    await Bun.write(destination, Bun.file(source));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to copy binary to "${destination}": ${message}`);
  }
}

async function createSymlink(
  target: string,
  linkPath: string,
  quiet: boolean,
): Promise<void> {
  try {
    if (await pathExists(linkPath)) {
      return;
    }

    if (process.platform === "win32") {
      await Bun.$`powershell -NoProfile -Command New-Item -ItemType SymbolicLink -Path ${linkPath} -Target ${target}`
        .env(enforceSafeEnv(process.env))
        .quiet();
    } else {
      await Bun.$`ln -s ${target} ${linkPath}`
        .env(enforceSafeEnv(process.env))
        .quiet();
    }
    if (!quiet) {
      debug(`Created symlink: ${linkPath} -> ${target}`);
    }
  } catch (error) {
    if (!quiet) {
      warn(
        `Unable to create symlink "${linkPath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function resolveSymlinkCandidates(
  installedPath: string,
  binaryName: string,
): string[] {
  const platform = process.platform;
  const arch = process.arch;
  const candidates: string[] = [];

  const home =
    Bun.env.HOME ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    process.env.LOCALAPPDATA ||
    "";

  if (platform === "darwin") {
    if (arch === "arm64") {
      candidates.push("/opt/homebrew/bin", "/usr/local/bin");
    } else {
      candidates.push("/usr/local/bin");
    }
    if (home) {
      candidates.push(join(home, ".local", "bin"));
    }
  } else if (platform !== "win32") {
    candidates.push("/usr/local/bin", "/usr/bin");
    if (home) {
      candidates.push(join(home, ".local", "bin"));
    }
  }

  return candidates
    .filter((dir) => installedPath.startsWith(dir) === false)
    .map((dir) => join(dir, binaryName));
}

export const execute = async (
  params: InstallBinaryParams,
  context: PipelineContext,
): Promise<void> => {
  const quiet = params.quiet ?? false;

  const sourcePath = resolve(context.processTemplate(params.sourcePath));
  const sourceExists = await pathExists(sourcePath);

  if (!sourceExists) {
    throw new Error(
      `Source binary "${sourcePath}" does not exist or is inaccessible`,
    );
  }

  const binaryName = defaultBinaryName(sourcePath, params.binaryName);
  const destinationOverride = params.destinationDirectory
    ? context.processTemplate(params.destinationDirectory)
    : undefined;

  const candidateDirectories = resolveCandidateDirectories(
    binaryName.replace(/\.exe$/i, ""),
    destinationOverride ? resolve(destinationOverride) : undefined,
  );

  if (candidateDirectories.length === 0) {
    throw new Error("No candidate directories resolved for binary installation");
  }

  if (!quiet) {
    info(
      `Installing binary "${binaryName}" from ${sourcePath} for platform ${process.platform}/${process.arch}`,
    );
    debug(
      `Candidate directories (in order): ${candidateDirectories.join(", ")}`,
    );
  }

  const overwrite = params.overwrite === true;
  const errors: string[] = [];
  let installedPath: string | null = null;

  for (const dir of candidateDirectories) {
    const resolvedDir = resolve(dir);

    if (process.platform === "darwin" && process.arch === "arm64") {
      if (!resolvedDir.startsWith("/opt")) {
        continue;
      }
    }

    try {
      await ensureDirectory(resolvedDir);
    } catch (error) {
      errors.push(
        `Failed to prepare directory "${resolvedDir}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      continue;
    }

    const destinationPath = process.platform === "win32"
      ? join(resolvedDir, binaryName)
      : join(resolvedDir, binaryName.replace(/\.exe$/i, ""));

    try {
      await copyFile(sourcePath, destinationPath, overwrite);
      await makeExecutable(destinationPath);
      installedPath = destinationPath;
      if (!quiet) {
        success(`Installed binary to ${destinationPath}`);
      }
      break;
    } catch (error) {
      errors.push(
        `Failed to install to "${destinationPath}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (!installedPath) {
    throw new Error(
      `Unable to install binary. Attempts: \n- ${errors.join("\n- ")}`,
    );
  }

  if (process.platform === "darwin" && process.arch === "arm64") {
    const brewBin = "/opt/homebrew/bin";
    if (await pathExists(brewBin)) {
      await ensureDirectory(brewBin);
      await createSymlink(
        installedPath,
        join(brewBin, binaryName.replace(/\.exe$/i, "")),
        quiet,
      );
    }
  }

  const symlinkTargets = resolveSymlinkCandidates(installedPath, binaryName);
  for (const link of symlinkTargets) {
    await ensureDirectory(dirname(link));
    await createSymlink(installedPath, link, quiet);
  }

  if (!quiet && process.platform === "win32") {
    info(
      `If the binary is not already on PATH, add its directory manually: ${installedPath}`,
    );
  }
};
