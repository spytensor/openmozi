import { execFile } from 'node:child_process';
import { constants, existsSync, accessSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveNativeOfficeEnvironment } from '../artifacts/office-native.js';
import { applyManagedPythonEnv, readEnvManifest, resolveManagedPythonEnv } from './python-env.js';

const execFileAsync = promisify(execFile);
const DOCUMENT_MODULES = ['docx', 'openpyxl', 'pptx', 'pdfplumber', 'reportlab', 'PIL', 'numpy', 'pandas'];

export interface DesktopCommandProbe {
  (command: string, args: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv): Promise<boolean>;
}

export function resolveExecutable(command: string, pathValue = process.env.PATH ?? ''): string | null {
  const candidates = isAbsolute(command)
    ? [command]
    : pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function defaultProbe(command: string, args: string[], timeoutMs = 3_000, env?: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await execFileAsync(command, args, { timeout: timeoutMs, maxBuffer: 256 * 1024, ...(env ? { env } : {}) });
    return true;
  } catch {
    return false;
  }
}

export async function buildDesktopCapabilitySnapshot(options: {
  env?: NodeJS.ProcessEnv;
  probe?: DesktopCommandProbe;
  fetchImpl?: typeof fetch;
} = {}) {
  const env = options.env ?? process.env;
  const pathValue = env.PATH ?? '';
  const probe = options.probe ?? defaultProbe;
  const fetchImpl = options.fetchImpl ?? fetch;
  const binaries = Object.fromEntries(
    ['git', 'python3', 'soffice', 'pdftoppm', 'pdftotext', 'pdfimages', 'docker', 'codex', 'claude', 'gemini', 'node', 'pnpm']
      .map((name) => [name, resolveExecutable(name, pathValue)]),
  ) as Record<string, string | null>;
  if (env.MOZI_PYTHON) {
    binaries.python3 = resolveExecutable(env.MOZI_PYTHON, pathValue);
  }

  // Readiness must execute the *effective* environment, not a cleaner one.
  // Previously this probe inherited the server's env (no PYTHONPATH) while
  // shell_exec injected a package overlay, so the two tested different
  // environments: the probe could report the document stack healthy while every
  // shell import failed on a foreign-architecture overlay — and could equally
  // miss skill-provisioned packages that shell could import. Resolving the same
  // managed environment here keeps readiness honest (Issue #702 root cause 4).
  const managedPythonEnv = await resolveManagedPythonEnv(env);
  const pythonProbeEnv = applyManagedPythonEnv(
    { PATH: pathValue },
    managedPythonEnv && existsSync(managedPythonEnv.envDir) ? managedPythonEnv.envDir : null,
    managedPythonEnv?.interpreter,
  );

  // Avoid launching every cold CLI at once. Python's document stack and
  // LibreOffice both perform substantial first-run loading on Finder launch;
  // probing them concurrently can make healthy tools time out each other.
  const pythonModules = binaries.python3
    ? await probe(binaries.python3, ['-c', `import ${DOCUMENT_MODULES.join(', ')}`], 20_000, pythonProbeEnv)
    : false;
  const sofficeUsable = binaries.soffice
    ? await probe(binaries.soffice, ['--headless', '--version'], 5_000)
    : false;
  const [popplerUsable, dockerDaemon, codexUsable, claudeUsable] = await Promise.all([
    binaries.pdftoppm ? probe(binaries.pdftoppm, ['-v'], 3_000) : false,
    binaries.docker ? probe(binaries.docker, ['version', '--format', '{{.Server.Version}}'], 3_000) : false,
    binaries.codex ? probe(binaries.codex, ['--version'], 3_000) : false,
    binaries.claude ? probe(binaries.claude, ['--version'], 3_000) : false,
  ]);

  const office = resolveNativeOfficeEnvironment(env);
  let officeAvailable = false;
  let officeReason = office ? 'health_unreachable' : 'not_configured';
  if (office) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetchImpl(`${office.internalUrl}/healthcheck`, { signal: controller.signal, redirect: 'error' });
      officeAvailable = response.ok;
      officeReason = response.ok ? 'healthy' : `health_http_${response.status}`;
    } catch (error) {
      officeReason = error instanceof Error && error.name === 'AbortError' ? 'health_timeout' : 'health_unreachable';
    } finally {
      clearTimeout(timeout);
    }
  }

  const workerCredentialPaths = {
    codex: join(homedir(), '.codex', 'auth.json'),
    claude: join(homedir(), '.claude', '.credentials.json'),
  };

  return {
    generated_at: new Date().toISOString(),
    desktop_mode: env.MOZI_DESKTOP === '1',
    path_entries: pathValue.split(delimiter).filter(Boolean),
    native: {
      binaries,
      binary_checks: { soffice: sofficeUsable, poppler: popplerUsable },
      document_python_modules: pythonModules,
      document_generation: Boolean(binaries.python3 && pythonModules),
      // Identity of the environment this snapshot actually probed, so evidence
      // records *which* runtime was verified rather than just a green boolean.
      python_runtime: managedPythonEnv
        ? {
            env_id: managedPythonEnv.envId,
            interpreter: managedPythonEnv.interpreter,
            python_version: managedPythonEnv.fingerprint.python_version,
            arch: managedPythonEnv.fingerprint.arch,
            overlay_dir: existsSync(managedPythonEnv.envDir) ? managedPythonEnv.envDir : null,
            // Specs the provisioner recorded only after they verifiably imported.
            overlay_packages: existsSync(managedPythonEnv.envDir)
              ? Object.keys(readEnvManifest(managedPythonEnv).installed)
              : [],
          }
        : null,
      document_preview: sofficeUsable && popplerUsable,
      desktop_control: process.platform === 'darwin',
    },
    managed_workers: {
      codex: { ready: Boolean(codexUsable && existsSync(workerCredentialPaths.codex)), command: binaries.codex, credential_path: workerCredentialPaths.codex },
      claude: { ready: Boolean(claudeUsable && existsSync(workerCredentialPaths.claude)), command: binaries.claude, credential_path: workerCredentialPaths.claude },
    },
    enhanced: {
      docker: { available: dockerDaemon, command: binaries.docker, mode: dockerDaemon ? 'enhanced' : 'unavailable' },
      office: {
        configured: Boolean(office),
        available: officeAvailable,
        engine: office ? 'onlyoffice' : null,
        mode: officeAvailable ? 'enhanced' : 'fallback',
        reason: officeReason,
      },
    },
  };
}
