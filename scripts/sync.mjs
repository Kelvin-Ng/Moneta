#!/usr/bin/env node

const args=process.argv.slice(2);
if(args.length) {
  if(args.length===1&&["--help","-h"].includes(args[0])) {
    console.log("Usage: npm run sync\nSync all saved Plaid connections directly with SQLite; no web server is required.");
  } else {
    console.error("Usage: npm run sync");
    process.exitCode=2;
  }
} else {
  const log=event=>console.log(JSON.stringify({time:new Date().toISOString(),...event}));
  let closeDatabase;
  try {
    const core=await import("../server.mjs");
    closeDatabase=core.closeDatabase;
    const result=await core.syncAllPlaidItems({onProgress:log});
    log({event:"sync_complete",connections:result.results.length,failed:result.failed});
    if(result.failed)process.exitCode=1;
  } catch(error) {
    // Do not log source payloads, credentials, or provider request bodies.
    log({event:"sync_failed",code:error.code||"SYNC_ERROR"});
    process.exitCode=1;
  } finally { closeDatabase?.(); }
}
