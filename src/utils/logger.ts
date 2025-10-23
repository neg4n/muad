import { color } from "bun" with { type: "macro" };
import type { ErrorObject } from "ajv";

// Black Waves theme color palette converted to ANSI at compile time
const colors = {
  error: color("#ff5757", "ansi"),      // Muted red for errors
  warning: color("#b657ff", "ansi"),    // Purple for warnings
  debug: color("#666666", "ansi"),      // Muted gray for debug
  info: color("#b3b3b3", "ansi"),       // Light gray for info
  success: color("#a7da1e", "ansi"),    // Soft green for success
  stack: color("#4e4e4e", "ansi"),      // Dark gray for stack traces
  reset: "\x1b[0m",                     // Reset color
  dim: "\x1b[2m",                       // Dim text
  timestamp: color("#505050", "ansi")    // Subtle timestamp color
};

// Format current timestamp
function getTimestamp(): string {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", { 
    hour12: false, 
    hour: "2-digit", 
    minute: "2-digit", 
    second: "2-digit" 
  });
  return `${colors.timestamp}${colors.dim}[${time}]${colors.reset}`;
}

// Type guard for AJV validation errors
function isAjvValidationErrors(err: unknown): err is ErrorObject[] {
  return Array.isArray(err) && 
         err.length > 0 && 
         typeof err[0] === 'object' &&
         'keyword' in err[0] &&
         'instancePath' in err[0];
}

// Type guard for BuildMessage errors (YAML parsing)
function isBuildMessage(err: unknown): err is Error {
  return err !== null && 
         typeof err === 'object' && 
         err.constructor?.name === 'BuildMessage';
}

// Format AJV validation errors
function formatValidationErrors(errors: ErrorObject[]): string {
  let output = '';
  errors.forEach((err, index) => {
    const path = err.instancePath || '/';
    output += `\n  ${colors.error}${index + 1}. ${path}: ${err.message}${colors.reset}`;
    if (err.keyword && err.params) {
      const params = Object.entries(err.params)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(', ');
      output += `\n     ${colors.dim}(${err.keyword}: ${params})${colors.reset}`;
    }
  });
  return output;
}

// Format stack trace with proper indentation and coloring
function formatStackTrace(error: Error): string {
  if (!error.stack) return "";
  
  const lines = error.stack.split('\n');
  const stackLines = lines.slice(1)
    .filter(line => line.trim())
    .map(line => `  ${colors.stack}${line.trim()}${colors.reset}`)
    .join('\n');
  
  return stackLines ? `\n${stackLines}` : "";
}

// Generic failure function with proper typing
export function failure<T extends Error = Error>(
  message: string, 
  err?: T | ErrorObject[] | unknown
): void {
  const timestamp = getTimestamp();
  console.error(`${timestamp} ${colors.error}FAILURE${colors.reset} ${message}`);
  
  if (!err) return;
  
  // Handle AJV validation errors
  if (isAjvValidationErrors(err)) {
    console.error(formatValidationErrors(err));
    return;
  }
  
  // Handle BuildMessage (YAML parsing errors)
  if (isBuildMessage(err)) {
    console.error(`\n  ${colors.error}${err.toString()}${colors.reset}`);
    return;
  }
  
  // Handle regular Error objects
  if (err instanceof Error) {
    if (err.message) {
      console.error(`\n  ${colors.error}${err.message}${colors.reset}`);
    }
    if (err.stack) {
      console.error(formatStackTrace(err));
    }
    return;
  }
  
  // Fallback for unknown error types
  console.error(`\n  ${colors.error}${String(err)}${colors.reset}`);
}

// Debug logging with environment check (compiled at build time)
export function debug(message: string): void {
  if (process.env.DEBUG) {
    const timestamp = getTimestamp();
    console.log(`${timestamp} ${colors.debug}DEBUG${colors.reset} ${colors.dim}${message}${colors.reset}`);
  }
}

// Info logging for general information
export function info(message: string): void {
  const timestamp = getTimestamp();
  console.log(`${timestamp} ${colors.info}INFO${colors.reset}  ${message}`);
}

// Warning logging for coercion and other warnings
export function warn(message: string): void {
  const timestamp = getTimestamp();
  console.warn(`${timestamp} ${colors.warning}WARNING${colors.reset} ${message}`);
}

// Success logging for positive feedback
export function success(message: string): void {
  const timestamp = getTimestamp();
  console.log(`${timestamp} ${colors.success}SUCCESS${colors.reset} ${message}`);
}