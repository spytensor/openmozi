#!/usr/bin/env node

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
  };
}

async function writeProbe(filePath, label) {
  try {
    await fs.writeFile(filePath, `${label}\n${new Date().toISOString()}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, path: filePath, error: serializeError(error) };
  }
}

const grantedPath = argValue("--granted-path") ?? process.env.MOZI_B05_GRANTED_PATH;
const outsidePath =
  argValue("--outside-path") ??
  process.env.MOZI_B05_OUTSIDE_PATH ??
  path.join(os.homedir(), "Documents", "mozi-should-fail.txt");

const startedAt = new Date().toISOString();
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const nodeMajorOk = nodeMajor === 22;

if (!grantedPath) {
  console.log(
    JSON.stringify(
      {
        verdict: "fail",
        reason: "missingGrantedPath",
        startedAt,
        node: process.version,
        nodeMajorOk,
      },
      null,
      2,
    ),
  );
  process.exit(2);
}

const nonce = `${process.pid}-${Date.now()}`;
const insidePath = path.join(grantedPath, `.mozi-b05-grant-check-${nonce}.txt`);

const inside = await writeProbe(insidePath, "mozi-b05-inside-grant");
const outside = await writeProbe(outsidePath, "mozi-b05-outside-denial-probe");

let outsideCleanup;
if (outside.ok) {
  try {
    await fs.unlink(outsidePath);
    outsideCleanup = { attempted: true, ok: true };
  } catch (error) {
    outsideCleanup = { attempted: true, ok: false, error: serializeError(error) };
  }
}

const outsideDenied =
  !outside.ok &&
  ["EACCES", "EPERM", "EROFS"].includes(outside.error?.code);

const verdict = nodeMajorOk && inside.ok && outsideDenied ? "pass" : "fail";

const result = {
  verdict,
  startedAt,
  finishedAt: new Date().toISOString(),
  node: process.version,
  nodeExecPath: process.execPath,
  nodeMajorOk,
  platform: process.platform,
  arch: process.arch,
  pid: process.pid,
  cwd: process.cwd(),
  home: os.homedir(),
  grantedPath,
  inside,
  outside: {
    ...outside,
    denied: outsideDenied,
    cleanup: outsideCleanup,
  },
};

console.log(JSON.stringify(result, null, 2));
process.exit(verdict === "pass" ? 0 : 2);
