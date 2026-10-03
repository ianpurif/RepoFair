# SDK scope

The supplied `@atlas/sdk` is a starter-only client for the source scaffold's capability endpoint. It validates the origin, bounds the response, sets a timeout, rejects redirects and checks the returned capability shape. It is not a general provider client or an MCP implementation.

After bootstrap and starting the web scaffold:

```ts
import { ChronosAtlasClient } from '@atlas/sdk';
const atlas = new ChronosAtlasClient('http://localhost:3000', {
  allowLocalDevelopment: true,
});
console.log(await atlas.capabilities());
```

Implement repository/graph/context/provider/purchase/recovery methods during P1–P5, with shared runtime schemas and explicit authorization. A future headless purchase method accepts a caller-controlled signer; do not automatically derive signing authority from a model request.

Do not publish the package until the user authorizes publication and the interface/release gates pass.
