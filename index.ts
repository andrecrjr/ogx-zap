import { startServer } from "./src/server";

export { createApp, startServer } from "./src/server";

if (import.meta.main) {
  startServer();
}
