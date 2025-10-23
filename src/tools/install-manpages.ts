import type { JSONSchemaType } from "ajv";
import { basename, dirname, join, resolve } from "node:path";
import type {
  InstallManpagesParams,
  InstallManpagesYamlParams,
} from "../schema.ts";
import type { PipelineContext } from "../context.ts";
import { enforceSafeEnv } from "../utils/env.ts";
import { debug, info, success, warn } from "../utils/logger.ts";

export const name = "install-manpages";

export const schema: JSONSchemaType<InstallManpagesYamlParams> = {
  type: "object",
  properties: {
    "source-directory": { type: "string", nullable: true },
    "source-files": {
      type: "array",
      items: { type: "string" },
      nullable: true,
      minItems: 1,
    },
    "destination-directory": { type: "string", nullable: true },
    quiet: { type: "boolean", nullable: true },
    "update-database": { type: "boolean", nullable: true },
  },
  required: [],
  additionalProperties: false,
};

type PathKind = "file" | "directory" | "other" | "missing";

interface ManpageSource {
  sourcePath: string;
  relativeParts: string[];
}

const MANPAGE_EXT_REGEX = /\.(\d[\w+-]*)(\.[\w]+)?$/i;
const COMPRESSED_EXT_REGEX = /\.(gz|bz2|xz|lz|lzma|z|Z)$/i;

function stripCompressionExtension(fileName: string): string {
  return fileName.replace(COMPRESSED_EXT_REGEX, "");
}

function isManpageFile(fileName: string): boolean {
  const stripped = stripCompressionExtension(fileName);
  return MANPAGE_EXT_REGEX.test(stripped);
}

function extractSection(fileName: string): string | null {
  const stripped = stripCompressionExtension(fileName);
  const match = stripped.match(/\.(\d[\w+-]*)$/i);
  return match ? match[1] ?? null : null;
}

