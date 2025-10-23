import { flattie } from 'flattie';
import { dset } from 'dset';
import dlv from 'dlv';
import { normalizeKeys } from './utils/string.ts';

export interface TemplateContext {
  [key: string]: unknown;
}

export class ContextError extends Error {
  constructor(message: string, public readonly key?: string) {
    super(message);
    this.name = 'ContextError';
  }
}

export class TemplateError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

function validateCamelCase(key: string): boolean {
  const camelCaseRegex = /^[a-z][a-zA-Z0-9]*$/;
  return camelCaseRegex.test(key);
}

class ReadonlyContext {
  private readonly data: Record<string, unknown>;

  constructor(elementData: Record<string, unknown>) {
    const normalized = normalizeKeys(elementData);
    const filtered = Object.entries(normalized)
      .filter(([key]) => key !== 'pipeline')
      .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
    
    this.data = this.flattenPrimitives(flattie(filtered));
    Object.freeze(this.data);
  }

  private flattenPrimitives(flat: Record<string, unknown>): Record<string, unknown> {
    return Object.entries(flat)
      .filter(([_, v]) => ['string', 'number', 'boolean'].includes(typeof v) || v === null)
      .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {});
  }

  getAllKeys(): string[] {
    return Object.keys(this.data);
  }

  snapshot(): Record<string, unknown> {
    return { ...this.data };
  }
}

class RuntimeContext {
  private readonly data: Record<string, unknown> = {};
  private readonly assignedKeys = new Set<string>();
  private readonly readonlyKeys: Set<string>;

  constructor(readonlyKeys: string[]) {
    this.readonlyKeys = new Set(readonlyKeys);
  }

  set<T = unknown>(key: string, value: T): void {
    const pathParts = key.split('.');
    for (const part of pathParts) {
      if (!validateCamelCase(part)) {
        throw new ContextError(`Invalid key format: "${part}". Keys must be camelCase.`, key);
      }
    }

    if (this.readonlyKeys.has(key)) {
      throw new ContextError(`Cannot set runtime variable "${key}": conflicts with readonly context variable`);
    }

    if (this.assignedKeys.has(key)) {
      throw new ContextError(`Key "${key}" already exists in runtime context`, key);
    }

    try {
      dset(this.data, key, value);
      this.assignedKeys.add(key);
    } catch (error) {
      throw new ContextError(`Failed to set "${key}": ${error}`, key);
    }
  }

  get<T = unknown>(key: string): T | undefined {
    try {
      return dlv(this.data, key) as T | undefined;
    } catch (error) {
      throw new ContextError(`Failed to get "${key}": ${error}`, key);
    }
  }

  has(key: string): boolean {
    return dlv(this.data, key) !== undefined;
  }

  resolve<T = unknown>(path: string): T | undefined {
    return this.get<T>(path);
  }

  getAssignedKeys(): string[] {
    return Array.from(this.assignedKeys);
  }

  getData(): TemplateContext {
    return { ...this.data };
  }

  clear(): void {
    Object.keys(this.data).forEach(key => delete this.data[key]);
    this.assignedKeys.clear();
  }

  snapshot(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.data));
  }
}

function resolvePath(context: TemplateContext, path: string): unknown {
  if (path in context) {
    return context[path];
  }
  
  return dlv(context, path);
}

