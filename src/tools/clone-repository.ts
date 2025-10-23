import type { JSONSchemaType } from "ajv";
import { nanoid } from "nanoid";
import type { CloneRepositoryParams, CloneRepositoryYamlParams } from "../schema.ts";
import type { PipelineContext } from "../context.ts";
import {
  parseAssignmentExpression,
} from "../context.ts";
import { enforceSafeEnv } from "../utils/env.ts";
import { truncateGitHubRepositoryURL } from "../utils/string.ts";
import { failure, success, debug } from "../utils/logger.ts";

export const name = "clone-repository";

export const schema: JSONSchemaType<CloneRepositoryYamlParams> = {
  type: "object",
  properties: {
    url: { type: "string" },
    branch: { type: "string", nullable: true },
    "commit-sha": { type: "string", nullable: true },
    "output-assign": { type: "string", nullable: true },
  },
  required: ["url"],
  additionalProperties: false,
};

export const execute = async (
  params: CloneRepositoryParams,
  context: PipelineContext,
): Promise<void> => {
  const processedUrl = context.processTemplate(params.url);
  const processedBranch = params.branch
    ? context.processTemplate(params.branch)
    : undefined;
  const processedCommitSHA = params.commitSha
    ? context.processTemplate(params.commitSha)
    : undefined;

  const tmpDir = Bun.env.TMPDIR || "/tmp";
  const cloneDir = `${tmpDir}/ldde-clone-${Date.now()}-${nanoid()}`;

  debug(`Cloning repository: ${truncateGitHubRepositoryURL(processedUrl)}`);
  debug(`Target directory: ${cloneDir}`);

  try {
    let cloneCommand: string[];

    if (processedBranch) {
      debug(`Branch: ${processedBranch}`);
      cloneCommand = [
        "git",
        "clone",
        "--branch",
        processedBranch,
        "--single-branch",
        processedUrl,
        cloneDir,
      ];

      if (processedCommitSHA) {
        cloneCommand.splice(2, 0, "--depth", "1");
      }
    } else {
      cloneCommand = ["git", "clone", processedUrl, cloneDir];

      if (processedCommitSHA) {
        cloneCommand.splice(2, 0, "--depth", "1");
      }
    }

    const cloneResult = Bun.$`${cloneCommand}`.env(enforceSafeEnv(process.env)).quiet();
    await cloneResult;

    debug(`Repository cloned successfully`);

    if (processedCommitSHA) {
      debug(`Checking out commit: ${processedCommitSHA}`);

      const checkoutResult =
        Bun.$`git -C ${cloneDir} checkout ${processedCommitSHA}`.env(
          enforceSafeEnv(process.env),
        ).quiet();
      await checkoutResult;

      debug(`Checked out commit ${processedCommitSHA}`);
    }

    let outputKey: string;
    if (params.outputAssign) {
      const assignmentVar = parseAssignmentExpression(params.outputAssign);
      if (assignmentVar) {
        outputKey = assignmentVar;
      } else {
        outputKey = params.outputAssign;
      }
    } else {
      outputKey = "ctx.cloneRepositoryOutput";
    }

    context.set(outputKey, cloneDir);
    debug(`Repository path stored in context as "${outputKey}": ${cloneDir}`);
  } catch (error) {
    try {
      await Bun.$`rm -rf ${cloneDir}`.env(enforceSafeEnv(process.env)).quiet();
    } catch (cleanupError) {
      failure(
        `Failed to clean up directory ${cloneDir}:`,
        cleanupError as Error,
      );
    }

    if (error && typeof error === "object" && "stderr" in error) {
      const gitError = error as { stderr: { toString(): string } };
      throw new Error(`Git clone failed: ${gitError.stderr.toString()}`);
    }

    throw new Error(`Clone repository failed: ${error}`);
  }
};
