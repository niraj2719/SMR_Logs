/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { 
  Activity, 
  Zap, 
  Thermometer, 
  Settings, 
  Play, 
  Square, 
  Download, 
  Search, 
  FileCode, 
  AlertTriangle,
  Database,
  Terminal,
  Cpu,
  Wind
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import * as d3 from 'd3';

// --- Types ---

interface CanFrame {
  id: string;
  data: string[];
  timestamp: number;
  decoded?: DecodedData;
}

interface DecodedData {
  voltage: number;
  current: number;
  power: number;
  temperature: number;
  fanSpeed: number;
  state: string;
  faults: string[];
}

interface TelemetryPoint {
  time: string;
  voltage: number;
  current: number;
  power: number;
  temperature: number;
}

// --- Constants & Mock Data ---

const BITRATE = "125 kbps";
const PROTOCOL = "CAN 2.0B Extended";

const INITIAL_FRAMES: CanFrame[] = [];

// --- Components ---

const Gauge = ({ value, min, max, label, unit, color = "#10b981" }: { value: number, min: number, max: number, label: string, unit: string, color?: string }) => {
  const ref = React.useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const svg = d3.select(ref.current);
    svg.selectAll("*").remove();

    const width = 200;
    const height = 120;
    const radius = 90;
    
    const g = svg.append("g")
      .attr("transform", `translate(${width / 2}, ${height - 10})`);

    const arc = d3.arc()
      .innerRadius(65)
      .outerRadius(radius)
      .startAngle(-Math.PI / 2)
      .endAngle(Math.PI / 2);

    // Background arc
    g.append("path")
      .attr("d", arc as any)
      .attr("fill", "#1f2937");

    // Value arc
    const percent = Math.max(0, Math.min(1, (value - min) / (max - min)));
    const valueArc = d3.arc()
      .innerRadius(65)
      .outerRadius(radius)
      .startAngle(-Math.PI / 2)
      .endAngle(-Math.PI / 2 + (Math.PI * percent));

    g.append("path")
      .attr("d", valueArc as any)
      .attr("fill", color)
      .style("transition", "all 0.5s ease");

    // Text
    g.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "-10")
      .attr("class", "text-2xl font-bold fill-white font-mono")
      .text(`${value.toFixed(1)}`);

    g.append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "15")
      .attr("class", "text-xs fill-gray-400 uppercase tracking-widest")
      .text(`${unit}`);

  }, [value, min, max, color, unit]);

  return (
    <div className="flex flex-col items-center bg-zinc-900/50 p-4 rounded-2xl border border-white/5">
      <span className="text-[10px] uppercase tracking-widest text-zinc-500 mb-2 font-semibold">{label}</span>
      <svg ref={ref} width="200" height="120" />
    </div>
  );
};

const StatusBadge = ({ label, active, color = "emerald" }: { label: string, active: boolean, color?: string }) => (
  <div className={`flex items-center gap-2 px-3 py-1 rounded-full border text-[10px] font-bold uppercase tracking-tighter transition-all ${
    active 
      ? `bg-${color}-500/10 border-${color}-500/30 text-${color}-400 shadow-[0_0_10px_rgba(16,185,129,0.1)]` 
      : "bg-zinc-800/50 border-zinc-700/50 text-zinc-500"
  }`}>
    <div className={`w-1.5 h-1.5 rounded-full ${active ? `bg-${color}-500 animate-pulse` : "bg-zinc-600"}`} />
    {label}
  </div>
);