export function processTemplate(template: string, readonlyCtx: Record<string, unknown>, runtimeCtx: TemplateContext): string {
  if (isAssignmentExpression(template)) {
    return template;
  }
  
  const conflicts = Object.keys(runtimeCtx).filter(key => key in readonlyCtx);
  if (conflicts.length > 0) {
    throw new TemplateError(`Runtime context conflicts with readonly context keys: ${conflicts.join(', ')}`);
  }
  
  const mergedContext = { ...readonlyCtx, ...runtimeCtx };
  
  const templateRegex = /\$\{\{\s*([\w.]+)\s*\}\}/g;
  let result = template;
  let match: RegExpExecArray | null;
  
  templateRegex.lastIndex = 0;
  
  while ((match = templateRegex.exec(template)) !== null) {
    const fullMatch = match[0];
    const variablePath = match[1];
    
    if (!variablePath) continue;
    
    const pathParts = variablePath.split('.');
    for (const part of pathParts) {
      if (!validateCamelCase(part)) {
        throw new TemplateError(`Invalid key format: "${part}". Keys must be camelCase.`, variablePath);
      }
    }
    
    try {
      const value = resolvePath(mergedContext, variablePath);
      
      if (value === undefined) {
        throw new TemplateError(`Variable "${variablePath}" is undefined in context`, variablePath);
      }
      
      if (typeof value === 'object' && value !== null) {
        throw new TemplateError(`Cannot expand object value for "${variablePath}". Only primitive values are allowed in templates.`, variablePath);
      }
      
      const stringValue = typeof value === 'string' ? value : String(value);
      
      result = result.replace(fullMatch, stringValue);
    } catch (error) {
      if (error instanceof TemplateError) {
        throw error;
      }
      throw new TemplateError(`Error resolving "${variablePath}": ${error}`, variablePath);
    }
  }
  
  return result;
}

export function processObjectTemplate<T>(obj: T, readonlyCtx: Record<string, unknown>, runtimeCtx: TemplateContext): T {
  if (typeof obj === 'string') {
    return processTemplate(obj, readonlyCtx, runtimeCtx) as T;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => processObjectTemplate(item, readonlyCtx, runtimeCtx)) as T;
  }
  
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (key) {
        result[key] = processObjectTemplate(value, readonlyCtx, runtimeCtx);
      }
    }
    return result as T;
  }
  
  return obj;
}

export function hasTemplateExpressions(str: string): boolean {
  const templateRegex = /\$\{\{\s*[\w.]+\s*\}\}/;
  return templateRegex.test(str);
}

export function extractVariablePaths(template: string): string[] {
  const templateRegex = /\$\{\{\s*([\w.]+)\s*\}\}/g;
  const paths: string[] = [];
  let match: RegExpExecArray | null;
  
  while ((match = templateRegex.exec(template)) !== null) {
    const path = match[1];
    if (path) {
      paths.push(path);
    }
  }
  
  return paths;
}

export function isAssignmentExpression(str: string): boolean {
  const assignmentRegex = /^\$>\{\{\s*[\w.]+\s*\}\}$/;
  return assignmentRegex.test(str);
}

export function parseAssignmentExpression(expr: string): string | null {
  const assignmentRegex = /^\$>\{\{\s*([\w.]+)\s*\}\}$/;
  const match = expr.match(assignmentRegex);
  return match?.[1] ?? null;
}

export class PipelineContext {
  private readonly runtimeContext: RuntimeContext;
  private readonly readonlyContext: ReadonlyContext;

  constructor(elementData: Record<string, unknown>) {
    this.readonlyContext = new ReadonlyContext(elementData);
    this.runtimeContext = new RuntimeContext(this.readonlyContext.getAllKeys());
  }

  set<T = unknown>(key: string, value: T): void {
    this.runtimeContext.set(key, value);
  }

  get<T = unknown>(key: string): T | undefined {
    return this.runtimeContext.get(key);
  }

  has(key: string): boolean {
    return this.runtimeContext.has(key);
  }

  resolve<T = unknown>(path: string): T | undefined {
    return this.runtimeContext.resolve(path);
  }

  getAssignedKeys(): string[] {
    return this.runtimeContext.getAssignedKeys();
  }

  getData(): TemplateContext {
    return this.runtimeContext.getData();
  }

  clear(): void {
    this.runtimeContext.clear();
  }

  snapshot(): Record<string, unknown> {
    return this.runtimeContext.snapshot();
  }

  getReadonlyData(): Record<string, unknown> {
    return this.readonlyContext.snapshot();
  }

  processTemplate(template: string): string {
    return processTemplate(template, this.getReadonlyData(), this.getData());
  }

  processObjectTemplate<T>(obj: T): T {
    return processObjectTemplate(obj, this.getReadonlyData(), this.getData());
  }
}