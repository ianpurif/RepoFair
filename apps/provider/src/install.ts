import { readFile,stat } from 'node:fs/promises';
import { createAtlasDatabase } from '../../worker/src/database.ts';
import { independentProviderEnvironment,installProviderArtifact } from './runtime.ts';

try {
  const file = process.argv[2];if(!file || process.argv.length!==3)throw new Error('Signed artifact file required');
  const info = await stat(file);if(!info.isFile()||info.size>4_000_000)throw new Error('Invalid bounded source export');
  const artifact:unknown=JSON.parse(await readFile(file,'utf8'));const database=await createAtlasDatabase(independentProviderEnvironment(process.env));
  try {await installProviderArtifact(database,process.env,artifact);console.log('Owner-approved source export installed in the independent provider database.');} finally {await database.close();}
} catch {console.error('Publication installation failed: check the signed export, configured identity, issuer public key and independent provider database');process.exitCode=1;}
