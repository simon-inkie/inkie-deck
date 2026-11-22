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
    void runnerLifecycle.shutdown().catch(() => {
      console.error("[prod] Could not stop the PTY runner safely.");
      process.exitCode = 1;
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
