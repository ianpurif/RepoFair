import 'server-only';
import { createAtlasDatabase } from '@atlas/worker/database';

let database:ReturnType<typeof createAtlasDatabase>|undefined;
/** One bounded pool per application process; service modules share this connection boundary. */
export function workspaceDatabase() {return database??=createAtlasDatabase(process.env).catch(error=>{database=undefined;throw error;});}
