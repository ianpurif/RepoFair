import { createVercelProviderHandler } from '../src/vercel.ts';

const handle = createVercelProviderHandler(process.env);

/** Standard Node Web handler; project rewrites forward the provider routes here. */
export default {
  fetch(request: Request): Promise<Response> {
    return handle(request);
  },
};
