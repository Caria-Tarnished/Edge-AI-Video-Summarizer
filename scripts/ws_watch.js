const WebSocket = require("ws");

const jobId = process.argv[2];
const base = process.argv[3] || "ws://127.0.0.1:8001";

if (!jobId) {
  console.error("Usage: node ws_watch.js <JOB_ID> [WS_BASE]");
  process.exit(2);
}

const ws = new WebSocket(`${base}/ws/jobs/${jobId}`);

ws.on("open", () => {
  console.log("connected");
});

ws.on("message", (msg) => {
  console.log(msg.toString());
});

ws.on("close", (code) => {
  console.log("closed", code);
  process.exit(0);
});

ws.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

setInterval(() => {
  try {
    ws.send("ping");
  } catch {}
}, 5000);
