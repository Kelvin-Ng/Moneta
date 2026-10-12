#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncTimerUnits } from "../lib/sync-schedule.mjs";

try {
  if(process.platform!=="linux")throw new Error("This installer requires Linux with systemd. Run npm run sync from your platform's scheduler instead.");
  const options={root:fileURLToPath(new URL("../",import.meta.url)),nodeExecutable:process.execPath};
  for(const arg of process.argv.slice(2)) {
    const match=/^--(time|timezone)=(.+)$/.exec(arg);
    if(!match)throw new Error("Usage: npm run sync:schedule -- [--time=21:00] [--timezone=America/Los_Angeles]");
    options[match[1]]=match[2];
  }
  const units=syncTimerUnits(options);
  execFileSync("systemctl",["--user","show-environment"],{stdio:"ignore"});
  const directory=join(process.env.XDG_CONFIG_HOME||join(homedir(),".config"),"systemd/user");
  const files=[[join(directory,"moneta-sync.service"),units.service],[join(directory,"moneta-sync.timer"),units.timer]];
  for(const [path] of files) {
    try {
      const existing=await readFile(path,"utf8");
      if(!existing.startsWith("# Managed by Moneta's scripts/install-sync-timer.mjs."))
        throw new Error(`Refusing to overwrite an unmanaged unit: ${path}`);
    } catch(error) { if(error.code!=="ENOENT")throw error; }
  }
  await mkdir(directory,{recursive:true});
  for(const [path,contents] of files)await writeFile(path,contents,{mode:0o600});
  execFileSync("systemctl",["--user","daemon-reload"],{stdio:"inherit"});
  execFileSync("systemctl",["--user","enable","--now","moneta-sync.timer"],{stdio:"inherit"});
  console.log(`Daily sync enabled: ${units.calendar}`);
  console.log("Logs: journalctl --user -u moneta-sync.service");
} catch(error) {
  console.error(error.message);
  process.exitCode=1;
}
