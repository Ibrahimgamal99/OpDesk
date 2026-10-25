/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  // No test may run sudo/asterisk/fwconsole on the host: see test/setup/no-host-commands.ts.
  setupFiles: ['<rootDir>/test/setup/no-host-commands.ts'],
};
