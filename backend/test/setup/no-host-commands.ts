/**
 * Safety net: no test may run a command that touches the host PBX. The specs mock the
 * modules that shell out, but a mock that silently fails to apply (module registry, a
 * virtual mock of a real module, a spec that forgot one) would otherwise run the real
 * thing on whatever box the tests run on -- which is the production PBX. This makes any
 * such attempt throw instead, so the spec fails loudly and nothing is executed.
 *
 * Python subprocesses stay allowed: vad-runner.spec runs the real VAD script on WAVs it
 * writes itself.
 */

const BLOCKED = /\b(sudo|asterisk|fwconsole|retrieve_conf|systemctl|service|amportal)\b/;

/** Loud even when the caller swallows the error (reload helpers catch and log). */
function report(name: string, call: string): Error {
  const err = new Error(`test tried to run a host command (${name}): ${call} -- mock it`);
  // `expect` is not installed yet while setup files run; read it only if it exists.
  const state = typeof expect === 'undefined' ? null : expect.getState();
  process.stderr.write(`\n[no-host-commands] BLOCKED ${name}: ${call} in ${state?.testPath ?? '?'} :: ${state?.currentTestName ?? '?'}\n`);
  return err;
}

function describeCall(file: unknown, args: unknown): string {
  const argv = Array.isArray(args) ? args.map(String) : [];
  return [String(file), ...argv].join(' ');
}

function guard<T extends (...a: never[]) => unknown>(name: string, real: T): T {
  return function (this: unknown, ...a: unknown[]) {
    const call = name === 'exec' || name === 'execSync' ? String(a[0]) : describeCall(a[0], a[1]);
    if (BLOCKED.test(call)) throw report(name, call);
    return (real as unknown as (...x: unknown[]) => unknown).apply(this, a);
  } as unknown as T;
}

// The real module object (an `import * as` namespace is read-only getters), so every
// module that imports child_process afterwards gets the guarded functions.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require('child_process') as Record<string, (...a: never[]) => unknown>;
for (const name of ['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']) {
  const real = cp[name];
  // Keep util.promisify(execFile) working: it reads the custom promisify symbol.
  const wrapped = guard(name, real);
  const custom = (real as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')];
  if (custom) {
    const c = custom as (...x: unknown[]) => unknown;
    (wrapped as unknown as Record<symbol, unknown>)[Symbol.for('nodejs.util.promisify.custom')] = function (this: unknown, ...a: unknown[]) {
      const call = describeCall(a[0], a[1]);
      if (BLOCKED.test(call)) return Promise.reject(report(name, call));
      return c.apply(this, a);
    };
  }
  cp[name] = wrapped;
}

// The same for the database: point every pool at a closed local port before any module
// loads (dotenv never overrides a variable that is already set), so a spec whose db mock
// did not apply fails with ECONNREFUSED instead of reading or writing a real database.
process.env.OPDESK_ENV_FILE = '/dev/null';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '1';
process.env.DB_USER = 'opdesk-test';
process.env.DB_PASSWORD = '';
process.env.AMI_HOST = process.env.AMI_HOST || '127.0.0.1';
