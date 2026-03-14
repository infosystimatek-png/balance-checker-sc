import server from "./app.js";
import { config } from "./config.js";

const PORT = config.port;
server.listen(PORT, () => {
  console.log(`TRON DelegaPay backend running at http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/health`);
  console.log(`WebSocket: ws://localhost:${PORT}/ws`);
});
