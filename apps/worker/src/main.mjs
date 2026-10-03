const supported = process.argv.includes('--check');
if (supported) {
  console.log(JSON.stringify({component:'atlas-worker',status:'not-implemented',jobsExecuted:0,required:'Implement durable scoped PostgreSQL job processing in P0/P1.'},null,2));
} else {
  console.error('The worker job loop is not implemented. Use --check for status; no jobs were executed.');
  process.exitCode = 2;
}
