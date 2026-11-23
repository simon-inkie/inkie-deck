import path from "node:path";
import { pathToFileURL } from "node:url";
import { warnNetworkBind } from "./bind-host.mjs";

process.env.NODE_ENV ??= "production";
const [{ default: express }, { default: compression }, { default: morgan }, { createRequestHandler }] =
  await Promise.all([
    import("express"),
    import("compression"),
    import("morgan"),
    import("@react-router/express"),
  ]);

const build = await import(pathToFileURL(path.resolve(process.argv[2] ?? "build/server/index.js")).href);
const { runnerLifecycle } = build.entry.module;
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || "4242");
const app = express();
app.disable("x-powered-by");
app.use(compression());
app.use(path.posix.join(build.publicPath, "assets"), express.static(path.join(build.assetsBuildDirectory, "assets"), {
  immutable: true,
  maxAge: "1y",
}));
app.use(build.publicPath, express.static(build.assetsBuildDirectory));
app.use(express.static("public", { maxAge: "1h" }));
app.use(morgan("tiny"));
app.all("*", createRequestHandler({
  build,
  getLoadContext: (request) => ({ socketAddress: request.socket.remoteAddress }),
}));

let server;
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server?.close();
    // Major 7 (Round 16): Bound process exit after runnerLifecycle.shutdown() so an unkillable
    // child or lingering inherited pipe handle can never keep the production server alive forever.
    const hardExitTimer = setTimeout(() => process.exit(process.exitCode ?? 0), 3000);
    hardExitTimer.unref();
    void runnerLifecycle.shutdown()
      .catch(() => {
        console.error("[prod] Could not stop the runner safely.");
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(hardExitTimer);
        process.exit(process.exitCode ?? 0);
      });
  });
}
await runnerLifecycle.recover();
if (!shuttingDown) {
  warnNetworkBind("prod", host);
  server = app.listen(port, host, () => {
    console.log(`[prod] listening on ${host}, port ${server.address().port}`);
  });
}
