import type { JSONSchemaType } from "ajv";
import type { ExecuteBashCommandParams, ExecuteBashCommandYamlParams } from "../schema.ts";
import type { PipelineContext } from "../context.ts";
import {
  parseAssignmentExpression,
} from "../context.ts";
import { enforceSafeEnv } from "../utils/env.ts";
import { failure, success, debug, warn } from "../utils/logger.ts";
import { spawn, type IPty, type IExitEvent } from "bun-pty";
import { stripVT } from "../utils/ansi-strip.ts";

export const name = "execute-bash-command";

export const schema: JSONSchemaType<ExecuteBashCommandYamlParams> = {
  type: "object",
  properties: {
    command: { type: "string" },
    shell: {
      type: "string",
      enum: ["bash", "zsh", "fish"],
      nullable: true,
    },
    "working-directory": { type: "string", nullable: true },
    quiet: { type: "boolean", nullable: true },
    "output-assign": { type: "string", nullable: true },
    "exit-on-non-zero-code": { type: "boolean", nullable: true },
    "interactive-prompts": {
      type: "array",
      items: {
        type: "object",
        properties: {
          match: { type: "string" },
          response: { type: "string" },
        },
        required: ["match", "response"],
        additionalProperties: false,
      },
      nullable: true,
    },
  },
  required: ["command"],
  additionalProperties: false,
};

async function checkShellAvailable(shell: string): Promise<boolean> {
  try {
    await Bun.$`which ${shell}`.env(enforceSafeEnv(process.env)).quiet();
    return true;
  } catch {
    return false;
  }
}

function buildShellCommand(shell: string, command: string): string[] {
  switch (shell) {
    case "bash":
      return ["bash", "-c", command];
    case "zsh":
      return ["zsh", "-c", command];
    case "fish":
      return ["fish", "-c", command];
    default:
      return ["bash", "-c", command];
  }
}

