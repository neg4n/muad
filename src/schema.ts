import type { JSONSchemaType } from "ajv";
import type { CamelCasedPropertiesDeep } from "type-fest";
import type { PipelineContext } from "./context.ts";

export interface CloneRepositoryYamlParams {
  url: string;
  branch?: string;
  "commit-sha"?: string;
  "output-assign"?: string;
}

export type CloneRepositoryParams =
  CamelCasedPropertiesDeep<CloneRepositoryYamlParams>;

export interface JsGlobalInstallYamlParams {
  "package-manager"?: "bun" | "npm" | "yarn" | "pnpm";
  handle: string;
  registry?: string;
}

export type JsGlobalInstallParams =
  CamelCasedPropertiesDeep<JsGlobalInstallYamlParams>;

export interface ExecuteBashCommandYamlParams {
  command: string;
  shell?: "bash" | "zsh" | "fish";
  "working-directory"?: string;
  quiet?: boolean;
  "output-assign"?: string;
  "exit-on-non-zero-code"?: boolean;
  "interactive-prompts"?: {
    match: string;
    response: string;
  }[];
}

export type ExecuteBashCommandParams =
  CamelCasedPropertiesDeep<ExecuteBashCommandYamlParams>;

export interface SafeCleanupYamlParams {
  paths: string[];
  quiet?: boolean;
}

export type SafeCleanupParams = CamelCasedPropertiesDeep<SafeCleanupYamlParams>;

export interface InstallManpagesYamlParams {
  "source-directory"?: string;
  "source-files"?: string[];
  "destination-directory"?: string;
  quiet?: boolean;
  "update-database"?: boolean;
}

export type InstallManpagesParams =
  CamelCasedPropertiesDeep<InstallManpagesYamlParams>;

export interface InstallBinaryYamlParams {
  "source-path": string;
  "binary-name"?: string;
  "destination-directory"?: string;
  overwrite?: boolean;
  quiet?: boolean;
}

export type InstallBinaryParams =
  CamelCasedPropertiesDeep<InstallBinaryYamlParams>;

export type PipelineItem =
  | { tool: "clone-repository"; with: CloneRepositoryParams }
  | { tool: "js-global-install"; with: JsGlobalInstallParams }
  | { tool: "execute-bash-command"; with: ExecuteBashCommandParams }
  | { tool: "safe-cleanup"; with: SafeCleanupParams }
  | { tool: "install-manpages"; with: InstallManpagesParams }
  | { tool: "install-binary"; with: InstallBinaryParams };

export type Element = {
  name: string;
  metadata?: {
    version?: string;
    dependencies?: string[];
  };
  pipeline: PipelineItem[];
};

export interface ToolModule {
  name: string;
  schema: JSONSchemaType<unknown>;
  execute: (params: unknown, context: PipelineContext) => Promise<void>;
}

export type WithOutputAssign<T> = T & {
  outputAssign?: string;
};

export function createElementSchema(
  tools: ToolModule[],
): JSONSchemaType<Element> {
  return {
    type: "object",
    properties: {
      name: { type: "string" },
      metadata: {
        type: "object",
        nullable: true,
        properties: {
          version: { type: "string", nullable: true },
          dependencies: {
            type: "array",
            items: { type: "string" },
            nullable: true,
          },
        },
        required: [],
        additionalProperties: false,
      },
      pipeline: {
        type: "array",
        items: {
          type: "object",
          discriminator: { propertyName: "tool" },
          oneOf: tools.map((tool) => ({
            type: "object" as const,
            properties: {
              tool: { type: "string" as const, const: tool.name },
              with: tool.schema,
            },
            required: ["tool", "with"] as const,
            additionalProperties: false,
          })),
          required: ["tool", "with"],
        } as any,
      },
    },
    required: ["name", "pipeline"],
    additionalProperties: true,
  };
}
