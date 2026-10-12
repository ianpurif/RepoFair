/** Independent provider schema only. Never apply these files to Atlas's central database. */
export const PROVIDER_MIGRATIONS = Object.freeze([
  '202610070005_provider_replay.sql',
  '202610070006_provider_ledger.sql',
  '202610110003_provider_delivery.sql',
]);
