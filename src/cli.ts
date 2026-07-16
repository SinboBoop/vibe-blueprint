#!/usr/bin/env node
import { CLI_HELP } from "./cli-help.js";
import { credentialStatus, deleteCredential, promptAndStoreApiKey } from "./auth.js";
import { CLI_NAME } from "./constants.js";
import { ResponsesModelClient } from "./model-client.js";
import { runDoctor } from "./doctor.js";
import { runLiveVerification } from "./live-verification.js";
import { safeErrorMessage } from "./security.js";

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function rejectExtraArguments(args: readonly string[], usage: string): void {
  if (args.length > 0) throw new Error(`Unexpected argument. Usage: ${usage}. API keys are never accepted as arguments.`);
}

async function authCommand(args: readonly string[]): Promise<void> {
  const action = args[0];
  const rest = args.slice(1);
  if (action === "set") {
    rejectExtraArguments(rest, `${CLI_NAME} auth set`);
    const file = await promptAndStoreApiKey();
    writeJson({ configured: true, source: "file", credential_file: file });
    return;
  }
  if (action === "status") {
    rejectExtraArguments(rest, `${CLI_NAME} auth status`);
    writeJson(await credentialStatus());
    return;
  }
  if (action === "delete") {
    rejectExtraArguments(rest, `${CLI_NAME} auth delete`);
    writeJson({ deleted: await deleteCredential() });
    return;
  }
  throw new Error(`Usage: ${CLI_NAME} auth set|status|delete`);
}

async function doctorCommand(args: readonly string[]): Promise<void> {
  let checkModel = false;
  let projectRoot: string | undefined;
  for (const argument of args) {
    if (argument === "--check-model") {
      checkModel = true;
    } else if (projectRoot === undefined) {
      projectRoot = argument;
    } else {
      throw new Error(`Usage: ${CLI_NAME} doctor [project_root] [--check-model]`);
    }
  }
  const result = await runDoctor({
    ...(projectRoot === undefined ? {} : { projectRoot }),
    checkModel,
    probeModel: async () => {
      const client = await ResponsesModelClient.fromEnv();
      const probe = await client.probeConnectivity();
      return { endpoint: probe.responsesPath, model: probe.model };
    },
  });
  writeJson(result);
  if (!result.ok) process.exitCode = 1;
}

async function liveVerifyCommand(args: readonly string[]): Promise<void> {
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--output") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Usage: ${CLI_NAME} live-verify --yes [--output file]`);
      }
      outputPath = value;
      index += 1;
    } else if (argument !== "--yes") {
      throw new Error(`Usage: ${CLI_NAME} live-verify --yes [--output file]`);
    }
  }
  if (!args.includes("--yes")) {
    throw new Error("Live verification makes real provider requests; rerun with --yes to opt in explicitly");
  }
  const result = await runLiveVerification({
    enabled: true,
    ...(outputPath === undefined ? {} : { outputPath }),
  });
  writeJson(result);
  if (result.status !== "passed") process.exitCode = 1;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${CLI_HELP}\n`);
    return;
  }
  if (command === "auth") return authCommand(args);
  if (command === "doctor") return doctorCommand(args);
  if (command === "live-verify") return liveVerifyCommand(args);
  throw new Error(`Unknown command: ${command}\n\n${CLI_HELP}`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${CLI_NAME}: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
