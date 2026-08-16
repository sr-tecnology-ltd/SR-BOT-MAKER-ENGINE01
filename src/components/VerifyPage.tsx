/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ShieldCheck, 
  Fingerprint, 
  Activity, 
  Lock, 
  ShieldAlert,
  Bot
} from 'lucide-react';

// Generates a deterministic, high-entropy hardware & canvas fingerprint
async function generateHardwareFingerprint(): Promise<{ deviceId: string; hardwareFp: string; clientDetails: any }> {
  // 1. Storage persistence check across localStorage, sessionStorage, and cookie
  let deviceId = localStorage.getItem('sr_device_uid');
  if (!deviceId) {
    deviceId = sessionStorage.getItem('sr_device_uid');
  }
  if (!deviceId) {
    const match = document.cookie.match(/sr_device_uid=([^;]+)/);
    if (match) deviceId = match[1];
  }

  // 2. Canvas 2D Fingerprint
  let canvasFp = "";
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 140;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = "top";
      ctx.font = "14px 'Arial', 'Helvetica', sans-serif";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#f60";
      ctx.fillRect(125, 1, 62, 20);
      ctx.fillStyle = "#069";
      ctx.fillText("SR_SECURITY_HW_2026", 2, 15);
      ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
      ctx.fillText("DEVICE_INTEGRITY_CHECK", 4, 45);
      ctx.beginPath();
      ctx.arc(50, 50, 30, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.fill();
      canvasFp = canvas.toDataURL();
    }
  } catch (e) {
    canvasFp = "canvas_err";
  }

  // 3. WebGL Fingerprint
  let webglVendor = "";
  let webglRenderer = "";
  try {
    const glCanvas = document.createElement('canvas');
    const gl = (glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        webglVendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) || "";
        webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "";
      }
    }
  } catch (e) {
    webglVendor = "unknown_gl";
  }

  // 4. Hardware specs
  const screenInfo = `${screen.width}x${screen.height}x${screen.colorDepth}_${window.devicePixelRatio || 1}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const lang = navigator.language || (navigator.languages && navigator.languages[0]) || "";
  const cores = navigator.hardwareConcurrency || 0;
  const mem = (navigator as any).deviceMemory || 0;
  const touchPoints = navigator.maxTouchPoints || 0;

  // 5. Build Hardware Hash
  const rawSignature = `${navigator.userAgent}##${screenInfo}##${timeZone}##${lang}##${cores}##${mem}##${touchPoints}##${webglVendor}##${webglRenderer}##${canvasFp.substring(0, 80)}`;
  
  let hash1 = 0x811c9dc5;
  for (let i = 0; i < rawSignature.length; i++) {
    hash1 ^= rawSignature.charCodeAt(i);
    hash1 = (hash1 * 0x01000193) >>> 0;
  }
  const hardwareFp = 'HW-' + hash1.toString(16).toUpperCase();

  if (!deviceId) {
    deviceId = `DEV-${hardwareFp}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    try {
      localStorage.setItem('sr_device_uid', deviceId);
      sessionStorage.setItem('sr_device_uid', deviceId);
      document.cookie = `sr_device_uid=${deviceId}; path=/; max-age=315360000; SameSite=Lax`;
    } catch {}
  }

  return {
    deviceId,
    hardwareFp,
    clientDetails: {
      screen: screenInfo,
      timeZone,
      cores,
      mem,
      webglRenderer: webglRenderer.substring(0, 40)
    }
  };
}

export default function VerifyPage() {
  const [step, setStep] = useState<'scan' | 'verifying' | 'success' | 'fail'>('scan');
  const [progress, setProgress] = useState(0);
  const [reason, setReason] = useState("");

  const params = new URLSearchParams(window.location.search);
  const nodeId = params.get('nodeId');
  const userId = params.get('userId');
  const refId = params.get('ref') || params.get('refId');

  useEffect(() => {
    if (step === 'verifying') {
      const interval = setInterval(() => {
        setProgress(prev => {
          if (prev >= 100) {
            clearInterval(interval);
            handleFinalize();
            return 100;
          }
          return prev + Math.random() * 9 + 3;
        });
      }, 70);
      return () => clearInterval(interval);
    }
  }, [step]);

  const handleFinalize = async () => {
    try {
      const { deviceId, hardwareFp, clientDetails } = await generateHardwareFingerprint();

      const res = await fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          nodeId, 
          userId, 
          refId, 
          deviceId, 
          hardwareFp,
          clientDetails 
        })
      });
      const data = await res.json();
      if (data.success && !data.duplicate) {
        setStep('success');
      } else {
        setStep('fail');
        setReason(data.reason || (data.duplicate ? "🔴 Same Device / IP Detected! Multiple accounts from the same device are strictly prohibited." : "Verification failed."));
      }
    } catch (e) {
      setStep('fail');
      setReason("Connection error. Please tap Try Again.");
    }
  };

  const startScan = () => {
    setStep('verifying');
  };

  return (
    <div className="min-h-screen bg-[#05070a] text-white flex flex-col items-center justify-center p-6 font-sans select-none">
      <AnimatePresence mode="wait">
        {step === 'scan' && (
          <motion.div 
            key="scan"
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            className="flex flex-col items-center text-center space-y-8"
          >
            <div className="relative">
              <div className="w-36 h-36 rounded-full border-4 border-orange-600/30 flex items-center justify-center p-7 bg-orange-600/10 shadow-[0_0_40px_rgba(234,88,12,0.2)]">
                <Fingerprint className="w-full h-full text-orange-500 animate-pulse" />
              </div>
              <motion.div 
                animate={{ rotate: 360 }}
                transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}
                className="absolute inset-0 border-t-4 border-orange-500 rounded-full"
              />
            </div>
            
            <div className="space-y-3">
              <h1 className="text-3xl font-black tracking-tight uppercase">Security Handshake</h1>
              <p className="text-gray-400 max-w-xs text-xs font-medium">Verify your device hardware and network integrity to proceed with bot operations.</p>
            </div>

            <button 
              onClick={startScan}
              className="px-10 py-4 bg-orange-600 text-black font-black uppercase tracking-[0.2em] text-sm shadow-[0_0_30px_rgba(234,88,12,0.4)] hover:brightness-110 active:scale-95 transition-all rounded-lg"
            >
              Verify Device 🛡️
            </button>
          </motion.div>
        )}

        {step === 'verifying' && (
          <motion.div 
            key="verifying"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex flex-col items-center w-full max-w-sm"
          >
            <div className="w-full h-1.5 bg-white/10 mb-10 relative overflow-hidden rounded-full">
              <motion.div 
                className="absolute left-0 top-0 h-full bg-gradient-to-r from-orange-600 to-amber-400"
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
            
            <div className="flex flex-col items-center space-y-7">
              <div className="relative p-5 rounded-2xl bg-orange-600/10 border border-orange-500/20 shadow-lg">
                 <Lock className="w-12 h-12 text-orange-500 animate-bounce" />
              </div>
              <span className="text-xs font-mono tracking-[0.3em] text-gray-300 uppercase font-semibold">
                Scanning Hardware & IP... {Math.floor(Math.min(progress, 100))}%
              </span>
              
              <div className="grid grid-cols-2 gap-3 w-full opacity-70">
                <div className="p-3 border border-white/10 bg-white/[0.03] rounded-lg flex items-center gap-2.5">
                  <Activity className="w-4 h-4 text-orange-400" />
                  <span className="text-[9px] font-mono tracking-wider">HW_FINGERPRINT: OK</span>
                </div>
                <div className="p-3 border border-white/10 bg-white/[0.03] rounded-lg flex items-center gap-2.5">
                  <Lock className="w-4 h-4 text-orange-400" />
                  <span className="text-[9px] font-mono tracking-wider">IP_MATCH: RUNNING</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

        {step === 'success' && (
          <motion.div 
            key="success"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center text-center space-y-7"
          >
            <div className="w-24 h-24 rounded-full bg-green-500/20 border-2 border-green-500/40 flex items-center justify-center shadow-[0_0_30px_rgba(34,197,94,0.3)]">
              <ShieldCheck className="w-12 h-12 text-green-400" />
            </div>
            <div className="space-y-3">
              <h2 className="text-2xl font-black uppercase text-green-400">Verified Successfully ✅</h2>
              <p className="text-gray-400 text-xs max-w-xs">Your device and network have been verified. You can now return to the Telegram bot to continue earning!</p>
            </div>
            <button 
              onClick={() => {
                 const tg = (window as any).Telegram?.WebApp;
                 if (tg) tg.close();
                 else window.close();
              }}
              className="px-10 py-4 bg-green-600 text-black font-black uppercase tracking-widest text-xs rounded-lg shadow-lg hover:brightness-110"
            >
              Continue to Bot 🚀
            </button>
          </motion.div>
        )}

        {step === 'fail' && (
          <motion.div 
            key="fail"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex flex-col items-center text-center space-y-7"
          >
            <div className="w-24 h-24 rounded-full bg-red-500/20 border-2 border-red-500/40 flex items-center justify-center shadow-[0_0_30px_rgba(239,68,68,0.3)]">
              <ShieldAlert className="w-12 h-12 text-red-500" />
            </div>
            <div className="space-y-3 max-w-xs">
              <h2 className="text-2xl font-black uppercase text-red-500">Security Alert ⚠️</h2>
              <p className="text-red-400 text-xs font-semibold whitespace-pre-line leading-relaxed">{reason}</p>
            </div>
            <button 
              onClick={() => setStep('scan')}
              className="px-8 py-3 bg-white/10 border border-white/20 text-xs font-black uppercase tracking-widest rounded-lg hover:bg-white/20"
            >
              Try Again 🔄
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="fixed bottom-8 flex items-center gap-2 opacity-30">
        <Bot className="w-4 h-4" />
        <span className="text-[8px] font-mono uppercase tracking-[0.3em]">SR SECURITY ANTI-CHEAT ENGINE</span>
      </div>
    </div>
  );
}
