/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { 
  Terminal, 
  Zap, 
  ShieldCheck,
  Wallet,
  Cpu,
  Activity,
  ArrowRight,
  Database,
  Lock,
  Globe,
  Server
} from 'lucide-react';

// Common Colors as per Recipe 3: Hardware / Specialist Tool
const THEME = {
  bg: 'bg-[#05070a]',
  card: 'bg-[#0d1117]',
  accent: 'text-orange-600',
  accentBg: 'bg-orange-600',
  secondary: 'text-gray-500',
  border: 'border-white/10',
  fontMono: 'font-mono'
};

const FEATURES = [
  { id: '01', title: 'Multi-Instance Core', desc: 'Enterprise-grade asynchronicity for high-throughput node management.', icon: Cpu },
  { id: '02', title: 'Economy Engine', desc: 'Real-time referral tracking and dynamic balance calculations.', icon: Wallet },
  { id: '03', title: 'ISO Cloud Mesh', desc: 'Decentralized hosting infrastructure with 99.9% network availability.', icon: Server },
  { id: '04', title: 'Node ID Protocol', desc: 'Proprietary SR-XXXXXX identification for sub-bot tracing.', icon: Database },
  { id: '05', title: 'Anti-Fraud DPI', desc: 'Deep Packet Inspection to eliminate double-spending and balance leaks.', icon: ShieldCheck },
  { id: '06', title: 'Star Gateway v2', desc: 'Direct Telegram API integration for wholesale Star recharges.', icon: Zap },
  { id: '07', title: 'Zero-Knowledge Security', desc: 'End-to-end encryption for all API credentials and node tokens.', icon: Lock },
  { id: '08', title: 'Webhook Bridge', desc: 'Instant feedback loops for automated payment verification.', icon: Globe },
];

import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import VerifyPage from './components/VerifyPage';

export default function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<MainDashboard />} />
        <Route path="/verify" element={<VerifyPage />} />
      </Routes>
    </Router>
  );
}

