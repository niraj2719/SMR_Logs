import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Hardware Manager ---
// This class handles the abstraction between Simulated and Real CAN data
class HardwareManager {
  private isRunning: boolean = false;
  private interval: NodeJS.Timeout | null = null;
  private broadcastCallback: (frame: any) => void;

  constructor(broadcastCallback: (frame: any) => void) {
    this.broadcastCallback = broadcastCallback;
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log("CAN Communication Started");

    // SIMULATION MODE (Default for Cloud)
    // When running locally with an IXXAT tool, you would replace this 
    // with a real listener (e.g., using 'socketcan' or a vendor SDK)
    this.interval = setInterval(() => {
      this.generateSimulatedFrame();
    }, 200);
  }

  stop() {
    this.isRunning = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    console.log("CAN Communication Stopped");
  }

  // This method allows external tools (like a local IXXAT bridge) 
  // to inject real frames into the dashboard
  injectRealFrame(id: string, data: string[]) {
    this.broadcastCallback({
      type: 'CAN_FRAME',
      payload: {
        id,
        data,
        timestamp: Date.now()
      }
    });
  }

  private generateSimulatedFrame() {
    // Simulate SMR Charger Data (Voltage/Current)
    const frames = [
      { id: '28F3FF0', data: ['0F', 'A0', '00', 'C8', '0F', 'B0', '1A', '01'] }, // ~400V, 20A
      { id: '28E01F0', data: ['0F', 'A5', '00', '00', '07', 'D0', '2D', '05'] }  // Status/Temp
    ];
    
    const frame = frames[Math.floor(Math.random() * frames.length)];
    
    // Add some jitter to simulation
    if (frame.id === '28F3FF0') {
      const v = 3990 + Math.floor(Math.random() * 20);
      frame.data[0] = (v >> 8).toString(16).padStart(2, '0').toUpperCase();
      frame.data[1] = (v & 0xFF).toString(16).padStart(2, '0').toUpperCase();
    }

    this.broadcastCallback({
      type: 'CAN_FRAME',
      payload: {
        ...frame,
        timestamp: Date.now()
      }
    });
  }
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });
  const PORT = 3000;

  // Broadcast helper
  const broadcast = (message: any) => {
    const data = JSON.stringify(message);
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  };

  const hardware = new HardwareManager(broadcast);

  wss.on("connection", (ws) => {
    console.log("Client connected to VoltCAN WebSocket");
    
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        switch (message.type) {
          case 'START_COMM':
            hardware.start();
            break;
          case 'STOP_COMM':
            hardware.stop();
            break;
          case 'INJECT_FRAME':
            // This allows a local bridge to send real IXXAT data
            hardware.injectRealFrame(message.payload.id, message.payload.data);
            break;
        }
      } catch (e) {
        console.error("WS Message Error:", e);
      }
    });

    ws.on("close", () => {
      console.log("Client disconnected");
    });
  });

  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`VoltCAN Server running on http://localhost:${PORT}`);
  });
}

startServer();
