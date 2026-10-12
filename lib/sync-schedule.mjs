import { isAbsolute, join } from "node:path";

const quote=value=>JSON.stringify(value).replace(/%/g,"%%");
const executableArgument=value=>quote(value).replace(/\$/g,()=>"$$");

export function syncTimerUnits({root,nodeExecutable,time="21:00",timezone="America/Los_Angeles"}) {
  if(!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))throw new Error("Time must be HH:MM in 24-hour format.");
  if(!/^[A-Za-z0-9_+/-]+$/.test(timezone))throw new Error("Invalid timezone.");
  new Intl.DateTimeFormat("en",{timeZone:timezone});
  if([root,nodeExecutable].some(value=>!value||!isAbsolute(value)||/[\r\n\0]/.test(value)))throw new Error("Invalid program path.");
  const marker="# Managed by Moneta's scripts/install-sync-timer.mjs.\n";
  const calendar=`*-*-* ${time}:00 ${timezone}`;
  return {
    calendar,
    service:`${marker}[Unit]
Description=Sync Moneta's connected financial accounts

[Service]
Type=oneshot
WorkingDirectory=${quote(root).slice(1,-1)}
ExecStart=${executableArgument(nodeExecutable)} ${executableArgument(join(root,"scripts/sync.mjs"))}
TimeoutStartSec=1h
UMask=0077
NoNewPrivileges=yes
StandardOutput=journal
StandardError=journal
SyslogIdentifier=moneta-sync
`,
    timer:`${marker}[Unit]
Description=Sync Moneta daily at ${time} ${timezone}

[Timer]
OnCalendar=${calendar}
Persistent=true
AccuracySec=1s

[Install]
WantedBy=timers.target
`
  };
}
