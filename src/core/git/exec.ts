/**
 * Shared promisified execFile for all git-layer modules.
 * Centralizes the try/catch / promisify boilerplate so every git helper
 * uses the same wrapper.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const exec = promisify(execFile);
