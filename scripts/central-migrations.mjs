/** Central Atlas schema only. Provider payment migrations belong to another database. */
export const CENTRAL_MIGRATIONS = Object.freeze([
  '202610030001_atlas.sql',
  '202610070001_personal_workspaces.sql',
  '202610070002_github_jobs.sql',
  '202610070003_server_repository_grants.sql',
  '202610070004_publication_drafts.sql',
  '202610110001_resumable_imports.sql',
  '202610110002_publication_commerce.sql',
]);
