import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.argv[2];
if (scenario === "failed") process.exit(23);
if (scenario === "slow") await delay(150);

const write = (text) => process.stdout.write(text);
let input = "";
let task;
let confirming = false;

function submit(text) {
  if (text === "work") {
    task = setTimeout(() => write("TASK FINISHED\n"), 2000);
    write("TASK STARTED\n");
  } else if (text === "confirm") {
    confirming = true;
    write("CONFIRM? [Enter/Escape]\n");
  } else if (text === "environment") {
    write(`ENV ${Object.keys(process.env).sort().join(",")}\n`);
  } else if (text === "descendant") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    child.unref();
    write(`DESCENDANT ${child.pid}\n`);
  } else if (text === "exit") {
    write("fixture@terminal:~$\n");
    process.stdin.pause();
    process.stdout.write("FIXTURE END\n", () => process.exit(0));
  } else if (text.length > 80) {
    write("[long paste]\n");
  } else {
    write(`INPUT ${text}\n`);
  }
}

process.stdout.on("resize", () => write(`SIZE ${process.stdout.columns}x${process.stdout.rows}\n`));
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const char of chunk) {
    if (confirming) {
      if (char !== "\r" && char !== "\x1b") continue;
      confirming = false;
      write(char === "\r" ? "CONFIRMED\n>\n" : "DECLINED\n>\n");
    } else if (char === "\r") {
      submit(input.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, ""));
      input = "";
    } else if (char === "\x03") {
      clearTimeout(task);
      write("TASK CANCELLED\n>\n");
    } else {
      input += char;
    }
  }
});

write("\x1b[?2004hFIXTURE READY\n>\n");
for (const text of ["FIRST \\ frame", "SECOND \u00a3 frame", "THIRD frame"]) {
  await delay(30);
  write(`${text}\n`);
}
