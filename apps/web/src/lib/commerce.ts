import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { createCommerceService } from '@atlas/worker/commerce';
import { createPublicationRegistry } from '@atlas/worker/publication-registry';
import { workspaceDatabase } from './database';

let services:Promise<{registry:ReturnType<typeof createPublicationRegistry>;commerce:ReturnType<typeof createCommerceService>}>|undefined;
export async function commerceServices() {
  services??=workspaceDatabase().then(database=>({registry:createPublicationRegistry(database,process.env),commerce:createCommerceService(database,process.env)})).catch(error=>{services=undefined;throw error;});
  return services;
}
export async function commerceContext() {
  const {userId,sessionId}=await auth();if(!userId||!sessionId)throw new Error('AUTHENTICATION_REQUIRED');
  return {principalId:userId,sessionId,...await commerceServices()};
}
