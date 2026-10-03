import { AtlasFixtureClient } from '../src/fixture.ts';
const client = new AtlasFixtureClient();
const answer = await client.question('jobboard-app@1.0.0', 'How are failed jobs retried?');
console.log(JSON.stringify(answer, null, 2));