function MainDashboard() {
  const [hubStatus, setHubStatus] = useState<any>({
    status: "online",
    hubActive: false,
    hubUsername: "",
    totalNodes: 0,
    totalUsers: 0,
    engineVersion: "V2.5-ADVANCED-PRO",
    logs: [],
    liveBots: 0,
    offlineBots: 0,
    serverSpeed: "0ms",
    loadAverage: "0%"
  });
  const [loading, setLoading] = useState(true);
  const [initialSync, setInitialSync] = useState(true);
  const [templates, setTemplates] = useState<any[]>([]);
  const [nodes, setNodes] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<'monitor' | 'templates' | 'manage' | 'broadcast'>('monitor');
  const [selectedNode, setSelectedNode] = useState<string>("");
  const [updatingNode, setUpdatingNode] = useState(false);
  const [bcMessage, setBcMessage] = useState("");
  const [sendingBc, setSendingBc] = useState(false);

  const sendGlobalBroadcast = async () => {
     if (!bcMessage) return alert("Please enter message");
     if (!window.confirm("ARE YOU SURE? This will send a message HELP to ALL users across ALL bots!")) return;
     
     setSendingBc(true);
     try {
       const res = await fetch('/api/admin/broadcast', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ message: bcMessage, adminId: 6561010416 }) // Master Admin
       });
       if (res.ok) {
         alert("🚀 Network Broadcast Initialized! Check Master Bot for the final report.");
         setBcMessage("");
       }
     } catch (e) {
       alert("Network synchronization error.");
     } finally {
       setSendingBc(false);
     }
  };

  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const res = await fetch('/api/templates');
        const data = await res.json();
        setTemplates(data);
      } catch (e) {
        console.error("Template load fail", e);
      }
    };
    fetchTemplates();
  }, []);

  const fetchNodes = async () => {
    try {
      const res = await fetch('/api/nodes');
      const data = await res.json();
      setNodes(data);
    } catch (e) {
      console.error("Nodes load fail", e);
    }
  };

  useEffect(() => {
    if (activeTab === 'manage') {
      fetchNodes();
    }
  }, [activeTab]);

  const switchTemplate = async (nodeId: string, templateId: string) => {
    setUpdatingNode(true);
    try {
      const res = await fetch(`/api/nodes/${nodeId}/template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: templateId })
      });
      if (res.ok) {
        alert("✅ Template applied successfully! Sub-bot buttons will update instantly.");
        fetchNodes();
      }
    } catch (e) {
      alert("❌ Switch failed. Check server logs.");
    } finally {
      setUpdatingNode(false);
    }
  };

  useEffect(() => {
    let failCount = 0;
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        setHubStatus(data);
        failCount = 0;
      } catch (err: any) {
        console.warn("Link Synchronization Check:", err.message);
        failCount++;
        // If we fail too many times, assume link interruption but keep rendering
        if (failCount > 5) {
          setHubStatus((prev: any) => ({ ...prev, hubActive: false }));
        }
      } finally {
        setLoading(false);
        setInitialSync(false);
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  if (initialSync) {
    const isTokenMissing = !hubStatus?.hubActive && !hubStatus?.hubTokenDefined;
    
    return (
      <div className={`min-h-screen ${THEME.bg} flex flex-col items-center justify-center font-mono p-4`}>
        <div className="relative">
          <Terminal className={`w-16 h-16 ${isTokenMissing ? 'text-red-600' : THEME.accent} animate-pulse`} />
          <div className={`absolute inset-0 border-2 ${isTokenMissing ? 'border-red-600/20' : 'border-orange-600/20'} rounded-full scale-150 animate-ping`} />
        </div>
        
        {isTokenMissing ? (
          <div className="mt-12 flex flex-col items-center text-center space-y-4">
             <span className="text-red-500 font-bold tracking-[0.2em] uppercase">CRITICAL: ENGINE TOKEN MISSING</span>
             <p className="text-[10px] text-gray-500 max-w-xs leading-relaxed uppercase tracking-widest">
               The Master Bot Token is not detected in your environment. Please add <code className="text-orange-600 bg-orange-600/10 px-1">TELEGRAM_BOT_TOKEN</code> to your AI Studio settings.
             </p>
             <div className="pt-8">
               <button 
                 onClick={() => setInitialSync(false)}
                 className="px-8 py-3 bg-red-600/20 border border-red-600 text-red-600 text-[10px] font-black uppercase tracking-widest hover:bg-red-600 hover:text-black transition-all"
               >
                 [ Bypass To Web Portal ]
               </button>
             </div>
          </div>
        ) : (
          <>
            <span className="mt-12 text-[10px] tracking-[0.8em] text-gray-500 uppercase animate-pulse text-center">Establishing Secure Uplink</span>
            <button 
              onClick={() => setInitialSync(false)}
              className="mt-8 text-[9px] text-gray-700 uppercase tracking-widest hover:text-orange-600 transition-colors"
            >
              [ Bypass Synchronization ]
            </button>
          </>
        )}
      </div>
    );
  }

  const hubUrl = hubStatus?.hubUsername ? `https://t.me/${hubStatus.hubUsername}` : '#';
  const isOperational = hubStatus?.hubActive;

  return (
    <div className={`min-h-screen ${THEME.bg} text-white selection:bg-orange-600/30 overflow-x-hidden font-sans`}>
      {/* HUD Navigation */}
      <nav className={`fixed top-0 w-full z-50 px-8 py-5 border-b ${THEME.border} backdrop-blur-3xl bg-[#05070a]/90`}>
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-4">
            <div className={`w-10 h-10 rounded-sm bg-orange-600 flex items-center justify-center text-black shadow-[0_0_15px_rgba(234,88,12,0.4)]`}>
              <Cpu className="w-6 h-6" />
            </div>
            <div className="flex flex-col">
              <span className={`text-lg font-black tracking-tighter leading-none`}>SR TECHNOLOGY LTD™</span>
              <span className={`text-[8px] font-bold ${THEME.secondary} tracking-[0.4em] uppercase`}>Advanced Deploy Engine v3.1</span>
            </div>
          </div>
          
          <div className="hidden lg:flex items-center gap-12">
            <div className="flex gap-8">
              <button 
                onClick={() => setActiveTab('monitor')}
                className={`text-[9px] font-black uppercase tracking-widest ${activeTab === 'monitor' ? 'text-orange-600' : 'text-gray-500'} hover:text-orange-600 transition-colors`}
              >
                Monitor
              </button>
              <button 
                onClick={() => setActiveTab('templates')}
                className={`text-[9px] font-black uppercase tracking-widest ${activeTab === 'templates' ? 'text-orange-600' : 'text-gray-500'} hover:text-orange-600 transition-colors`}
              >
                Templates
              </button>
              <button 
                onClick={() => setActiveTab('manage')}
                className={`text-[9px] font-black uppercase tracking-widest ${activeTab === 'manage' ? 'text-orange-600' : 'text-gray-500'} hover:text-orange-600 transition-colors`}
              >
                Manage Nodes
              </button>
              <button 
                onClick={() => setActiveTab('broadcast')}
                className={`text-[9px] font-black uppercase tracking-widest ${activeTab === 'broadcast' ? 'text-orange-600' : 'text-gray-500'} hover:text-orange-600 transition-colors`}
              >
                Global Broadcast
              </button>
            </div>

            <div className="flex items-center gap-6">
              <div className="flex flex-col items-end">
                <span className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">Mesh Status</span>
                <span className={`text-[10px] font-mono font-bold ${isOperational ? 'text-green-500' : 'text-red-500'}`}>
                   {hubStatus?.serverSpeed || '0ms'} / {isOperational ? 'LINK_OK' : 'OFFLINE'}
                </span>
              </div>
              <div className={`h-10 w-[1px] bg-white/5`} />
              <div className="flex flex-col items-end">
                <span className="text-[9px] font-bold text-gray-600 uppercase tracking-widest">Global Users</span>
                <span className="text-[10px] font-mono font-bold text-orange-600">#{hubStatus?.totalUsers || 0} LINKED</span>
              </div>
            </div>
            <a 
              href={hubUrl}
              target="_blank"
              rel="noreferrer"
              className={`px-8 py-3 rounded-none border-2 border-orange-600 ${isOperational ? 'bg-orange-600 text-black' : 'opacity-20 pointer-events-none'} text-[10px] font-black uppercase tracking-[0.2em] hover:bg-black hover:text-orange-600 transition-all`}
            >
              {isOperational ? 'Initialize Hub' : 'System Booting'}
            </a>
          </div>
        </div>
      </nav>

      {/* Hero: Industrial Design */}
      <section className="relative pt-60 pb-32 px-8 overflow-hidden">
        {/* Background Grid Accent */}
        <div className="absolute top-0 left-0 w-full h-[500px] bg-[radial-gradient(circle_at_center,_rgba(234,88,12,0.05)_0%,_transparent_70%)] pointer-events-none" />
        
        <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-32 items-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
          >
            <div className={`inline-flex items-center gap-3 px-4 py-2 border ${THEME.border} bg-white/[0.02] mb-10`}>
              <div className="w-1.5 h-1.5 rounded-full bg-orange-600 animate-pulse" />
              <span className={`text-[9px] font-mono font-bold uppercase tracking-[0.3em] ${THEME.secondary}`}>Protocol_Alpha: Online</span>
            </div>
            
            <h1 className="text-7xl md:text-9xl font-black leading-[0.8] tracking-tighter mb-12 uppercase italic">
              Bot <br />
              <span className="text-orange-600">Maker</span> <br />
              <span className="opacity-20 underline decoration-orange-600">Engine</span>
            </h1>
            
            <p className="text-xl text-gray-500 max-w-lg mb-16 leading-relaxed font-medium">
              Enterprise-grade deployment hub for Telegram sub-bots. Automated UPI, Crypto, and Star payment infrastructure with advanced owner administration.
            </p>
            
            <div className="flex flex-wrap gap-8">
              <a 
                href={hubUrl}
                target="_blank"
                rel="noreferrer"
                className={`group flex items-center gap-6 px-12 py-6 ${isOperational ? 'bg-orange-600' : 'bg-gray-800 pointer-events-none'} text-black font-black uppercase tracking-tighter hover:scale-[1.02] active:scale-[0.98] transition-all`}
              >
                {isOperational ? 'Deploy First Node' : 'System Initializing'}
                <ArrowRight className="w-6 h-6 group-hover:translate-x-2 transition-transform" />
              </a>
              <div className={`flex items-center gap-4 px-10 py-6 border ${THEME.border} bg-white/[0.02]`}>
                <ShieldCheck className="w-6 h-6 text-gray-400" />
                <span className="text-xs font-black text-gray-400 uppercase tracking-widest">Mesh Certified</span>
              </div>
            </div>
          </motion.div>

          {/* Terminal Monitor UI */}
          <div className="relative group">
            <div className="absolute -inset-1 bg-orange-600/20 rounded-none blur-3xl opacity-20 group-hover:opacity-40 transition duration-1000" />
            <div className={`relative aspect-square rounded-none ${THEME.card} border-4 ${THEME.border} p-12 flex flex-col font-mono shadow-2xl overflow-hidden`}>
              <div className="flex items-center justify-between mb-12 border-b border-white/10 pb-6">
                <div className="flex items-center gap-3">
                  <Activity className="w-4 h-4 text-orange-600 animate-pulse" />
                  <span className="text-[10px] text-orange-600 font-bold uppercase tracking-[0.4em]">Live Kernel Log</span>
                </div>
                <span className="text-[9px] text-gray-600 whitespace-nowrap">BUILD: {hubStatus?.engineVersion || '3.5.0-PRO'}</span>
              </div>
              
              <div className="flex-1 space-y-3 overflow-y-auto max-h-[300px] pr-2 scrollbar-hide">
                {[
                  { label: 'KERNEL_TASKS', val: 'MULTITHREADED_ASYNC', color: 'text-white' },
                  { label: 'SERVER_LATENCY', val: hubStatus?.serverSpeed || '2.4ms', color: 'text-green-500' },
                  { label: 'NODE_POOLS', val: `${hubStatus?.liveBots || 0} LIVE / ${hubStatus?.offlineBots || 0} OFF`, color: 'text-orange-600 font-bold' },
                  { label: 'USER_METRICS', val: `${hubStatus?.totalUsers || 0} LINKED`, color: 'text-orange-600' },
                  { label: 'CPU_LOAD', val: hubStatus?.loadAverage || '12.4%', color: 'text-green-500' },
                  { label: 'MESH_ID', val: 'SR-HUB-DEPLOY-3.2', color: 'text-white' },
                ].map((item, idx) => (
                  <div key={idx} className="flex justify-between items-center text-[10px] border-b border-white/[0.02] pb-2">
                    <span className="text-gray-600 tracking-widest uppercase">{item.label}</span>
                    <span className={`${item.color} font-black underline italic truncate ml-4`}>{item.val}</span>
                  </div>
                ))}
              </div>

              <div className="mt-16 bg-black/40 p-6 border border-white/5">
                <div className="flex gap-1.5 items-end h-16">
                  {[...Array(30)].map((_, i) => (
                    <motion.div 
                      key={i}
                      animate={{ height: [8, Math.random() * 48 + 8, 8] }}
                      transition={{ repeat: Infinity, duration: 1 + Math.random(), delay: i * 0.03 }}
                      className="flex-1 bg-orange-600/40"
                    />
                  ))}
                </div>
                <div className="mt-4 flex justify-between text-[8px] font-bold text-gray-700 tracking-widest">
                  <span>FREQ_HZ</span>
                  <span>CPU_LOAD_32%</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Dynamic Content Sections */}
      {activeTab === 'templates' && (
        <section className="py-32 px-8 bg-[#020406]">
          <div className="max-w-7xl mx-auto">
            <header className="mb-20">
              <h2 className="text-5xl font-black italic uppercase tracking-tighter mb-4">Template Marketplace</h2>
              <p className="text-gray-500 max-w-xl">Choose from our pre-configured ready-made templates. Applying a template updates bot buttons and logic instantly.</p>
            </header>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {templates.map(tpl => (
                <div key={tpl.id} className={`p-8 border ${THEME.border} ${THEME.card} hover:border-orange-600 transition-all`}>
                  <h3 className="text-xl font-bold mb-3 italic">{tpl.name}</h3>
                  <p className="text-xs text-gray-500 leading-relaxed mb-6 h-12 overflow-hidden">{tpl.desc}</p>
                  <div className="text-[10px] font-mono text-orange-600 font-bold mb-6">PROTO_ID: {tpl.id.toUpperCase()}</div>
                  <button 
                    onClick={() => { setActiveTab('manage'); }}
                    className="w-full py-3 bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest hover:bg-orange-600 hover:text-black transition-all"
                  >
                    Select Node to Apply
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {activeTab === 'manage' && (
        <section className="py-32 px-8 bg-[#020406]">
          <div className="max-w-7xl mx-auto">
            <header className="mb-20">
              <h2 className="text-5xl font-black italic uppercase tracking-tighter mb-4">Node Force Control</h2>
              <p className="text-gray-500 max-w-xl">Manage your deployed sub-bots directly from the web core.</p>
            </header>
            
            <div className="grid grid-cols-1 gap-4">
              {nodes.length === 0 ? (
                <div className="p-20 text-center border-2 border-dashed border-white/5 text-gray-600 font-mono text-sm">
                  NO ACTIVE NODES DETECTED IN MESH
                </div>
              ) : (
                nodes.map(node => (
                  <div key={node.id} className={`p-8 border ${THEME.border} ${THEME.card} flex flex-col lg:flex-row justify-between items-center gap-12`}>
                    <div className="flex items-center gap-8">
                      <div className={`w-12 h-12 ${node.status === 'LIVE' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'} flex items-center justify-center border border-white/10`}>
                        <Server className="w-6 h-6" />
                      </div>
                      <div>
                        <div className="flex items-center gap-3">
                          <h4 className="text-lg font-black italic">@{node.username}</h4>
                          <span className={`text-[8px] px-2 py-0.5 rounded-full ${node.status === 'LIVE' ? 'bg-green-500/20 text-green-500' : 'bg-red-500/20 text-red-500'} font-bold`}>{node.status}</span>
                        </div>
                        <div className="text-[10px] font-mono text-gray-600 underline">NODE_ID: {node.id}</div>
                      </div>
                    </div>

                    <div className="flex flex-col md:flex-row items-center gap-6">
                      <div className="flex flex-col items-center md:items-end">
                        <span className="text-[8px] font-bold text-gray-700 uppercase tracking-widest mb-1">Current Active Slot</span>
                        <span className="text-[10px] font-black text-orange-600 bg-orange-600/10 px-4 py-1 italic uppercase border border-orange-600/20">{node.type}</span>
                      </div>
                      
                      <div className="flex gap-3">
                        <select 
                          className="bg-black border border-white/10 text-[10px] font-black uppercase p-3 w-48 focus:border-orange-600 outline-none"
                          onChange={(e) => switchTemplate(node.id, e.target.value)}
                          defaultValue=""
                        >
                          <option value="" disabled>Change Template</option>
                          {templates.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>
      )}

      {activeTab === 'broadcast' && (
        <section className="py-32 px-8 bg-[#020406]">
          <div className="max-w-4xl mx-auto">
            <header className="mb-20 text-center">
              <div className="inline-flex items-center gap-3 px-4 py-2 bg-orange-600/10 border border-orange-600/20 mb-6">
                <Globe className="w-4 h-4 text-orange-600 animate-spin" />
                <span className="text-[10px] font-black text-orange-600 tracking-[0.3em] uppercase">Network Payload Center</span>
              </div>
              <h2 className="text-6xl font-black italic uppercase tracking-tighter mb-4">Global Broadcast</h2>
              <p className="text-gray-500">Inject a message across the entire SR Mesh network. Every user of every active node will receive this payload.</p>
            </header>

            <div className={`p-12 border ${THEME.border} ${THEME.card} shadow-2xl`}>
              <div className="mb-8 flex items-center justify-between border-b border-white/5 pb-4">
                <span className="text-[10px] font-mono text-gray-600 uppercase">Input Payload (HTML/Text Supported)</span>
                <span className="text-[10px] font-mono text-orange-600 animate-pulse">SYSTEM_ID: AUTH_ADMIN</span>
              </div>
              
              <textarea 
                value={bcMessage}
                onChange={(e) => setBcMessage(e.target.value)}
                placeholder="<b>Broadcast Title</b>\n\nMessage content goes here..."
                className="w-full h-64 bg-black/50 border border-white/5 p-8 text-sm font-mono text-gray-300 focus:border-orange-600 outline-none transition-all resize-none mb-8"
              />

              <div className="flex flex-col md:flex-row items-center gap-8">
                <button 
                  onClick={sendGlobalBroadcast}
                  disabled={sendingBc || !bcMessage}
                  className={`flex-1 w-full py-6 flex items-center justify-center gap-4 ${sendingBc ? 'bg-gray-800' : 'bg-orange-600'} text-black font-black uppercase tracking-widest hover:brightness-110 active:scale-95 transition-all disabled:opacity-30`}
                >
                  {sendingBc ? (
                    <>
                      <div className="w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                      Uploading Payload...
                    </>
                  ) : (
                    <>
                      <Zap className="w-5 h-5 fill-black" />
                      Engage Network Broadcast
                    </>
                  )}
                </button>
                <div className="text-[9px] font-mono text-gray-600 uppercase leading-relaxed max-w-[200px]">
                  * This process is asynchronous. A final report will be sent to the Master Bot Admin.
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Grid: 01 to 08 - Specialized Style */}
      <section className="py-40 px-8 bg-[#030508] border-y border-white/[0.02]">
        <div className="max-w-7xl mx-auto">
          <div className="mb-32 flex flex-col items-center">
            <h2 className="text-6xl font-black tracking-tighter uppercase mb-6 italic">Architecture</h2>
            <div className={`h-2 w-48 ${THEME.accentBg}`} />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-x-16 gap-y-28">
            {FEATURES.map((feature) => (
              <div key={feature.id} className="group cursor-crosshair">
                <div className="relative mb-10 inline-block">
                  <span className="absolute -top-12 -left-8 text-8xl font-black text-white/[0.02] leading-none group-hover:text-orange-600/[0.05] transition-colors">{feature.id}</span>
                  <div className={`relative z-10 w-16 h-16 border-2 ${THEME.border} flex items-center justify-center bg-[#0d1117] group-hover:border-orange-600 transition-colors shadow-2xl`}>
                    <feature.icon className={`w-8 h-8 ${THEME.accent}`} />
                  </div>
                </div>
                <h3 className="text-xl font-black mb-6 uppercase tracking-tighter italic">{feature.title}</h3>
                <p className="text-sm text-gray-500 leading-relaxed font-medium">{feature.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer: Specialized Industrial Style */}
      <footer className={`py-40 px-8 border-t ${THEME.border} bg-[#020406]`}>
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row justify-between items-start gap-32">
          <div className="max-w-xl">
            <div className="flex items-center gap-5 mb-12">
              <div className={`w-14 h-14 rounded-none bg-orange-600 flex items-center justify-center text-black shadow-2xl shadow-orange-600/20`}>
                <Cpu className="w-8 h-8" />
              </div>
              <span className={`text-4xl font-black tracking-tighter uppercase italic underline decoration-orange-600`}>SR TECH</span>
            </div>
            <p className="text-lg text-gray-500 leading-relaxed font-medium mb-16">
              The SR Bot Maker Hub is a fully asynchronous multi-bot management platform designed for the highest level of stability. Powered by the SR Advanced Deployment Protocol.
            </p>
            <div className="flex flex-wrap gap-12">
              <a href="#" className="text-[10px] font-black uppercase tracking-[0.3em] hover:text-orange-600 transition-colors">Documentation</a>
              <a href="#" className="text-[10px] font-black uppercase tracking-[0.3em] hover:text-orange-600 transition-colors">Mesh Protocols</a>
              <a href="#" className="text-[10px] font-black uppercase tracking-[0.3em] hover:text-orange-600 transition-colors">Uptime Report</a>
            </div>
          </div>

          <div className={`p-10 rounded-none ${THEME.card} border-2 border-orange-600/20 md:w-[450px] shadow-2xl relative overflow-hidden group`}>
            {/* Animated Scan Line */}
            <motion.div 
               animate={{ top: ['0%', '100%', '0%'] }}
               transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
               className="absolute left-0 w-full h-[2px] bg-orange-600/30 z-10 blur-sm"
            />
            
            <h4 className="text-[10px] font-bold text-gray-500 mb-10 uppercase tracking-[0.4em] italic border-b border-white/5 pb-4">Real-time Node Telemetry</h4>
            <div className="space-y-6 font-mono">
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-gray-600 uppercase tracking-widest">Global_Load</span>
                <span className="text-white font-bold italic">NORMAL_32%</span>
              </div>
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-gray-600 uppercase tracking-widest">Active_Threads</span>
                <span className="text-white font-bold italic underline">1024_INSTANCES</span>
              </div>
              <div className="flex justify-between items-center text-[11px]">
                <span className="text-gray-600 uppercase tracking-widest">Mesh_Security</span>
                <span className="text-green-500 font-bold italic uppercase">Encrypted_AES</span>
              </div>
              <div className="mt-12">
                <a 
                  href={hubUrl} 
                  target="_blank"
                  rel="noreferrer"
                  className={`w-full py-6 ${isOperational ? 'bg-orange-600 hover:brightness-110' : 'bg-gray-800 pointer-events-none'} text-black font-black text-xs uppercase tracking-[0.3em] flex items-center justify-center transition-all`}
                >
                  {isOperational ? 'Connect Node' : 'Waiting for API'}
                </a>
              </div>
            </div>
          </div>
        </div>
        
        <div className="max-w-7xl mx-auto mt-40 pt-16 border-t border-white/5 flex flex-col lg:flex-row justify-between items-center gap-10">
          <p className="text-[9px] font-mono text-gray-700 tracking-[0.3em] uppercase">Kernel_Build: 15102117223-PRODUCTION-V2.5</p>
          <div className="flex gap-16">
            <span className="text-[9px] font-mono text-gray-700 tracking-[0.3em] uppercase">© 2026 SR TECHNOLOGY LTD™.</span>
            <span className="text-[9px] font-mono text-gray-700 tracking-[0.3em] uppercase">Secure Mesh Protocol: Enabled</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