export default function App() {
  const [frames, setFrames] = useState<CanFrame[]>(INITIAL_FRAMES);
  const [telemetry, setTelemetry] = useState<TelemetryPoint[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<'dashboard' | 'monitor' | 'reverse' | 'control'>('dashboard');
  const [targetVoltage, setTargetVoltage] = useState(400);
  const [targetCurrent, setTargetCurrent] = useState(20);

  // Decoding Logic based on SMR Protocol
  const decodeFrame = useCallback((id: string, data: string[]): DecodedData | null => {
    const bytes = data.map(b => parseInt(b, 16));
    
    // Example Mapping for Infypower/SMR Modules
    if (id === '28F3FF0' || id === '28F3F01') {
      const voltage = (bytes[0] << 8 | bytes[1]) * 0.1;
      const current = (bytes[2] << 8 | bytes[3]) * 0.1;
      const inputVolt = (bytes[4] << 8 | bytes[5]) * 0.1;
      const temp = bytes[6] - 40;
      
      return {
        voltage,
        current,
        power: (voltage * current) / 1000,
        temperature: temp,
        fanSpeed: 0, // Not in this frame
        state: bytes[7] === 0 ? "STANDBY" : "CHARGING",
        faults: []
      };
    }

    if (id === '28E01F0') {
      const voltage = (bytes[0] << 8 | bytes[1]) * 0.1;
      const current = (bytes[4] << 8 | bytes[5]) * 0.01;
      return {
        voltage,
        current,
        power: (voltage * current) / 1000,
        temperature: bytes[6] - 40,
        fanSpeed: bytes[7] * 50,
        state: "MONITORING",
        faults: []
      };
    }

    return null;
  }, []);

  const [socket, setSocket] = useState<WebSocket | null>(null);

  // WebSocket Connection
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("Connected to VoltCAN Backend");
      setSocket(ws);
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'CAN_FRAME') {
          const { id, data, timestamp } = message.payload;
          const decoded = decodeFrame(id, data);
          
          const newFrame: CanFrame = {
            id,
            data,
            timestamp,
            decoded: decoded || undefined
          };

          setFrames(prev => [newFrame, ...prev.slice(0, 99)]);

          if (decoded) {
            setTelemetry(prev => {
              const newPoint = {
                time: new Date(timestamp).toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }),
                voltage: decoded.voltage,
                current: decoded.current,
                power: decoded.power,
                temperature: decoded.temperature
              };
              return [...prev, newPoint].slice(-50);
            });
          }
        }
      } catch (e) {
        console.error("WS Data Error:", e);
      }
    };

    ws.onclose = () => {
      console.log("Disconnected from VoltCAN Backend");
      setSocket(null);
      setIsRunning(false);
    };

    return () => ws.close();
  }, [decodeFrame]);

  // Handle Start/Stop via WebSocket
  const toggleComm = () => {
    if (!socket) return;
    
    const newState = !isRunning;
    setIsRunning(newState);
    
    socket.send(JSON.stringify({
      type: newState ? 'START_COMM' : 'STOP_COMM'
    }));
  };

  const injectFrame = (id: string, dataStr: string) => {
    if (!isRunning) return;
    
    const data = dataStr.trim().split(/\s+/);
    if (data.length !== 8) return;

    const now = Date.now();
    const decoded = decodeFrame(id, data);
    
    const newFrame: CanFrame = {
      id,
      data,
      timestamp: now,
      decoded: decoded || undefined
    };

    setFrames(prev => [newFrame, ...prev.slice(0, 99)]);

    if (decoded) {
      setTelemetry(prev => {
        const newPoint = {
          time: new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }),
          voltage: decoded.voltage,
          current: decoded.current,
          power: decoded.power,
          temperature: decoded.temperature
        };
        return [...prev, newPoint].slice(-50);
      });
    }
  };

  // Simulation Logic (Removed)
  useEffect(() => {
    // Logic moved to backend
  }, [isRunning]);

  const clearData = () => {
    setFrames([]);
    setTelemetry([]);
  };

  const currentStats = useMemo(() => {
    if (telemetry.length === 0) return { voltage: 0, current: 0, power: 0, temperature: 0 };
    return telemetry[telemetry.length - 1];
  }, [telemetry]);

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header / Nav */}
      <header className="border-b border-white/5 bg-black/40 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-[1600px] mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 bg-emerald-500 rounded-xl flex items-center justify-center shadow-[0_0_20px_rgba(16,185,129,0.3)]">
              <Zap className="text-black fill-black" size={20} />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">VoltCAN <span className="text-emerald-500">PRO</span></h1>
              <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-semibold">EV Power Electronics Diagnostic Suite</p>
            </div>
          </div>

          <nav className="flex items-center gap-1 bg-zinc-900/50 p-1 rounded-xl border border-white/5">
            {[
              { id: 'dashboard', icon: Activity, label: 'Dashboard' },
              { id: 'monitor', icon: Terminal, label: 'CAN Monitor' },
              { id: 'reverse', icon: Search, label: 'Reverse Eng' },
              { id: 'control', icon: Settings, label: 'Control' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                  activeTab === tab.id 
                    ? "bg-emerald-500 text-black shadow-lg" 
                    : "text-zinc-400 hover:text-white hover:bg-white/5"
                }`}
              >
                <tab.icon size={14} />
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-4">
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold">Comm Control</span>
              <div className="flex gap-2 mt-1">
                <button 
                  onClick={toggleComm}
                  className={`px-3 py-1 rounded text-[10px] font-bold uppercase tracking-tighter transition-all flex items-center gap-2 ${
                    isRunning 
                      ? "bg-red-500/10 text-red-500 border border-red-500/30 hover:bg-red-500/20" 
                      : "bg-emerald-500 text-black shadow-[0_0_15px_rgba(16,185,129,0.4)]"
                  }`}
                >
                  {isRunning ? <Square size={10} fill="currentColor" /> : <Play size={10} fill="currentColor" />}
                  {isRunning ? "Stop Comm" : "Start Comm"}
                </button>
                <button 
                  onClick={clearData}
                  className="px-3 py-1 bg-zinc-800 hover:bg-zinc-700 rounded text-[10px] font-bold uppercase tracking-tighter border border-white/5 text-zinc-400"
                >
                  Clear Data
                </button>
              </div>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold">Manual Injector</span>
              <div className="flex gap-2 mt-1">
                <button 
                  disabled={!isRunning}
                  onClick={() => injectFrame('28F3FF0', '12 05 00 00 45 9C 40 00')}
                  className={`px-2 py-1 rounded text-[10px] font-mono border border-white/5 transition-all ${
                    isRunning ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300" : "bg-zinc-900 text-zinc-700 cursor-not-allowed"
                  }`}
                >
                  Inject 28F3FF0
                </button>
                <button 
                  disabled={!isRunning}
                  onClick={() => injectFrame('28E01F0', '11 08 00 00 42 10 A0 00')}
                  className={`px-2 py-1 rounded text-[10px] font-mono border border-white/5 transition-all ${
                    isRunning ? "bg-zinc-800 hover:bg-zinc-700 text-zinc-300" : "bg-zinc-900 text-zinc-700 cursor-not-allowed"
                  }`}
                >
                  Inject 28E01F0
                </button>
              </div>
            </div>
            <div className="flex flex-col items-end">
              <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold">Interface Status</span>
              <div className="flex gap-2 mt-1">
                <StatusBadge label="IXXAT USB-to-CAN" active={isRunning} />
                <StatusBadge label={BITRATE} active={isRunning} color="blue" />
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto p-6">
        <AnimatePresence mode="wait">
          {activeTab === 'dashboard' && (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-6"
            >
              {/* Gauges Row */}
              {telemetry.length === 0 ? (
                <div className="col-span-full bg-zinc-900/30 border border-dashed border-white/10 rounded-2xl p-12 flex flex-col items-center justify-center text-center">
                  <div className="w-12 h-12 bg-zinc-800 rounded-full flex items-center justify-center mb-4 text-zinc-500">
                    <Activity size={24} className={isRunning ? "animate-pulse" : ""} />
                  </div>
                  <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest">Waiting for CAN Data...</h3>
                  <p className="text-xs text-zinc-600 mt-2 max-w-xs">
                    {isRunning 
                      ? "Communication is active. Use the manual injector or connect your IXXAT tool to begin monitoring." 
                      : "Communication is stopped. Click 'Start Comm' to begin."}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <Gauge value={currentStats.voltage} min={0} max={800} label="Output Voltage" unit="VDC" color="#10b981" />
                  <Gauge value={currentStats.current} min={0} max={100} label="Output Current" unit="ADC" color="#3b82f6" />
                  <Gauge value={currentStats.power} min={0} max={50} label="Output Power" unit="kW" color="#f59e0b" />
                  <div className="bg-zinc-900/50 p-6 rounded-2xl border border-white/5 flex flex-col justify-between">
                    <div>
                      <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">Module Health</span>
                      <div className="mt-4 space-y-3">
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2 text-xs text-zinc-400">
                            <Thermometer size={14} /> Temp
                          </div>
                          <span className="text-sm font-mono font-bold">{currentStats.temperature.toFixed(1)}°C</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2 text-xs text-zinc-400">
                            <Wind size={14} /> Fan
                          </div>
                          <span className="text-sm font-mono font-bold">2840 RPM</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <div className="flex items-center gap-2 text-xs text-zinc-400">
                            <Cpu size={14} /> Load
                          </div>
                          <span className="text-sm font-mono font-bold">64%</span>
                        </div>
                      </div>
                    </div>
                    <div className="pt-4 border-t border-white/5">
                      <div className="flex items-center gap-2 text-emerald-400 text-[10px] font-bold uppercase">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                        All Systems Nominal
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Graphs Section */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="bg-zinc-900/50 p-6 rounded-2xl border border-white/5 h-[400px]">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Voltage & Current History</h3>
                    <div className="flex gap-4">
                      <div className="flex items-center gap-2 text-[10px] text-emerald-400 uppercase font-bold">
                        <div className="w-2 h-0.5 bg-emerald-500" /> Voltage
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-blue-400 uppercase font-bold">
                        <div className="w-2 h-0.5 bg-blue-500" /> Current
                      </div>
                    </div>
                  </div>
                  <ResponsiveContainer width="100%" height="85%">
                    <AreaChart data={telemetry}>
                      <defs>
                        <linearGradient id="colorVolt" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                      <XAxis dataKey="time" stroke="#52525b" fontSize={10} tickLine={false} axisLine={false} />
                      <YAxis stroke="#52525b" fontSize={10} tickLine={false} axisLine={false} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#18181b', border: '1px solid #ffffff10', borderRadius: '8px', fontSize: '12px' }}
                        itemStyle={{ color: '#fff' }}
                      />
                      <Area type="monotone" dataKey="voltage" stroke="#10b981" fillOpacity={1} fill="url(#colorVolt)" strokeWidth={2} />
                      <Line type="monotone" dataKey="current" stroke="#3b82f6" strokeWidth={2} dot={false} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>

                <div className="bg-zinc-900/50 p-6 rounded-2xl border border-white/5 h-[400px]">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Power Output (kW)</h3>
                  </div>
                  <ResponsiveContainer width="100%" height="85%">
                    <LineChart data={telemetry}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff05" vertical={false} />
                      <XAxis dataKey="time" stroke="#52525b" fontSize={10} tickLine={false} axisLine={false} />
                      <YAxis stroke="#52525b" fontSize={10} tickLine={false} axisLine={false} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#18181b', border: '1px solid #ffffff10', borderRadius: '8px', fontSize: '12px' }}
                      />
                      <Line type="stepAfter" dataKey="power" stroke="#f59e0b" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'monitor' && (
            <motion.div 
              key="monitor"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="bg-zinc-900/50 rounded-2xl border border-white/5 overflow-hidden flex flex-col h-[calc(100vh-180px)]"
            >
              <div className="p-4 border-b border-white/5 flex items-center justify-between bg-black/20">
                <div className="flex items-center gap-4">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Live CAN Traffic</h3>
                  <div className="flex gap-2">
                    <span className="px-2 py-0.5 bg-emerald-500/10 text-emerald-400 text-[10px] rounded border border-emerald-500/20 font-mono">
                      RX: {frames.length} pkts
                    </span>
                    <span className="px-2 py-0.5 bg-blue-500/10 text-blue-400 text-[10px] rounded border border-blue-500/20 font-mono">
                      125k
                    </span>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button className="p-2 hover:bg-white/5 rounded-lg text-zinc-400 transition-colors">
                    <Download size={16} />
                  </button>
                  <button className="p-2 hover:bg-white/5 rounded-lg text-zinc-400 transition-colors">
                    <FileCode size={16} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-auto font-mono text-[11px]">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-zinc-900 z-10">
                    <tr className="text-zinc-500 uppercase tracking-tighter border-b border-white/5">
                      <th className="p-3 font-medium">Timestamp</th>
                      <th className="p-3 font-medium">ID (HEX)</th>
                      <th className="p-3 font-medium">Type</th>
                      <th className="p-3 font-medium">DLC</th>
                      <th className="p-3 font-medium">Data (B0-B7)</th>
                      <th className="p-3 font-medium">Decoded Signal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {frames.map((frame, i) => (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/5 transition-colors group">
                        <td className="p-3 text-zinc-500">{(frame.timestamp % 100000 / 1000).toFixed(3)}</td>
                        <td className="p-3 text-emerald-400 font-bold">{frame.id}</td>
                        <td className="p-3 text-zinc-400">EXT</td>
                        <td className="p-3 text-zinc-400">8</td>
                        <td className="p-3">
                          <div className="flex gap-1.5">
                            {frame.data.map((byte, bi) => (
                              <span key={bi} className="text-zinc-300 group-hover:text-white">{byte}</span>
                            ))}
                          </div>
                        </td>
                        <td className="p-3">
                          {frame.id === '28F3FF0' ? (
                            <span className="text-blue-400">Voltage: {frame.decoded?.voltage.toFixed(1)}V</span>
                          ) : frame.id === '28E01F0' ? (
                            <span className="text-orange-400">Temp: {frame.decoded?.temperature.toFixed(1)}°C</span>
                          ) : (
                            <span className="text-zinc-600 italic">Unknown Frame</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}

          {activeTab === 'control' && (
            <motion.div 
              key="control"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-6"
            >
              {/* Setpoints */}
              <div className="lg:col-span-2 space-y-6">
                <div className="bg-zinc-900/50 p-8 rounded-2xl border border-white/5">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-8">Charger Command Center</h3>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
                    <div className="space-y-6">
                      <div className="flex justify-between items-end">
                        <label className="text-xs text-zinc-500 uppercase font-bold">Target Voltage</label>
                        <span className="text-2xl font-mono font-bold text-emerald-400">{targetVoltage}V</span>
                      </div>
                      <input 
                        type="range" min="0" max="750" value={targetVoltage} 
                        onChange={(e) => setTargetVoltage(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                        <span>0V</span>
                        <span>750V MAX</span>
                      </div>
                    </div>

                    <div className="space-y-6">
                      <div className="flex justify-between items-end">
                        <label className="text-xs text-zinc-500 uppercase font-bold">Target Current</label>
                        <span className="text-2xl font-mono font-bold text-blue-400">{targetCurrent}A</span>
                      </div>
                      <input 
                        type="range" min="0" max="80" value={targetCurrent} 
                        onChange={(e) => setTargetCurrent(parseInt(e.target.value))}
                        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-600 font-mono">
                        <span>0A</span>
                        <span>80A MAX</span>
                      </div>
                    </div>
                  </div>

                  <div className="mt-12 flex gap-4">
                    <button className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2">
                      <Play size={18} fill="currentColor" />
                      START CHARGING
                    </button>
                    <button className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-white font-bold py-4 rounded-xl transition-all border border-white/5 flex items-center justify-center gap-2">
                      <Square size={18} fill="currentColor" />
                      STOP CHARGING
                    </button>
                  </div>
                </div>

                <div className="bg-zinc-900/50 p-6 rounded-2xl border border-white/5">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-4">Module Configuration</h3>
                  <div className="grid grid-cols-4 gap-4">
                    {[1, 2, 3, 4].map(m => (
                      <div key={m} className="p-4 bg-black/20 rounded-xl border border-white/5 flex flex-col items-center gap-3">
                        <span className="text-[10px] text-zinc-500 font-bold uppercase">SMR {m}</span>
                        <div className="w-12 h-6 bg-zinc-800 rounded-full p-1 relative cursor-pointer">
                          <div className="w-4 h-4 bg-emerald-500 rounded-full absolute right-1" />
                        </div>
                        <span className="text-[10px] text-emerald-400 font-bold">ONLINE</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Safety & Faults */}
              <div className="space-y-6">
                <div className="bg-red-500/5 p-6 rounded-2xl border border-red-500/20">
                  <div className="flex items-center gap-2 text-red-500 mb-4">
                    <AlertTriangle size={18} />
                    <h3 className="text-xs font-bold uppercase tracking-widest">Safety Interlocks</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between items-center p-3 bg-red-500/10 rounded-lg border border-red-500/10">
                      <span className="text-[10px] text-red-400 font-bold uppercase">E-Stop Status</span>
                      <span className="text-[10px] bg-red-500 text-white px-2 py-0.5 rounded font-bold">OK</span>
                    </div>
                    <div className="flex justify-between items-center p-3 bg-zinc-800/50 rounded-lg border border-white/5 opacity-50">
                      <span className="text-[10px] text-zinc-400 font-bold uppercase">Isolation Fault</span>
                      <span className="text-[10px] text-zinc-500 font-bold">CLEAR</span>
                    </div>
                    <div className="flex justify-between items-center p-3 bg-zinc-800/50 rounded-lg border border-white/5 opacity-50">
                      <span className="text-[10px] text-zinc-400 font-bold uppercase">HV Interlock</span>
                      <span className="text-[10px] text-zinc-500 font-bold">CLOSED</span>
                    </div>
                  </div>
                </div>

                <div className="bg-zinc-900/50 p-6 rounded-2xl border border-white/5">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400 mb-4">System Logs</h3>
                  <div className="space-y-3 font-mono text-[10px]">
                    <div className="text-zinc-500 border-l-2 border-emerald-500 pl-3">
                      <span className="text-zinc-600">[21:15:43]</span> CAN Interface Initialized
                    </div>
                    <div className="text-zinc-500 border-l-2 border-emerald-500 pl-3">
                      <span className="text-zinc-600">[21:15:45]</span> Handshake with SMR-01 Success
                    </div>
                    <div className="text-zinc-500 border-l-2 border-blue-500 pl-3">
                      <span className="text-zinc-600">[21:15:50]</span> Setpoint V=400V I=20A sent
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}

          {activeTab === 'reverse' && (
            <motion.div 
              key="reverse"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-6"
            >
              <div className="bg-zinc-900/50 p-8 rounded-2xl border border-white/5">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-400">Reverse Engineering Engine</h3>
                    <p className="text-sm text-zinc-500 mt-1">Analyzing unknown CAN frames for signal patterns and scaling factors.</p>
                  </div>
                  <button className="bg-white text-black px-6 py-2 rounded-xl text-xs font-bold hover:bg-zinc-200 transition-all flex items-center gap-2">
                    <Database size={14} />
                    EXPORT DBC FILE
                  </button>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                  <div className="space-y-4">
                    <h4 className="text-[10px] text-zinc-500 uppercase font-bold">Candidate Signal Detection</h4>
                    <div className="space-y-2">
                      {[
                        { id: '28F3FF0', bytes: '0-1', type: 'UINT16', scaling: '0.1', label: 'Voltage Candidate' },
                        { id: '28F3FF0', bytes: '2-3', type: 'UINT16', scaling: '0.01', label: 'Current Candidate' },
                        { id: '28E01F0', bytes: '4', type: 'INT8', scaling: '1.0', label: 'Temperature Candidate' },
                      ].map((sig, i) => (
                        <div key={i} className="p-4 bg-black/20 rounded-xl border border-white/5 flex items-center justify-between group hover:border-emerald-500/30 transition-all">
                          <div className="flex items-center gap-4">
                            <div className="w-8 h-8 rounded-lg bg-zinc-800 flex items-center justify-center text-xs font-bold text-emerald-400">
                              {i+1}
                            </div>
                            <div>
                              <div className="text-xs font-bold text-zinc-200">{sig.label}</div>
                              <div className="text-[10px] text-zinc-500 font-mono">ID: {sig.id} | Bytes: {sig.bytes} | {sig.type}</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-zinc-400 font-bold uppercase">Confidence</div>
                            <div className="w-24 h-1.5 bg-zinc-800 rounded-full mt-1 overflow-hidden">
                              <div className="h-full bg-emerald-500" style={{ width: `${90 - i*10}%` }} />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-black/40 p-6 rounded-2xl border border-white/5 font-mono text-xs">
                    <div className="flex items-center gap-2 text-zinc-400 mb-4 border-b border-white/5 pb-2">
                      <FileCode size={14} />
                      <span>DBC PREVIEW</span>
                    </div>
                    <pre className="text-zinc-500 leading-relaxed">
                      {`BO_ 2364211184 SMR_Status: 8 SMR
 SG_ Output_Voltage : 0|16@1+ (0.1,0) [0|800] "V" Vector__XXX
 SG_ Output_Current : 16|16@1+ (0.01,0) [0|100] "A" Vector__XXX
 SG_ Module_Temp : 32|8@1+ (1,-40) [-40|125] "C" Vector__XXX

BO_ 2364211187 SMR_Faults: 8 SMR
 SG_ Over_Voltage_Fault : 0|1@1+ (1,0) [0|1] "" Vector__XXX
 SG_ Over_Temp_Fault : 1|1@1+ (1,0) [0|1] "" Vector__XXX`}
                    </pre>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer Status Bar */}
      <footer className="fixed bottom-0 left-0 right-0 bg-zinc-900 border-t border-white/5 px-6 h-8 flex items-center justify-between text-[10px] font-mono text-zinc-500">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-emerald-500 animate-pulse" : "bg-zinc-600"}`} />
            {isRunning ? "CONNECTED" : "DISCONNECTED"}: IXXAT V2 (SN: 482910)
          </div>
          <div>LATENCY: {isRunning ? "4ms" : "--"}</div>
          <div>CPU: {isRunning ? "12%" : "2%"}</div>
        </div>
        <div className="flex items-center gap-4">
          <div className={isRunning ? "text-emerald-500/80" : "text-zinc-600"}>
            LOGGING: {isRunning ? "ACTIVE (voltcan_log_20260309.csv)" : "INACTIVE"}
          </div>
          <div>v2.4.0-stable</div>
        </div>
      </footer>
    </div>
  );
}