function splitRelativePath(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

function isLocaleSegment(segment: string | undefined): boolean {
  if (!segment) return false;
  if (/^man\d/i.test(segment)) return false;
  const normalized = segment.toLowerCase();
  if (normalized === "man" || normalized === "share") return false;
  return /^[A-Za-z0-9_.@-]+$/.test(segment);
}

async function getPathKind(path: string): Promise<PathKind> {
  try {
    const stat = await Bun.file(path).stat();
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const kind = await getPathKind(path);
  if (kind === "directory") return;
  if (kind === "file") {
    throw new Error(`Path "${path}" exists and is a file, not a directory`);
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

function computeDestinationParts(
  relativeParts: string[],
  fileName: string,
): string[] {
  const normalizedParts = [...relativeParts];
  if (
    normalizedParts.length === 0 ||
    normalizedParts[normalizedParts.length - 1] !== fileName
  ) {
    normalizedParts.push(fileName);
  }

  let manDirIndex = normalizedParts.findIndex((part) =>
    /^man\d[\w+-]*$/i.test(part),
  );

  const firstPart = normalizedParts[0];
  if (
    manDirIndex === -1 &&
    normalizedParts.length > 0 &&
    firstPart &&
    /^man\d[\w+-]*$/i.test(firstPart)
  ) {
    manDirIndex = 0;
  }

  if (manDirIndex >= 0) {
    const localeCandidate = normalizedParts[manDirIndex - 1];
    const destParts = normalizedParts.slice(manDirIndex);
    if (localeCandidate && isLocaleSegment(localeCandidate)) {
      return [localeCandidate, ...destParts];
    }
    return destParts;
  }

  const section = extractSection(fileName);
  if (!section) {
    throw new Error(
      `Cannot determine manual section for "${fileName}". Ensure files end with a section extension (e.g. ".1") or reside in "man<section>" directories.`,
    );
  }

  return [`man${section}`, fileName];
}

async function collectFromDirectory(
  directory: string,
  quiet: boolean,
): Promise<ManpageSource[]> {
  const results: ManpageSource[] = [];
  const glob = new Bun.Glob("**/*");
  const entries = await Array.fromAsync(
    glob.scan({ cwd: directory, dot: true }),
  );

  for (const entry of entries) {
    const sourcePath = join(directory, entry);
    try {
      const stat = await Bun.file(sourcePath).stat();
      if (stat.isDirectory()) {
        continue;
      }
      if (!stat.isFile()) {
        if (!quiet) {
          debug(`Skipping non-regular entry "${sourcePath}"`);
        }
        continue;
      }

      const fileName = basename(sourcePath);
      if (!isManpageFile(fileName)) {
        if (!quiet) {
          debug(`Skipping non-manpage file "${sourcePath}"`);
        }
        continue;
      }

      results.push({
        sourcePath,
        relativeParts: splitRelativePath(entry),
      });
    } catch (error) {
      if (!quiet) {
        warn(
          `Skipping "${sourcePath}" while scanning manpages: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  return results;
}

async function collectManpageSources(
  resolvedPaths: string[],
  quiet: boolean,
): Promise<ManpageSource[]> {
  const results: ManpageSource[] = [];

  for (const path of resolvedPaths) {
    const kind = await getPathKind(path);
    if (kind === "missing") {
      throw new Error(`Source path "${path}" does not exist`);
    }

    if (kind === "directory") {
      const found = await collectFromDirectory(path, quiet);
      if (found.length === 0 && !quiet) {
        warn(
          `No manpage files detected under directory "${path}". Expected files such as "*.1" or "*.1.gz".`,
        );
      }
      results.push(...found);
      continue;
    }

    if (kind === "file") {
      const fileName = basename(path);
      if (!isManpageFile(fileName)) {
        throw new Error(
          `File "${path}" is not recognised as a manpage (expected extension like ".1" or ".1.gz").`,
        );
      }

      results.push({
        sourcePath: path,
        relativeParts: [fileName],
      });
      continue;
    }

    throw new Error(`Unsupported source path type for "${path}"`);
  }

  return results;
}

function resolveDestinationCandidates(
  override?: string,
): string[] {
  const candidates: string[] = [];

  const addCandidate = (candidate?: string) => {
    if (!candidate) return;
    const absolute = resolve(candidate);
    if (!candidates.includes(absolute)) {
      candidates.push(absolute);
    }
  };

  if (override) {
    addCandidate(override);
    return candidates;
  }

  const home =
    Bun.env.HOME ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    process.env.LOCALAPPDATA ||
    "";

  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      addCandidate("/opt/homebrew/share/man");
      addCandidate("/usr/local/share/man");
    } else {
      addCandidate("/usr/local/share/man");
      addCandidate("/opt/local/share/man");
    }
    addCandidate("/usr/share/man");
    if (home) {
      addCandidate(join(home, "Library", "Man"));
      addCandidate(join(home, ".local", "share", "man"));
    }
  } else if (process.platform === "win32") {
    const programData = process.env.ProgramData;
    const localAppData = process.env.LOCALAPPDATA;
    addCandidate(programData ? join(programData, "man") : undefined);
    addCandidate(localAppData ? join(localAppData, "man") : undefined);
    addCandidate(home ? join(home, "man") : undefined);
  } else {
    addCandidate("/usr/local/share/man");
    addCandidate("/usr/share/man");
    addCandidate("/usr/local/man");
    addCandidate("/usr/man");
    if (home) {
      addCandidate(join(home, ".local", "share", "man"));
    }
  }

  return candidates;
}

function buildInstallOperations(
  files: ManpageSource[],
  destinationBase: string,
  quiet: boolean,
): { source: string; destination: string }[] {
  const operations: { source: string; destination: string }[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const fileName = basename(file.sourcePath);
    const destParts = computeDestinationParts(file.relativeParts, fileName);
    const destinationPath = join(destinationBase, ...destParts);

    if (seen.has(destinationPath)) {
      const existing = seen.get(destinationPath)!;
      if (existing === file.sourcePath) {
        continue;
      }
      if (!quiet) {
        warn(
          `Skipping duplicate manpage target "${destinationPath}" from "${file.sourcePath}" (already provided by "${existing}")`,
        );
      }
      continue;
    }

    seen.set(destinationPath, file.sourcePath);
    operations.push({ source: file.sourcePath, destination: destinationPath });
  }

  return operations;
}

async function setManpagePermissions(path: string, quiet: boolean): Promise<void> {
  if (process.platform === "win32") return;

  try {
    await Bun.$`chmod 644 ${path}`.env(enforceSafeEnv(process.env)).quiet();
  } catch (error) {
    if (!quiet) {
      warn(
        `Failed to set permissions on "${path}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function installToDestination(
  files: ManpageSource[],
  destinationBase: string,
  quiet: boolean,
): Promise<number> {
  await ensureDirectory(destinationBase);

  const operations = buildInstallOperations(files, destinationBase, quiet);
  if (operations.length === 0) {
    return 0;
  }

  for (const operation of operations) {
    await ensureDirectory(dirname(operation.destination));
    await Bun.write(operation.destination, Bun.file(operation.source));
    await setManpagePermissions(operation.destination, quiet);
    if (!quiet) {
      debug(`Installed manpage: ${operation.destination}`);
    }
  }

  return operations.length;
}

async function commandExists(command: string): Promise<boolean> {
  const env = enforceSafeEnv(process.env);
  try {
    if (process.platform === "win32") {
      await Bun.$`where ${command}`.env(env).quiet();
    } else {
      await Bun.$`command -v ${command}`.env(env).quiet();
    }
    return true;
  } catch {
    return false;
  }
}

async function updateManDatabase(
  manDirectory: string,
  quiet: boolean,
): Promise<void> {
  const env = enforceSafeEnv(process.env);

  if (await commandExists("mandb")) {
    if (!quiet) {
      debug(`Updating man database with mandb for ${manDirectory}`);
    }
    try {
      if (quiet) {
        await Bun.$`mandb -q ${manDirectory}`.env(env).quiet();
      } else {
        await Bun.$`mandb -q ${manDirectory}`.env(env);
      }
      return;
    } catch (error) {
      if (!quiet) {
        warn(
          `mandb failed for "${manDirectory}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (await commandExists("makewhatis")) {
    if (!quiet) {
      debug(`Updating man database with makewhatis for ${manDirectory}`);
    }
    try {
      if (quiet) {
        await Bun.$`makewhatis ${manDirectory}`.env(env).quiet();
      } else {
        await Bun.$`makewhatis ${manDirectory}`.env(env);
      }
      return;
    } catch (error) {
      if (!quiet) {
        warn(
          `makewhatis failed for "${manDirectory}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  if (!quiet) {
    warn(
      "Neither mandb nor makewhatis is available or succeeded; manual database update may be required.",
    );
  }
}

export const execute = async (
  params: InstallManpagesParams,
  context: PipelineContext,
): Promise<void> => {
  const quiet = params.quiet ?? false;

  const rawSources: string[] = [];
  if (params.sourceDirectory) {
    const processedDir = context.processTemplate(params.sourceDirectory).trim();
    if (processedDir.length > 0) {
      rawSources.push(processedDir);
    }
  }
  if (Array.isArray(params.sourceFiles)) {
    for (const entry of params.sourceFiles) {
      const processedFile = context.processTemplate(entry).trim();
      if (processedFile.length > 0) {
        rawSources.push(processedFile);
      }
    }
  }

  if (rawSources.length === 0) {
    throw new Error(
      "install-manpages requires at least one source path (source-directory or source-files).",
    );
  }

  const resolvedSources = rawSources.map((source) => resolve(source));
  if (!quiet) {
    info(
      `Installing manpages from ${resolvedSources.join(", ")} on ${process.platform}/${process.arch}`,
    );
  }

  const manpageSources = await collectManpageSources(resolvedSources, quiet);

  if (manpageSources.length === 0) {
    throw new Error(
      "No manpage files matched the provided sources. Ensure files end with traditional manpage sections (e.g. .1, .5, .7).",
    );
  }

  const destinationOverride = params.destinationDirectory
    ? context.processTemplate(params.destinationDirectory)
    : undefined;

  const destinationCandidates = resolveDestinationCandidates(destinationOverride);

  if (destinationCandidates.length === 0) {
    throw new Error("Could not determine a destination directory for manpages.");
  }

  if (!quiet) {
    debug(
      `Destination candidates (preference order): ${destinationCandidates.join(", ")}`,
    );
  }

  const errors: string[] = [];
  let selectedDestination: string | null = null;
  let installedCount = 0;

  for (const candidate of destinationCandidates) {
    if (!quiet) {
      debug(`Attempting to install manpages into ${candidate}`);
    }

    try {
      installedCount = await installToDestination(
        manpageSources,
        candidate,
        quiet,
      );
      selectedDestination = candidate;
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${candidate}: ${message}`);
      if (!quiet) {
        warn(`Failed to install manpages into ${candidate}: ${message}`);
      }
    }
  }

  if (!selectedDestination) {
    throw new Error(
      `Unable to install manpages. Attempted locations:\n- ${errors.join("\n- ")}`,
    );
  }

  if (installedCount === 0) {
    warn(
      `No manpage files were installed into ${selectedDestination}. Check the source paths and destination permissions.`,
    );
  } else if (!quiet) {
    info(`Installed ${installedCount} manpage file(s) into ${selectedDestination}`);
  }

  if (params.updateDatabase) {
    await updateManDatabase(selectedDestination, quiet);
  } else if (!quiet) {
    debug("Skipping man database update (update-database not enabled)");
  }

  if (!quiet) {
    success(
      `Manpages available in ${selectedDestination}${
        params.updateDatabase ? " (database refreshed if possible)" : ""
      }`,
    );
  }
};
