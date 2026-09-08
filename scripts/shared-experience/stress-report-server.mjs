import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stopForbiddenInstalledApps } from "./process-isolation.mjs";

const outputPath = resolve(process.argv[2] || "shared-experience-stress-report.json");
const port = Number(process.argv[3] || 17861);
const maxBytes = 5 * 1024 * 1024;
const monitorStartedAtMs = Date.now();
const isolation = { checks: 0, violations: [] };

function checkIsolation() {
  isolation.checks += 1;
  for (const match of stopForbiddenInstalledApps()) {
    isolation.violations.push({ atMs: Date.now() - monitorStartedAtMs, pid: match.pid });
  }
}

checkIsolation();
const isolationTimer = setInterval(checkIsolation, 5_000);

const server = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/report") {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) request.destroy(new Error("report too large"));
    else chunks.push(chunk);
  });
  request.on("end", () => {
    try {
      const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      report.isolation = isolation;
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end('{"stored":true}');
      process.stdout.write(`REPORT_STORED ${outputPath}\n`);
      clearInterval(isolationTimer);
      server.close();
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error?.message || error) }));
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`REPORT_LISTENING http://127.0.0.1:${port}/report\n`);
});