async function checkDirectoryExists(dir: string): Promise<boolean> {
  try {
    const stat = await Bun.file(dir).stat();
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export const execute = async (
  params: ExecuteBashCommandParams,
  context: PipelineContext,
): Promise<void> => {
  // Validate that quiet and output-assign are not used together
  if (params.quiet && params.outputAssign) {
    throw new Error("Cannot use both 'quiet' and 'output-assign' options together");
  }

  const processedCommand = context.processTemplate(params.command);
  const shell = params.shell || "bash";
  const processedWorkingDirectory = params.workingDirectory
    ? context.processTemplate(params.workingDirectory)
    : undefined;

  debug(`Executing command: ${processedCommand.replace(/\n/g, '\\n')}`);
  debug(`Shell: ${shell}`);
  if (processedWorkingDirectory) {
    debug(`Working directory: ${processedWorkingDirectory}`);
  }

  // Check if shell is available
  if (params.shell) {
    const isShellAvailable = await checkShellAvailable(shell);
    if (!isShellAvailable) {
      throw new Error(`Shell '${shell}' is not installed on this system`);
    }
  }

  // Check if working directory exists
  if (processedWorkingDirectory) {
    const dirExists = await checkDirectoryExists(processedWorkingDirectory);
    if (!dirExists) {
      throw new Error(`Working directory '${processedWorkingDirectory}' does not exist`);
    }
  }

  try {
    const shellCommand = buildShellCommand(shell, processedCommand);
    const exitOnNonZeroCode = params.exitOnNonZeroCode !== false;
    const interactive = Array.isArray(params.interactivePrompts) && params.interactivePrompts.length > 0;

    if (interactive) {
      const output = await runWithPty({
        shellCommand,
        env: enforceSafeEnv(process.env),
        cwd: processedWorkingDirectory,
        quiet: params.quiet || false,
        prompts: params.interactivePrompts!.map(p => ({
          match: context.processTemplate(p.match),
          response: context.processTemplate(p.response),
        })),
        exitOnNonZeroCode,
      });

      if (params.outputAssign) {
        const assignmentVar = parseAssignmentExpression(params.outputAssign);
        const outputKey = assignmentVar || params.outputAssign;

        const trimmed = output.trim();
        const lines = trimmed.split('\n').filter(line => line.length > 0);
        if (lines.length > 1) {
          warn(`Command output is multiline (${lines.length} lines). Storing as newline-separated string.`);
        }
        const outputValue = lines.join('\n');
        context.set(outputKey, outputValue);
        debug(`Command output stored in context as "${outputKey}"`);
      }

      if (!params.quiet) {
        success(`Command executed successfully using ${shell} (PTY)`);
      }
    } else {
      debug(`Running: ${shellCommand.join(" ")}`);

      const options = {
        env: enforceSafeEnv(process.env),
        cwd: processedWorkingDirectory,
        quiet: params.quiet || false,
      };

      let result;
      if (processedWorkingDirectory) {
        if (exitOnNonZeroCode) {
          result = params.quiet
            ? await Bun.$`${shellCommand}`.env(options.env).cwd(processedWorkingDirectory).quiet()
            : await Bun.$`${shellCommand}`.env(options.env).cwd(processedWorkingDirectory);
        } else {
          result = params.quiet
            ? await Bun.$`${shellCommand}`.env(options.env).cwd(processedWorkingDirectory).nothrow().quiet()
            : await Bun.$`${shellCommand}`.env(options.env).cwd(processedWorkingDirectory).nothrow();
        }
      } else {
        if (exitOnNonZeroCode) {
          result = params.quiet
            ? await Bun.$`${shellCommand}`.env(options.env).quiet()
            : await Bun.$`${shellCommand}`.env(options.env);
        } else {
          result = params.quiet
            ? await Bun.$`${shellCommand}`.env(options.env).nothrow().quiet()
            : await Bun.$`${shellCommand}`.env(options.env).nothrow();
        }
      }

      if (!exitOnNonZeroCode && result.exitCode !== 0) {
        warn(`Command exited with non-zero code ${result.exitCode}, but continuing due to exit-on-non-zero-code: false`);
      }

      if (!params.quiet) {
        debug("Command executed successfully");
      }

      // Handle output assignment
      if (params.outputAssign) {
        const assignmentVar = parseAssignmentExpression(params.outputAssign);
        const outputKey = assignmentVar || params.outputAssign;

        const output = result.stdout.toString().trim();
        const lines = output.split('\n').filter(line => line.length > 0);

        if (lines.length > 1) {
          warn(`Command output is multiline (${lines.length} lines). Storing as newline-separated string.`);
        }

        const outputValue = lines.join('\n');
        context.set(outputKey, outputValue);
        debug(`Command output stored in context as "${outputKey}"`);
      }

      if (!params.quiet) {
        success(`Command executed successfully using ${shell}`);
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const commandError = error as { stderr: { toString(): string } };
      throw new Error(`Command execution failed: ${commandError.stderr.toString()}`);
    }

    throw new Error(`Command execution failed: ${error}`);
  }
};

async function runWithPty(args: {
  shellCommand: string[];
  env: Record<string, string>;
  cwd?: string;
  quiet: boolean;
  prompts: { match: string; response: string }[];
  exitOnNonZeroCode: boolean;
}): Promise<string> {
  const { shellCommand, env, cwd, quiet, prompts, exitOnNonZeroCode } = args;

  const cols = process.stdout.isTTY ? process.stdout.columns : 120;
  const rows = process.stdout.isTTY ? process.stdout.rows : 30;

  if (shellCommand.length === 0) {
    throw new Error("Shell command cannot be empty");
  }

  const [file, ...argv] = shellCommand as [string, ...string[]];

  let pty: IPty;
  try {
    const spawnOptions = {
      name: "xterm-256color",
      cols,
      rows,
      cwd: cwd ?? process.cwd(),
      env,
    };

    pty = spawn(file, argv, spawnOptions);
  } catch (e) {
    throw new Error("PTY spawn failed");
  }

  let buffer = "";
  let visibleBuffer = "";
  let nextPromptIndex = 0;

  const dataSub = pty.onData((data: string) => {
    buffer += data;
    visibleBuffer += stripVT(data);
    if (!quiet) process.stdout.write(data);

    const next = prompts[nextPromptIndex];
    if (next && visibleBuffer.includes(next.match)) {
      const toSend = next.response.endsWith("\n") || next.response.endsWith("\r")
        ? next.response
        : `${next.response}\n`;
      debug(`Matched prompt: "${next.match}" -> responding`);
      try {
        pty.write(toSend);
      } catch {
        // ignore write errors; exit handler will surface failures
      }
      nextPromptIndex++;
    }
  });

  return await new Promise<string>((resolve, reject) => {
    const exitSub = pty.onExit((event: IExitEvent) => {
      // cleanup subs
      try { dataSub.dispose(); } catch {}
      try { exitSub.dispose(); } catch {}

      const code = event.exitCode ?? 0;
      if (code !== 0 && exitOnNonZeroCode) {
        return reject(new Error(`Command exited with code ${code}`));
      }
      if (code !== 0 && !exitOnNonZeroCode) {
        warn(
          `Command exited with non-zero code ${code}, but continuing due to exit-on-non-zero-code: false`,
        );
      }
      resolve(buffer);
    });
  });
}
