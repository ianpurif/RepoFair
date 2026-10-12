import { spawnSync } from 'node:child_process';
import { ROOT } from './lib.mjs';
import { checkProductionEnvironment } from './verify-production-env.mjs';

const problems = checkProductionEnvironment(process.env);
if (problems.length) {
  console.error(`Vercel production configuration blocked: ${problems.join('; ')}`);
  process.exitCode = 1;
} else {
  const child = spawnSync(process.execPath, ['scripts/web.mjs', 'build'], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exitCode = child.status ?? 1;
}
