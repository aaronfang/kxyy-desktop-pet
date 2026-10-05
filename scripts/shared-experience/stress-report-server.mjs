import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectForbiddenInstalledApps, supportsProcessIsolation } from "./process-isolation.mjs";

export function createStressReportReceiver({ outputPath, inspectIsolation = inspectForbiddenInstalledApps,
  supported = supportsProcessIsolation(), onStored = () => {} } = {}) {
  const maxBytes = 5 * 1024 * 1024;
  const monitorStartedAtMs = Date.now();
  const isolation = { supported, checks: 0, violations: [] };
  let isolationTimer;
  let result = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  function close(code = 0) {
    result = Math.max(result, code);
    clearInterval(isolationTimer);
    server.close(() => resolveClosed(result));
    server.closeAllConnections();
    return closed;
  }

  function checkIsolation() {
    if (!isolation.supported) return;
    const matches = inspectIsolation();
    isolation.checks += 1;
    for (const match of matches) {
      if (isolation.violations.length < 256) isolation.violations.push({ atMs: Date.now() - monitorStartedAtMs, pid: match.pid });
    }
    if (matches.length) throw new Error("installed app conflicts with dev stress test");
  }

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
    request.on("error", () => {
      void close(1);
    });
    request.on("end", () => {
      try {
        const report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        report.isolation = isolation;
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
        response.writeHead(201, { "Content-Type": "application/json" });
        response.end('{"stored":true}');
        onStored(outputPath);
        response.once("finish", () => { void close(); });
      } catch (error) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end('{"error":"report storage failed"}');
        response.once("finish", () => { void close(1); });
      }
    });
  });

  server.on("error", () => { void close(1); });
  return {
    closed, close,
    listen(port = 0) {
      return new Promise((resolveListen, reject) => {
        try { checkIsolation(); } catch (error) { reject(error); void close(1); return; }
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", reject);
          isolationTimer = setInterval(() => {
            try { checkIsolation(); } catch { void close(1); }
          }, 5000);
          resolveListen(`http://127.0.0.1:${server.address().port}/report`);
        });
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outputPath = resolve(process.argv[2] || "shared-experience-stress-report.json");
  const receiver = createStressReportReceiver({ outputPath, onStored: (output) => process.stdout.write(`REPORT_STORED ${output}\n`) });
  try {
    const url = await receiver.listen(Number(process.argv[3] || 17861));
    process.stdout.write(`REPORT_LISTENING ${url}\n`);
    process.exitCode = await receiver.closed;
  } catch {
    await receiver.close(1);
    process.stderr.write("report receiver failed\n");
    process.exitCode = 1;
  }
}
