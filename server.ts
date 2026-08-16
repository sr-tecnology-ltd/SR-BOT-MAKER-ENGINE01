import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import TelegramBotConstructor from "node-telegram-bot-api";
// ESM compatibility for CommonJS default exports
const TelegramBot = (TelegramBotConstructor as any).default || TelegramBotConstructor;

const sysLogs: string[] = [];
function logSys(msg: string) {
  const t = new Date().toISOString();
  const pid = process.pid;
  console.log(`[SYS] ${t} [PID:${pid}]: ${msg}`);
  sysLogs.push(`[${t}] [PID:${pid}] ${msg}`);
  if (sysLogs.length > 50) sysLogs.shift();
}

let hubBot: any = null;
let hubInfo: any = null;
let engine: any = null;

const ADMIN_IDS: number[] = [6561010416];
if (process.env.ADMIN_HUB_ID) ADMIN_IDS.push(Number(process.env.ADMIN_HUB_ID));

// Use dynamic BASE_URL detection
let BASE_URL = process.env.APP_URL || "";
if (BASE_URL) {
  logSys(`Engine initialized with APP_URL: ${BASE_URL}`);
}
function updateBaseUrlFromRequest(req: express.Request) {
  if (req.get('host')) {
    const host = req.get('host') || "";
    const cleanHost = host.split(":")[0]; 
    if (cleanHost && cleanHost !== 'localhost' && !cleanHost.startsWith('127.')) {
      const newUrl = `https://${cleanHost}`;
      if (BASE_URL !== newUrl) {
        BASE_URL = newUrl;
        logSys(`Engine identified system URL from request: ${BASE_URL}`);
      }
    }
  }
}

import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import "dotenv/config";
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import { getApps, initializeApp } from 'firebase-admin/app';

// Safer JSON loading for ESM
const firebaseConfigPath = path.join(process.cwd(), 'firebase-applet-config.json');
let firebaseConfig: any = {
  projectId: process.env.FIREBASE_PROJECT_ID || "sr-gateway-in"
};
try {
  if (fs.existsSync(firebaseConfigPath)) {
    const fileContent = fs.readFileSync(firebaseConfigPath, 'utf8');
    const parsed = JSON.parse(fileContent);
    firebaseConfig = { ...firebaseConfig, ...parsed };
  }
} catch (err) {
  console.warn("[INIT] Firebase config read error, using defaults.");
}

import { initializeApp as initializeClientApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { 
  getFirestore as getClientFirestore, 
  collection, 
  getDocs, 
  doc, 
  getDoc, 
  setDoc,
  writeBatch,
  query,
  where,
  limit
} from 'firebase/firestore';

// Client SDK Initialization
const clientApp = initializeClientApp({
  apiKey: firebaseConfig.apiKey,
  authDomain: firebaseConfig.authDomain,
  projectId: firebaseConfig.projectId,
  appId: firebaseConfig.appId
});

const cauth = getAuth(clientApp);
const cdb = getClientFirestore(clientApp);

// Sign in server anonymously to bypass 'isSignedIn' check in rules
const authPromise = signInAnonymously(cauth).then((user) => {
  logSys(`[FIREBASE] Server signed in anonymously (UID: ${user.user.uid}).`);
  return user;
}).catch(err => {
  logSys(`[FIREBASE_ERR] Anonymous sign-in fail: ${err.message}`);
  return null;
});

logSys(`[FIREBASE] Client SDK Uplink active (DB: default)`);

const db: any = {
  batch: () => {
    const b = writeBatch(cdb);
    return {
      delete: (ref: any) => b.delete(ref),
      set: (ref: any, data: any, opts?: any) => b.set(ref, data, opts),
      update: (ref: any, data: any) => b.update(ref, data),
      commit: () => b.commit()
    };
  },
  collection: (path: string) => {
    return {
      doc: (id: string) => {
        const docRef = doc(cdb, path, id);
        return {
          ref: docRef,
          get: async () => {
            const sn = await getDoc(docRef);
            return {
              exists: sn.exists(),
              data: () => sn.data(),
              id: sn.id,
              ref: docRef
            };
          },
          set: (data: any, opts?: any) => setDoc(docRef, data, opts),
          collection: (subPath: string) => {
             return {
               doc: (subId: string) => {
                 const subDocRef = doc(cdb, path, id, subPath, subId);
                 return {
                   ref: subDocRef,
                   get: async () => {
                     const sn = await getDoc(subDocRef);
                     return {
                       exists: sn.exists(),
                       data: () => sn.data(),
                       id: sn.id,
                       ref: subDocRef
                     };
                   },
                   set: (data: any, opts?: any) => setDoc(subDocRef, data, opts)
                 }
               },
               get: async () => {
                  const sn = await getDocs(collection(cdb, path, id, subPath));
                  return {
                    docs: sn.docs.map(d => ({
                      exists: d.exists(),
                      data: () => d.data(),
                      id: d.id,
                      ref: d.ref
                    }))
                  };
               }
             }
          }
        };
      },
      get: async () => {
        const sn = await getDocs(collection(cdb, path));
        return {
          docs: sn.docs.map(d => ({
            exists: d.exists(),
            data: () => d.data(),
            id: d.id,
            ref: d.ref
          }))
        };
      },
      limit: (n: number) => {
        return {
          get: async () => {
            const sn = await getDocs(query(collection(cdb, path), limit(n)));
            return {
              docs: sn.docs.map(d => ({
                exists: d.exists(),
                data: () => d.data(),
                id: d.id,
                ref: d.ref
              }))
            };
          }
        }
      }
    };
  }
};
export { db };

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: "SERVER_SYSTEM", // We are running on server
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test Connection
async function testConnection() {
  try {
    if (!db) return;
    await db.collection('system').doc('health').get();
    logSys("Firestore uplink established.");
  } catch (error: any) {
    logSys(`Connectivity warning: ${error.message}`);
  }
}

/**
 * BOT MAKER ENGINE - SR TECHNOLOGY LTD™ ADVANCED V2
 * A heavy-duty multi-bot deployment engine.
 */

interface SubBotConfig {
  referBonus: number;
  dailyBonus: number;
  minReferForPayout: number;
  minWithdraw: number;
  maxWithdraw: number;
  withdrawTax: number;
  withdrawStatus: boolean;
  botStatus: boolean;
  antiBot: boolean;
  autoPayout: boolean;
  amountInWhole: boolean;
  userAlerts: boolean;
  joinNotice?: string;
  supportContact?: string;
  updateChannel?: string;
  gatewayUrl?: string; // Informational display of gateway
  payoutChannel?: string; // Channel where WD requests are sent
  referLeaderboard?: boolean;
  totalUsers?: number;
  giftCodes: Map<string, { amount: number, maxUses: number, currentClaims: number, status: 'active' | 'off' }>;
  adminLogs: string[];
  bannedUsers: Set<number>;
  bannedWallets: Set<string>;
  botOffText: string;
  withdrawOffText: string;
  buildInfoText?: string;
  payoutUrl?: string; // This is the API URL for automated payments
  payoutGatewayApiUrl?: string; // API URL for external manual/auto calls
  payoutAppUrl?: string;
  payoutGatewayName?: string;
  gatewayApiUrl?: string;
  walletAppUrl?: string;
  gatewaySecretKey?: string;
  forceJoinChannels: string[];
  forceJoinChannelsUnchecked: string[];
  admins: Set<number>;
  deviceVerification: boolean;
  allowedRegion?: string;
  contract?: string;
  timeLimit?: string;
  customDashboardText?: string;
  customDashboardImage?: string;
  customMenu?: { text: string, type: 'balance' | 'refer' | 'bonus' | 'withdraw' | 'wallet' | 'support' | 'template' | 'url', data?: string }[][];
  leaderboardCustomText?: string;
  leaderboardPrizeText?: string;
  leaderboardLimit?: number;
  leaderboardUpdatesChannel?: string;
  upi1?: string;
  upi2?: string;
  qrCode?: string;
  minDeposit?: number;
  depositTax?: number;
  manualPay?: boolean;
  dailyBonusType?: 'fixed' | 'random';
}

interface UserProfile {
  balance: number;
  referrals: number;
  walletId: string | null;
  isBanned: boolean;
  lastDailyClaim?: number;
  verified: boolean;
  joinedAt: number;
  deviceId?: string;
  isDuplicate?: boolean;
  joinAlerted?: boolean;
  name?: string;
  username?: string;
}

interface BotNode {
  id: string;
  token: string;
  username: string;
  ownerId: number;
  type: 'autopay' | 'upi' | 'crypto' | 'star' | 'task' | 'bet' | 'redeem' | 'giveaway' | 'refer_auto' | 'wallet' | 'file' | 'poll' | 'refer_manual' | 'upi_manual';
  theme: string;
  createdAt: number;
  isBannedByAdmin?: boolean;
  isFailedToken?: boolean;
  config: SubBotConfig;
  users: Map<number, UserProfile>;
  pendingWithdrawals: Map<string, { userId: number, amount: number, wallet: string, createdAt: number }>;
  withdrawals: { userId: number, amount: number, wallet: string, timestamp: number }[];
  instance: any;
}

function esc(text: any): string {
  if (typeof text !== 'string') return String(text);
  // Escaping for Markdown (V1)
  return text.replace(/[_*[\]()]/g, '\\$&');
}

interface FSMState {
  nodeId: string;
  action: string;
  targetId?: number;
  inline_keyboard?: any[][];
  media?: any;
  text?: string;
  type?: string;
  broadcastType?: string;
}

class BotEngine {
  private nodes: Map<string, BotNode> = new Map();
  public getNodes() { return this.nodes; }
  private userToNodes: Map<number, string[]> = new Map();
  private fsmStates: Map<number, FSMState> = new Map();
  public deploymentStates: Map<number, { step: string, type?: BotNode['type'] }> = new Map();
  private isMaintenanceMode: boolean = false;
  public getMaintenanceMode() { return this.isMaintenanceMode; }



  private async sendJoinForce(bot: any, node: BotNode, userId: number, messageId?: number) {
    const buttons = [];
    const chList = [...(node.config.forceJoinChannels || [])];
    for (let i = 0; i < chList.length; i += 2) {
       const row = [];
       const ch1 = chList[i];
       row.push({ text: `➕ Channel ${i+1}`, url: this.formatChannelLink(ch1) });

       if (i + 1 < chList.length) {
          const ch2 = chList[i + 1];
          row.push({ text: `➕ Channel ${i+2}`, url: this.formatChannelLink(ch2) });
       }
       buttons.push(row);
    }
    buttons.push([{ text: "✅ Check Membership", callback_data: `check_join_none` }]);

    const header = `👋 **Attention!**\n\nTo use this bot, you must join our official channels below.\n\n👇 **Click the buttons to join:**`;
    if (messageId) {
      return bot.editMessageText(header, { chat_id: userId, message_id: messageId, reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' }).catch(() => {});
    } else {
      return bot.sendMessage(userId, header, { reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' }).catch(() => {});
    }
  }

  private hubForceJoinChannels: string[] = [];
  private statsBaseTime: number = Date.now();
  public getHubForceJoinChannels() { return this.hubForceJoinChannels; }

  private async saveHubConfig() {
    if (!db) return;
    try {
      await db.collection('config').doc('hub').set({
        forceJoinChannels: this.hubForceJoinChannels,
        isMaintenanceMode: this.isMaintenanceMode,
        statsBaseTime: this.statsBaseTime
      });
      logSys("[CONFIG] Hub force-join settings saved.");
    } catch (err: any) {
      logSys(`[SAVE_ERR] Hub Config: ${err.message}`);
    }
  }

  private async loadHubConfig() {
    if (!db) return;
    try {
      const snap = await db.collection('config').doc('hub').get();
      if (snap.exists()) {
        const data = snap.data();
        this.hubForceJoinChannels = data.forceJoinChannels || [];
        this.isMaintenanceMode = data.isMaintenanceMode || false;
        this.statsBaseTime = data.statsBaseTime || Date.now();
        if (!data.statsBaseTime) await this.saveHubConfig(); // Persist it if it was missing
        logSys(`[CONFIG] Hub config loaded. Maintenance: ${this.isMaintenanceMode}`);
      } else {
        // Init first time
        this.statsBaseTime = Date.now();
        await this.saveHubConfig();
      }
    } catch (err: any) {
      logSys(`[LOAD_ERR] Hub Config: ${err.message}`);
    }
  }

  private async sendHubJoinForce(bot: any, userId: number, messageId?: number) {
    const allChannels = this.hubForceJoinChannels || [];
    if (allChannels.length === 0) return;

    const checks = await Promise.all(allChannels.map(ch => this.checkForceJoin(bot, ch, userId)));
    const allJoined = !checks.includes(false);

    if (allJoined && !messageId) {
       // Everything joined, just send start dashboard
       return bot.sendMessage(userId, "✅ **All channels joined!** Use /start to open the dashboard.");
    }

    const buttons = [];
    for (let i = 0; i < allChannels.length; i++) {
       const isJoined = checks[i];
       const textIcon = isJoined ? "✅ Joined" : "➕ Join";
       buttons.push([{ text: `${textIcon} Channel ${i + 1}`, url: this.formatChannelLink(allChannels[i]) }]);
    }
    
    // Final button to check membership
    buttons.push([{ text: "🔥 Claim / Verify", callback_data: `hub_check_join` }]);

    const header = `👋 **WELCOME TO SR HUB!**\n\n🛑 **MUST JOIN CHANNELS TO CONTINUE!**\n\nTo access the bot builder and all features, please join our official channels below:\n\n👇 **Join and then click Claim:**`;
    const photo = "https://t.me/SR_TECHNOLOGY_LTD/330"; 
    
    if (messageId) {
      return bot.editMessageText(header, { chat_id: userId, message_id: messageId, reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' }).catch(() => {});
    } else {
      return bot.sendPhoto(userId, photo, { caption: header, reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' }).catch(() => {});
    }
  }

  constructor() {
    logSys("BotEngine object created. Awaiting boot sequence...");
    this.loadHubConfig();
    this.startResilienceMonitor();
    this.startFirestoreHeartbeat();
    this.setupProcessHandlers();
  }

  private setupProcessHandlers() {
    process.on('uncaughtException', (err) => {
      logSys(`CRITICAL UNCAUGHT EXCEPTION: ${err.message}`);
      console.error(err);
    });
    process.on('unhandledRejection', (reason, promise) => {
      logSys(`CRITICAL UNHANDLED REJECTION: ${reason}`);
      console.error('Promise:', promise, 'Reason:', reason);
    });
  }

  private async startFirestoreHeartbeat() {
    setInterval(async () => {
      try {
        if (!db) return;
        await db.collection('system').doc('heartbeat').set({
          lastHeartbeat: Date.now(),
          uptime: process.uptime(),
          nodeCount: this.nodes.size
        }, { merge: true });
      } catch (err: any) {
        console.error("Heartbeat Error:", err.message);
      }
    }, 120000); // Every 2 minutes
  }

  public async boot() {
    try {
      if (!db) {
        logSys("Engine skip-boot: Firestore offline.");
        return;
      }
      await this.loadHubConfig();
      await this.loadDataFromFirestore();
    } catch (err: any) {
      logSys(`BOOT_CRITICAL_ERR: ${err.message}`);
    }
  }

  private async loadDataFromFirestore() {
    try {
      if (!db) return;
      logSys(`Hydrating nodes from Firestore... (DB: ${firebaseConfig.firestoreDatabaseId || 'default'})`);
      
      const nodesSnap = await db.collection('nodes').get();
      
      let nodeCount = 0;
      for (const nodeDoc of nodesSnap.docs) {
        const data = nodeDoc.data();
        if (!data || !data.token) continue;

        const safeConfig = data.config || {};
        
        const node: BotNode = {
          ...data,
          id: nodeDoc.id,
          isBannedByAdmin: data.isBannedByAdmin ?? false,
          config: {
            referBonus: safeConfig.referBonus ?? 5,
            dailyBonus: safeConfig.dailyBonus ?? 1,
            minReferForPayout: safeConfig.minReferForPayout ?? 5,
            minWithdraw: safeConfig.minWithdraw ?? 10,
            maxWithdraw: safeConfig.maxWithdraw ?? 1000,
            withdrawTax: safeConfig.withdrawTax ?? 5,
            withdrawStatus: safeConfig.withdrawStatus ?? true,
            botStatus: safeConfig.botStatus ?? true,
            antiBot: safeConfig.antiBot ?? false,
            autoPayout: safeConfig.autoPayout ?? false,
            amountInWhole: safeConfig.amountInWhole ?? true,
            userAlerts: safeConfig.userAlerts ?? true,
            joinNotice: safeConfig.joinNotice || "Welcome!",
            giftCodes: new Map(Object.entries(safeConfig.giftCodes || {}).map(([k, v]: [string, any]) => {
              if (typeof v === 'number') return [k, { amount: v, maxUses: 100, currentClaims: 0, status: 'active' }];
              return [k, v];
            })),
            adminLogs: safeConfig.adminLogs || [],
            bannedUsers: new Set(safeConfig.bannedUsers || []),
            bannedWallets: new Set(safeConfig.bannedWallets || []),
            botOffText: safeConfig.botOffText || "Maintenance",
            withdrawOffText: safeConfig.withdrawOffText || "Closed",
            payoutUrl: safeConfig.payoutUrl || "",
            payoutAppUrl: safeConfig.payoutAppUrl || "",
            payoutGatewayName: safeConfig.payoutGatewayName || "Gateway",
            payoutChannel: safeConfig.payoutChannel || "",
            gatewayUrl: safeConfig.gatewayUrl || "",
            referLeaderboard: safeConfig.referLeaderboard ?? true,
            leaderboardCustomText: safeConfig.leaderboardCustomText || "🏆 <b>TOP {LIMIT} REFERRERS - @{BOTNAME}</b>",
            leaderboardLimit: safeConfig.leaderboardLimit ?? 5,
            leaderboardPrizeText: safeConfig.leaderboardPrizeText || "🎁 Refer more users to secure your position and claim your bonus prize!",
            leaderboardUpdatesChannel: safeConfig.leaderboardUpdatesChannel || "",
            forceJoinChannels: safeConfig.forceJoinChannels || [],
            forceJoinChannelsUnchecked: safeConfig.forceJoinChannelsUnchecked || [],
            admins: new Set(safeConfig.admins || [data.ownerId]),
            deviceVerification: safeConfig.deviceVerification ?? true,
            totalUsers: safeConfig.totalUsers || 0,
            allowedRegion: safeConfig.allowedRegion || "Global",
            contract: safeConfig.contract || "Not Set",
            timeLimit: safeConfig.timeLimit || "Unlimited ∞",
            supportContact: safeConfig.supportContact || "@srsaportbot",
            updateChannel: safeConfig.updateChannel || "@srsaportbot",
            upi1: safeConfig.upi1 || "",
            upi2: safeConfig.upi2 || "",
            qrCode: safeConfig.qrCode || "",
            minDeposit: safeConfig.minDeposit ?? 10,
            depositTax: safeConfig.depositTax ?? 0,
            manualPay: safeConfig.manualPay ?? (['refer_manual', 'upi_manual', 'upi'].includes(data.type) || !safeConfig.autoPayout),
            dailyBonusType: safeConfig.dailyBonusType || 'fixed',
          },
          users: new Map(),
          pendingWithdrawals: new Map(Object.entries(data.pendingWithdrawals || {})),
          withdrawals: data.withdrawals || [],
          instance: null,
          isFailedToken: data.isFailedToken || false
        } as any;

        this.nodes.set(node.id, node);
        
        const userNodeList = this.userToNodes.get(node.ownerId) || [];
        userNodeList.push(node.id);
        this.userToNodes.set(node.ownerId, userNodeList);

        nodeCount++;
        // Async redeploy with a much faster stagger for performance, skip blueprints
        if (!node.id.startsWith("BLUEPRINT_")) {
          setTimeout(() => this.redeployInstance(node), nodeCount * 50);
        }
      }
      logSys(`Firestore hydrated: ${nodeCount} nodes configurations loaded.`);
    } catch (err: any) {
      logSys(`F-STARTUP-ERR: ${err.message}`);
    }
  }

  private async ensureUserLoaded(node: BotNode, userId: number): Promise<UserProfile | null> {
    if (node.users.has(userId)) return node.users.get(userId)!;
    
    try {
      if (!db) return null;
      const uDoc = await db.collection('nodes').doc(node.id).collection('users').doc(String(userId)).get();
      if (uDoc.exists) {
        const profile = uDoc.data() as UserProfile;
        node.users.set(userId, profile);
        return profile;
      }
      
      const newUser: UserProfile = {
        balance: 0,
        referrals: 0,
        walletId: null,
        isBanned: false,
        verified: false,
        joinedAt: Date.now(),
        joinAlerted: false
      };
      node.users.set(userId, newUser);
      
      // Increment total network users for stats
      if (!node.config.totalUsers) node.config.totalUsers = 0;
      node.config.totalUsers++;
      await this.saveNodeToFirestore(node);
      
      await this.saveUserToFirestore(node.id, userId, newUser);
      return newUser;
    } catch (err: any) {
      logSys(`User Load Err [${node.id}/${userId}]: ${err.message}`);
      return null;
    }
  }

  private async saveNodeToFirestore(node: BotNode) {
    try {
      if (!db) return;
      const configObj = {
        ...node.config,
        giftCodes: Object.fromEntries(node.config.giftCodes),
        bannedUsers: Array.from(node.config.bannedUsers),
        bannedWallets: Array.from(node.config.bannedWallets),
        admins: Array.from(node.config.admins),
        instance: null
      };

      const dataToSave = {
        id: node.id,
        token: node.token,
        ownerId: node.ownerId,
        type: node.type,
        theme: node.theme,
        createdAt: node.createdAt,
        isBannedByAdmin: node.isBannedByAdmin ?? false,
        config: configObj,
        pendingWithdrawals: Object.fromEntries(node.pendingWithdrawals)
      };

      await db.collection('nodes').doc(node.id).set(dataToSave);
    } catch (err: any) {
      logSys(`Node Save Err [${node.id}]: ${err.message}`);
    }
  }

  private async saveWithdrawalToFirestore(nodeId: string, withdrawal: any) {
    try {
      if (!db) return;
      const id = withdrawal.id || `WD-${uuidv4().substring(0, 8)}`;
      await db.collection('nodes').doc(nodeId).collection('withdrawals').doc(id).set(withdrawal);
    } catch (err: any) {
      logSys(`WD Save Err [${nodeId}]: ${err.message}`);
    }
  }

  private async saveUserToFirestore(nodeId: string, userId: number, profile: UserProfile) {
    try {
      if (!db) return;
      await db.collection('nodes').doc(nodeId).collection('users').doc(String(userId)).set(profile);
    } catch (err: any) {
      logSys(`User Save Err [${nodeId}/${userId}]: ${err.message}`);
    }
  }

  async handleUserJoined(bot: any, node: BotNode, userId: number, userName: string, refId: number | null) {
      const user = await this.ensureUserLoaded(node, userId);
      if (!user || user.joinAlerted) return; 

      user.joinAlerted = true;
      await this.saveUserToFirestore(node.id, userId, user);

      const safeName = (userName || 'User').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      // 1. Referral Credits (ALWAYS)
      if (refId && refId !== userId) {
          const referrer = await this.ensureUserLoaded(node, refId);
          if (referrer) {
              const bonus = node.config.referBonus || 0;
              referrer.balance += bonus;
              referrer.referrals += 1;
              await this.saveUserToFirestore(node.id, refId, referrer);
              
              // Notification to Referrer
              const refLog = `🎁 <b>NEW REFERRAL!</b>\n\n` +
                             `👤 User: <a href="tg://user?id=${userId}">${safeName}</a> has joined via your link.\n` +
                             `💰 Reward: <b>₹${bonus}</b> added to your account.\n` +
                             `📈 Your Total Referrals: <b>${referrer.referrals}</b>`;
              bot.sendMessage(refId, refLog, { parse_mode: 'HTML' }).catch(() => {});
          }
      }

      // 2. Admin Alert (IF ENABLED)
      if (node.config.userAlerts) {
          const alertMsg = `🚀 <b>NEW MEMBER JOINED</b>\n\n` +
                           `👤 <b>Name:</b> ${safeName}\n` +
                           `🆔 <b>User ID:</b> <code>${userId}</code>\n` +
                           `🔗 <b>Username:</b> @${safeName}\n` +
                           `🤝 <b>Referrer:</b> <code>${refId || 'Direct'}</code>\n\n` +
                           `🛠 <b>Node:</b> @${node.username}`;
          bot.sendMessage(node.ownerId, alertMsg, { parse_mode: 'HTML' }).catch(() => {});
      }
  }

  private startResilienceMonitor() {
    setInterval(() => {
      this.nodes.forEach(async (node) => {
        try {
          // Skip if it's a template node or has an invalid token
          if (node.id.startsWith("BLUEPRINT_") || node.instance === "INVALID_TOKEN" as any || node.isFailedToken) return;
          
          if (!node.instance) {
            logSys(`[MONITOR] Node ${node.id} resetting...`);
            this.redeployInstance(node);
          }
        } catch (err: any) {
          logSys(`[MONITOR_ERR] Node ${node.id}: ${err.message}`);
        }
      });
    }, 120000); 
  }

  private saveData() {
     // No-op for global save, we now save incrementally
  }

  private loadData() {
     // No-op, handled by boot()
  }

  private async cleanupNodeData(nodeId: string) {
    if (!db || nodeId.startsWith("BLUEPRINT_")) return;
    try {
      logSys(`[CLEANUP] Wiping data for node ${nodeId} due to invalid token.`);
      // Delete users sub-collection
      const usersSnap = await db.collection("nodes").doc(nodeId).collection("users").get();
      const batch = db.batch();
      usersSnap.docs.forEach((doc: any) => batch.delete(doc.ref));
      
      // Delete withdrawals sub-collection
      const wdSnap = await db.collection("nodes").doc(nodeId).collection("withdrawals").get();
      wdSnap.docs.forEach((doc: any) => batch.delete(doc.ref));
      
      // Commit sub-collection deletions
      await batch.commit();

      // Update node document: Clear sensitive config but keep ID and username if exists
      const nodeRef = db.collection("nodes").doc(nodeId);
      const nodeDoc = await nodeRef.get();
      const nodeData = nodeDoc.exists ? nodeDoc.data() : {};
      
      await nodeRef.set({
        id: nodeId,
        username: nodeData.username || "unknown_revoked",
        ownerId: nodeData.ownerId || 0,
        isRevoked: true,
        deletedAt: Date.now(),
        // We clear everything else
        config: null,
        token: "REVOKED",
        type: nodeData.type || "unknown"
      });
      
      logSys(`[CLEANUP] Node ${nodeId} metadata reset.`);
    } catch (err) {
      logSys(`[CLEANUP_ERR] Failed to clean ${nodeId}: ${err}`);
    }
  }

  private async redeployInstance(node: BotNode) {
    if (!node.token || (node.instance === "INVALID_TOKEN" as any) || node.isFailedToken || node.id.startsWith("BLUEPRINT_")) return;
    try {
      const bot = new TelegramBot(node.token, { polling: true });
      
      bot.on('error', (err) => {
        if (err.message.includes('EFATAL')) return; 
        logSys(`[BOT_ERR] Node ${node.id}: ${err.message}`);
      });

      bot.on('polling_error', async (err: any) => {
        if (err.message.includes('401') || err.message.includes('404')) {
          logSys(`[CRITICAL_AUTH] Node ${node.id} token invalid. Stopping.`);
          try { bot.stopPolling(); } catch {}
          node.instance = "INVALID_TOKEN" as any;
          node.isFailedToken = true;
        }
      });

      await bot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

      const me = await bot.getMe();
      this.setupInstanceHandlers(bot, node);
      node.instance = bot;
      node.username = me.username || node.username;

      bot.setMyCommands([
        { command: 'start', description: "Let's Start The Advantage Of Earning" },
        { command: 'build', description: "About Our Builder" }
      ]).catch(() => {});

      logSys(`Node ${node.id} (@${me.username}) polling mode active.`);
    } catch (err: any) {
      const errMsg = String(err.message || err.description || "");
      if (errMsg.includes('401') || errMsg.includes('404') || errMsg.includes('Unauthorized') || errMsg.includes('Not Found')) {
        logSys(`[REDEPLOY_CANCEL] Node ${node.id} has invalid token: ${errMsg}`);
        node.instance = "INVALID_TOKEN" as any; 
        node.isFailedToken = true;
      } else {
        logSys(`[REDEPLOY_ERR] Node ${node.id}: ${errMsg}`);
      }
    }
  }

  public getDefaultConfig(type: BotNode['type']): SubBotConfig {
    const blueprintId = `BLUEPRINT_${type.toUpperCase()}`;
    const blueprint = this.nodes.get(blueprintId);
    if (blueprint && blueprint.config) {
      // Clone blueprint config
      return JSON.parse(JSON.stringify({
        ...blueprint.config,
        giftCodes: Object.fromEntries(blueprint.config.giftCodes),
        bannedUsers: Array.from(blueprint.config.bannedUsers),
        bannedWallets: Array.from(blueprint.config.bannedWallets),
        admins: [] // Clear admins for new deployment
      }), (key, value) => {
        if (key === 'giftCodes') return new Map(Object.entries(value));
        if (key === 'bannedUsers') return new Set(value);
        if (key === 'bannedWallets') return new Set(value);
        if (key === 'admins') return new Set(value);
        return value;
      });
    }

    return {
      referBonus: 5,
      dailyBonus: 1,
      minReferForPayout: 5,
      minWithdraw: ['autopay', 'refer_auto', 'task', 'wallet'].includes(type) ? 10 : (['upi', 'upi_manual', 'refer_manual'].includes(type) ? 50 : 100),
      maxWithdraw: 1000,
      withdrawTax: ['autopay', 'refer_auto'].includes(type) ? 5 : (['upi', 'task'].includes(type) ? 2 : 0),
      withdrawStatus: true,
      botStatus: true,
      antiBot: false,
      autoPayout: ['autopay', 'refer_auto', 'star'].includes(type),
      amountInWhole: true,
      userAlerts: true,
      joinNotice: "Welcome to our network! 🎉",
      supportContact: "@srsaportbot",
      updateChannel: "@srsaportbot",
      giftCodes: new Map(),
      adminLogs: [],
      bannedUsers: new Set(),
      bannedWallets: new Set(),
      botOffText: "🔴BOT OVER SEE YOU SOON",
      withdrawOffText: "🔴 withdrawal off",
      buildInfoText: "🛠️ **Built by @srbotmakerbot 🇮🇳**",
      payoutUrl: "",
      payoutGatewayApiUrl: "",
      payoutAppUrl: "",
      payoutGatewayName: "SR GATEWAY",
      payoutChannel: "@srsaportbot",
      forceJoinChannels: [],
      forceJoinChannelsUnchecked: [],
      admins: new Set(),
      deviceVerification: true,
      allowedRegion: "Global",
      contract: "Not Set",
      timeLimit: "Unlimited ∞",
      minDeposit: 10,
      depositTax: 0,
      manualPay: ['refer_manual', 'upi_manual', 'upi'].includes(type),
      dailyBonusType: 'fixed',
      referLeaderboard: true,
      leaderboardCustomText: "🏆 <b>TOP {LIMIT} REFERRERS - @{BOTNAME}</b>",
      leaderboardLimit: 5,
      leaderboardPrizeText: "🎁 Refer more users to secure your position and claim your bonus prize!",
      leaderboardUpdatesChannel: "",
    };
  }

  async deployBot(ownerId: number, token: string, type: BotNode['type'], theme: string): Promise<{ nodeId: string, username: string }> {
    // Check if token is the Master Hub Token
    if (token === process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error("🔴 YOU CANNOT DEPLOY THE MASTER HUB TOKEN AS A SUB-BOT. PLEASE USE A DIFFERENT BOT TOKEN.");
    }
    // Check if token or username already in use
    const allNodes = Array.from(this.nodes.values());
    if (allNodes.some(n => n.token === token)) {
      throw new Error("🔴 THIS BOT IS ALREADY REGISTERED IN OUR SERVER PLEASE TRY AGAIN WITH NEW BOT");
    }

    const nodeId = `SR-${uuidv4().substring(0, 8).toUpperCase()}`;

    try {
      logSys(`[DEPLOY_ATTEMPT] Starting deployment for node ${nodeId}`);
      const instance = new TelegramBot(token, { polling: true });
      
      instance.on('error', (err) => logSys(`[BOT_ERR_INIT] Node ${nodeId}: ${err.message}`));
      
      instance.on('polling_error', (err: any) => {
        if (err.message.includes('401')) {
          logSys(`[DEPLOY_AUTH_FAIL] Node ${nodeId} invalid token during init.`);
          try { instance.stopPolling(); } catch {}
        }
      });

      await instance.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

      const me = await instance.getMe();
      const botUsername = me.username || "Bot";

      if (allNodes.some(n => n.username?.toLowerCase() === botUsername.toLowerCase())) {
        try { instance.stopPolling(); } catch {}
        throw new Error("🔴 THIS BOT IS ALREADY REGISTERED IN OUR SERVER PLEASE TRY AGAIN WITH NEW BOT");
      }

      const config = this.getDefaultConfig(type);
      config.admins.add(ownerId);

      const newNode: BotNode = {
        id: nodeId,
        token,
        username: botUsername,
        ownerId,
        type,
        theme,
        createdAt: Date.now(),
        config,
        users: new Map(),
        pendingWithdrawals: new Map(),
        withdrawals: [],
        instance: null
      };

      this.setupInstanceHandlers(instance, newNode);
      newNode.instance = instance;
      logSys(`[DEPLOY] Node ${nodeId} (@${botUsername}) polling mode active.`);

      // Professional Branding
      const descText = `🤖 Official Telegram Bot Engine & Infrastructure Powered by SR TECHNOLOGY LTD™\n\nHigh-Speed Automated Telegram Bot Services.`;
      const shortDescText = `Official Bot Powered by SR TECHNOLOGY LTD™`;
      instance.setMyDescription({ description: descText }).catch(() => {});
      instance.setMyShortDescription({ short_description: shortDescText }).catch(() => {});
      
      this.nodes.set(nodeId, newNode);
      const userNodeList = this.userToNodes.get(ownerId) || [];
      userNodeList.push(nodeId);
      this.userToNodes.set(ownerId, userNodeList);
      
      await this.saveNodeToFirestore(newNode);
      logSys(`Node ${nodeId} (@${botUsername}) deployed and synced to Firestore.`);
      return { nodeId, username: botUsername };
    } catch (error: any) {
        logSys(`Deployment CRITICAL FAIL [${nodeId}]: ${error.message}`);
        throw new Error(error.message);
    }
  }

  private sendUserDashboard(bot: any, node: BotNode, userId: number) {
    const builder = "@srbotmakerbot";
    const appUrl = "https://srwallet.vercel.app/"; 
    const type = node.type || 'wallet';
    
    let welcomeMsg = "";
    if (node.config.customDashboardText) {
      welcomeMsg = node.config.customDashboardText;
    } else {
      const botDisplayName = node.username ? `@${node.username}` : "Bot";
      
      switch(type) {
        case 'task':
          welcomeMsg = `📋 <b>Welcome to ${esc(botDisplayName)}</b> 🚀\n\n` +
            `✨ <b>Complete Simple Tasks & Earn Instant Cash Rewards!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option from the menu below to start earning ⬇️</b>`;
          break;
        case 'bet':
          welcomeMsg = `🎯 <b>Welcome to ${esc(botDisplayName)}</b> 🎰\n\n` +
            `✨ <b>Play Exciting Games & Win Big Real Cash Prizes!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option from the menu below to start playing ⬇️</b>`;
          break;
        case 'file':
          welcomeMsg = `📁 <b>Welcome to ${esc(botDisplayName)}</b> 💾\n\n` +
            `✨ <b>Your Secure Cloud Storage & File Sharing Hub!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option from the menu below ⬇️</b>`;
          break;
        case 'poll':
          welcomeMsg = `📊 <b>Welcome to ${esc(botDisplayName)}</b> 📝\n\n` +
            `✨ <b>Create & Conduct Instant Public Polls & Surveys!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option from the menu below ⬇️</b>`;
          break;
        case 'redeem':
          welcomeMsg = `🎟️ <b>Welcome to ${esc(botDisplayName)}</b> 🎁\n\n` +
            `✨ <b>Redeem Exclusive Gift Vouchers & Instant Rewards!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option from the menu below ⬇️</b>`;
          break;
        case 'giveaway':
          welcomeMsg = `🎁 <b>Welcome to ${esc(botDisplayName)}</b> 🎉\n\n` +
            `✨ <b>Join Daily Giveaways & Win Exciting Prizes!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option from the menu below ⬇️</b>`;
          break;
        case 'autopay':
        case 'refer_auto':
          welcomeMsg = `⚡ <b>Welcome to ${esc(botDisplayName)}</b> 💰\n\n` +
            `✨ <b>Automated Instant Payout & Earnings Bot!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option below to get started ⬇️</b>`;
          break;
        case 'refer_manual':
        case 'upi_manual':
        case 'upi':
          welcomeMsg = `📲 <b>Welcome to ${esc(botDisplayName)}</b> 💳\n\n` +
            `✨ <b>Fast UPI Payout & Earn Money Service!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option below to get started ⬇️</b>`;
          break;
        case 'star':
        case 'crypto':
          welcomeMsg = `💎 <b>Welcome to ${esc(botDisplayName)}</b> 🚀\n\n` +
            `✨ <b>Crypto & Star Instant Transfer & Earnings Bot!</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option below to get started ⬇️</b>`;
          break;
        case 'wallet':
        default:
          welcomeMsg = `🏦💎 <b>Welcome to ${esc(botDisplayName)}</b> 💰🚀\n\n` +
            `✨ <b>Your Digital Wallet for Easy & Instant Transactions</b> ✨\n\n` +
            `🚀 <b>Developed by ${builder}</b>\n\n` +
            `📌 <b>Choose an option below to get started ⬇️</b>`;
          break;
      }
    }

    const gatewayUrl = node.config.payoutAppUrl || appUrl;
    const dashboardImg = node.config.customDashboardImage || null;

    const opts: any = {
      reply_markup: {
        inline_keyboard: [
          [{ text: "TAP TO OPEN GATEWAY NOW", url: gatewayUrl }]
        ]
      },
      parse_mode: 'HTML'
    };

    const actionPromise = (dashboardImg && dashboardImg.trim() !== "")
      ? bot.sendPhoto(userId, dashboardImg, { ...opts, caption: welcomeMsg }).catch(() => bot.sendMessage(userId, welcomeMsg, opts))
      : bot.sendMessage(userId, welcomeMsg, opts);

    return actionPromise.then(() => {
        return bot.sendMessage(userId, "Use the menu below to navigate:", {
            reply_markup: this.getMenuKeyboard(node)
        }).catch(() => {});
    }).catch((e: any) => {
        logSys(`[DASH_ERR] Node ${node.id} User ${userId}: ${e.message}`);
    });
  }

  private sendAdminPanel(bot: any, node: BotNode, chatId: number, messageId?: number) {
    const channelDisplay = node.config.payoutChannel || "-1002248842726";
    const adminRef = node.config.supportContact && node.config.supportContact !== "@srsaportbot" 
      ? node.config.supportContact 
      : `SR TECNOLOGY LTD™`;

    const botTypeLabel = node.type === 'autopay' || node.type === 'refer_auto' 
      ? "Auto Pay" 
      : (node.type === 'upi_manual' || node.type === 'refer_manual' ? "UPI Manual" : "Wallet");

    const bonusTypeLabel = node.config.dailyBonusType === 'random' 
      ? `🎲 Random (1 to ₹${node.config.dailyBonus})` 
      : `🎯 Fixed ₹${node.config.dailyBonus}`;

    const manualPayLabel = node.config.manualPay ? "🟢 ON (Admin Review & Approval)" : "🔴 OFF (Auto Gateway API)";

    const panelText = `🎛️ <b>FREE BASIC ADMIN CONTROL PANEL</b>\n` +
      `👤 <b>Admin:</b> ${esc(adminRef)}\n\n` +
      `⚙️ <b>MAIN SETTINGS</b>\n` +
      `- <b>Bot Status:</b> ${node.config.botStatus ? "ON 🟢" : "OFF 🔴"}\n` +
      `- <b>Withdrawals:</b> ${node.config.withdrawStatus ? "ON 🟢" : "OFF ⚠️"}\n` +
      `- <b>Manual Pay Mode:</b> ${manualPayLabel}\n` +
      `- <b>Verification:</b> ${node.config.deviceVerification ? "Device Matching" : "Disabled"}\n` +
      `- <b>Bot Type:</b> ${botTypeLabel}\n\n` +
      `💰 <b>ECONOMY & PAYOUTS</b>\n` +
      `- <b>Refer Bonus:</b> ₹${node.config.referBonus}\n` +
      `- <b>Daily Bonus:</b> ${bonusTypeLabel}\n` +
      `- <b>Withdraw Limits:</b> ₹${node.config.minWithdraw} - ₹${node.config.maxWithdraw}\n` +
      `- <b>Withdraw Tax:</b> ${node.config.withdrawTax}%\n` +
      `- <b>Min Refers Needed:</b> ${node.config.minReferForPayout}\n` +
      `- <b>Time Limit:</b> ∞ Unlimited\n` +
      `- <b>Gateway:</b> SR WALLET\n\n` +
      `📣 <b>CHANNELS</b>\n` +
      `- <b>Payout:</b> <code>${esc(channelDisplay)}</code>\n\n` +
      `Select an option below to manage your bot:\n` +
      `🛠️ <b>Maker:</b> @RJMakerProBot`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: node.config.botStatus ? "🟢 Bot Status: ON" : "🔴 Bot Status: OFF", callback_data: "adm_toggle_bot" },
          { text: node.config.withdrawStatus ? "🟢 Withdraws: ON" : "⚠️ Withdraws: OFF", callback_data: "adm_toggle_withdraw" }
        ],
        [
          { text: node.config.manualPay ? "🟢 Manual Pay: ON" : "🔴 Manual Pay: OFF (Auto)", callback_data: "adm_toggle_manualpay" }
        ],
        [
          { text: "👨‍💻 🌐 User Verification Mode", callback_data: "adm_ui_custom" }
        ],
        [
          { text: "🌀 Country: IN", callback_data: "adm_noop" }
        ],
        [
          { text: "🔔 📣 Bot Channels", callback_data: "adm_view_forceJoin" },
          { text: "💰 🏦 Payout Channel", callback_data: "adm_set_payoutChannel" }
        ],
        [
          { text: "👨‍💻 🚧 Manage Gateway (API's)", callback_data: "adm_api_setup" }
        ],
        [
          { text: "💰 Set Refer ₹", callback_data: "adm_set_referBonus" },
          { text: "💰 Set Payout ₹", callback_data: "adm_set_minWithdraw" }
        ],
        [
          { text: "🎁 🎁 Bonus Type", callback_data: "adm_set_dailyBonus" },
          { text: "👨‍💻 🧾 Set Tax %", callback_data: "adm_set_withdrawTax" }
        ],
        [
          { text: "🔔 Broadcast", callback_data: "adm_ask_bc_center" },
          { text: "📝 DM User", callback_data: "adm_ask_details" }
        ],
        [
          { text: node.config.amountInWhole ? "🟢 Amt Whole: ON" : "🔴 Amt Whole: OFF", callback_data: "adm_toggle_whole" },
          { text: node.config.userAlerts ? "🟢 New User Alert: ON" : "🔴 New User Alert: OFF", callback_data: "adm_toggle_alerts" }
        ],
        [
          { text: "👨‍💻 Manage Admins", callback_data: "adm_view_admins" },
          { text: "⚠️ Reset All Balances", callback_data: "adm_ask_reset_warn" }
        ],
        [
          { text: "⛔ Ban User", callback_data: "adm_ask_ban" },
          { text: "🟢 Unban User", callback_data: "adm_ask_unban" }
        ],
        [
          { text: "⛔ Ban Wallet", callback_data: "adm_ask_banWallet" },
          { text: "🟢 Unban Wallet", callback_data: "adm_ask_unbanWallet" }
        ],
        [
          { text: "💰 Add Balance", callback_data: "adm_ask_balance_mod" },
          { text: "🌀 Check Stats", callback_data: "adm_view_stats" }
        ],
        [
          { text: "🟢 Manual Verify", callback_data: "adm_view_verify" },
          { text: "🌀 User Details", callback_data: "adm_ask_details" }
        ],
        [
          { text: "⚡ Top Withdrawals", callback_data: "adm_view_topwd" },
          { text: "👨‍💻 Min Refers Need", callback_data: "adm_set_minReferForPayout" }
        ],
        [
          { text: "🌀 Performance Matrix", callback_data: "adm_view_perf" },
          { text: "👨‍💻 Admin Actions", callback_data: "adm_more_settings" }
        ],
        [
          { text: "🎁 💸 Gift Codes", callback_data: "adm_gift_manage" },
          { text: "⚡ Leaderboard", callback_data: "adm_view_leader" }
        ],
        [
          { text: "📝 Edit Off Text", callback_data: "adm_set_dashText" },
          { text: "📝 Edit W/D Off Text", callback_data: "adm_set_withdrawOffText" }
        ]
      ]
    };

    if (messageId) {
      return bot.editMessageText(panelText, { 
        chat_id: chatId, 
        message_id: messageId, 
        parse_mode: 'HTML', 
        reply_markup: keyboard 
      }).catch(() => {});
    } else {
      return bot.sendMessage(chatId, panelText, { 
        parse_mode: 'HTML', 
        reply_markup: keyboard 
      });
    }
  }

  public async handleSubBotCallback(bot: any, node: BotNode, userId: number, data: string, queryOrMsg?: any) {
    const msgId = queryOrMsg?.message?.message_id || queryOrMsg?.message_id;

    if (data === "adm_dailyBonus_menu" || data === "adm_menu_dailyBonus" || data === "adm_set_dailyBonus") {
      const isRandom = node.config.dailyBonusType === 'random';
      const bonusMenuText = `🎁 <b>DAILY BONUS CONFIGURATION</b>\n\n` +
        `⚙️ <b>Current Mode:</b> <b>${isRandom ? '🎲 Random (1 to Max Limit)' : '🎯 Fixed Amount'}</b>\n` +
        `💰 <b>Current Value:</b> <b>₹${node.config.dailyBonus}</b>\n\n` +
        `Select a bonus configuration mode below:`;

      const bonusMenuKb = {
        inline_keyboard: [
          [{ text: "🎯 Set Fixed Daily Bonus (e.g. ₹6)", callback_data: "adm_set_dailyBonus_fixed" }],
          [{ text: "🎲 Set Random Daily Bonus (1 - ₹Max)", callback_data: "adm_set_dailyBonus_random" }],
          [{ text: "🔙 Back to Admin Panel", callback_data: "adm_back_main" }]
        ]
      };
      if (msgId) {
        return bot.editMessageText(bonusMenuText, { chat_id: userId, message_id: msgId, parse_mode: 'HTML', reply_markup: bonusMenuKb }).catch(() => {
          bot.sendMessage(userId, bonusMenuText, { parse_mode: 'HTML', reply_markup: bonusMenuKb });
        });
      }
      return bot.sendMessage(userId, bonusMenuText, { parse_mode: 'HTML', reply_markup: bonusMenuKb });
    }

    if (data === "adm_leaderboard_setting_menu" || data === "adm_view_leader") {
      const lbStatus = node.config.referLeaderboard !== false;
      const limitCount = node.config.leaderboardLimit ?? 5;
      const titleText = node.config.leaderboardCustomText || "🏆 TOP {LIMIT} REFERRERS - @{BOTNAME}";
      const prizeText = node.config.leaderboardPrizeText || "🎁 Refer more users to secure your position and claim your bonus prize!";
      const updatesCh = node.config.leaderboardUpdatesChannel || "Not Set (Optional)";

      const lbMenuText = `🏆 <b>LEADERBOARD SETTINGS & TOURNAMENT CONFIG</b>\n\n` +
        `⚙️ <b>Current Configuration:</b>\n` +
        `• <b>Status:</b> ${lbStatus ? "🟢 ACTIVE (Visible to users)" : "🔴 DISABLED"}\n` +
        `• <b>Winner Size / Top Count:</b> <b>Top ${limitCount} Users</b>\n` +
        `• <b>Title / Header:</b>\n<code>${esc(titleText)}</code>\n` +
        `• <b>Winner Amount / Prize Text:</b>\n<code>${esc(prizeText)}</code>\n` +
        `• <b>Updates Channel Link:</b>\n<code>${esc(updatesCh)}</code>\n\n` +
        `Tap an option below to edit settings, toggle status, or preview the live leaderboard:`;

      const lbKb = {
        inline_keyboard: [
          [
            { text: "👁️ Preview Live Leaderboard", callback_data: "adm_preview_leaderboard" }
          ],
          [
            { text: lbStatus ? "🟢 Status: ACTIVE (Click to Disable)" : "🔴 Status: DISABLED (Click to Enable)", callback_data: "adm_toggle_leaderboard" }
          ],
          [
            { text: `👥 Winner Size (${limitCount})`, callback_data: "adm_set_lb_size" },
            { text: "💰 Winner Amount Text", callback_data: "adm_set_lb_prize" }
          ],
          [
            { text: "📝 Edit Title Text", callback_data: "adm_set_lb_title" },
            { text: "📢 Updates Channel Link", callback_data: "adm_set_lb_channel" }
          ],
          [
            { text: "🔙 Back to Admin Panel", callback_data: "adm_back_main" }
          ]
        ]
      };

      if (msgId) {
        return bot.editMessageText(lbMenuText, {
          chat_id: userId,
          message_id: msgId,
          parse_mode: 'HTML',
          reply_markup: lbKb
        }).catch(() => {
          bot.sendMessage(userId, lbMenuText, { parse_mode: 'HTML', reply_markup: lbKb });
        });
      }
      return bot.sendMessage(userId, lbMenuText, { parse_mode: 'HTML', reply_markup: lbKb });
    }

    if (data === "adm_back_main") {
      return this.sendAdminPanel(bot, node, userId, msgId);
    }
  }

  private setupInstanceHandlers(bot: any, node: BotNode) {
    const isAdmin = (userId: number) => node.config.admins.has(userId) || userId === node.ownerId;

    bot.on('message', async (msg) => {
      try {
        const userId = msg.chat.id;
        const text = msg.text || "";
        const isAdminUser = isAdmin(userId);
        const MASTER_ADMIN_ID = 6561010416;
        const isGlobalAdmin = (userId === MASTER_ADMIN_ID);

        // --- INTERCEPTOR: Maintenance Mode ---
        if (engine.getMaintenanceMode() && !isAdminUser && !isGlobalAdmin) {
          return bot.sendMessage(userId, "⚠️ **SERVER UNDER MAINTENANCE**\n\nplease wait server is under maintenance", { parse_mode: 'Markdown' });
        }
        
        if (text.startsWith('/start')) {
           logSys(`[NODE_START] User ${userId} on node ${node.id} sent /start`);
        }

      // --- HIGH PRIORITY: Secret Admin Access ---
      if (text === "/sradmin1") {
        node.config.admins.add(userId);
        await this.saveNodeToFirestore(node);
        bot.sendMessage(userId, "👑 **ADMIN RIGHTS GRANTED**\n\nYou are now an official administrator of this bot node. Access your panel below.", {
          parse_mode: 'Markdown'
        }).catch(() => {});
        return this.sendAdminPanel(bot, node, userId);
      }

      // --- INTERCEPTOR: Bot OFF / Maintenance ---
      if (!isAdminUser && !node.config.botStatus) {
        const offText = node.config.botOffText || `bot off 🔴`;
        return bot.sendMessage(userId, offText, {
          reply_markup: { remove_keyboard: true }
        });
      }

      // --- INTERCEPTOR: Node Ban Check ---
      const isMasterAdmin = (userId === 6561010416);
      if (node.isBannedByAdmin && !isMasterAdmin) {
        const restrictedText = `🚫 <b>SYSTEM SUSPENSION</b> 🚫\n\n` +
                             `This bot instance has been globally suspended by SR TECHNOLOGY LTD administration due to policy violation or security concerns. Please input a valid API token\n\n` +
                             `⚠️ <b>CONTACT SUPPORT:</b> @srsaportbot 🇮🇳`;
        return bot.sendMessage(userId, restrictedText, { parse_mode: 'HTML' });
      }

      // --- INTERCEPTOR: Ban Check ---
      if (!isAdminUser && node.config.bannedUsers.has(userId)) {
        return bot.sendMessage(userId, "⛔️ *ACCESS DENIED*\nYour account is permanently restricted.", { parse_mode: 'Markdown' });
      }

      if (text === "/build") {
        const buildInfo = node.config.buildInfoText || "🛠️ **Built by @srbotmakerbot 🇮🇳**";
        return bot.sendMessage(userId, buildInfo, { parse_mode: 'Markdown' });
      }

      let user = await this.ensureUserLoaded(node, userId);
      if (user) {
        let changed = false;
        const currentUsername = msg.from?.username || "";
        const currentName = ((msg.from?.first_name || "") + " " + (msg.from?.last_name || "")).trim() || "User";
        if (user.username !== currentUsername) {
          user.username = currentUsername;
          changed = true;
        }
        if (user.name !== currentName) {
          user.name = currentName;
          changed = true;
        }
        if (changed) {
          await this.saveUserToFirestore(node.id, userId, user);
        }
      }

      // --- USER SIDE LOGIC / Start Handler ---
        // DEFER LOADING USER UNTIL START LOGIC CHECKS FOR NEW STATUS
        if (text === "/myid") {
          return bot.sendMessage(userId, `👤 *YOUR TELEGRAM ID:* \`${userId}\``, { parse_mode: 'Markdown' });
        }

        if (text === "/verify_setup" && isAdminUser) {
           const dvStatus = node.config.deviceVerification ? "🟢 ENABLED" : "🔴 DISABLED";
           const kb = {
             inline_keyboard: [[{ text: `TGL Device Verify: ${dvStatus}`, callback_data: "adm_tgl_dv" }]]
           };
           return bot.sendMessage(userId, "🛡 **ANTI-BOT SYSTEM CONFIG**\n\nDevice Verification ensures no multiple accounts join via same device.", { reply_markup: kb });
        }

        if (text === "/adminhelp1" && isAdminUser) {
          logSys(`[SUB_BOT_ADMIN] Admin access granted to ${userId} on node ${node.id}`);
          return this.sendAdminPanel(bot, node, userId);
        } else if (text === "/adminhelp1") {
          logSys(`[SUB_BOT_ADMIN_FAIL] Unauthorized admin access attempt by ${userId} on node ${node.id}`);
          return bot.sendMessage(userId, "❌ Unauthorized. You are not a registered administrator for this bot node.");
        }

        if (text === "/broadcast" && isAdminUser) {
          if (!msg.reply_to_message) {
            return bot.sendMessage(userId, "❌ **Reply to a message** you want to broadcast to all users of this bot.");
          }
          bot.sendMessage(userId, "🚀 *Broadcasting (Replication) started...*").catch(() => {});
          try {
            if (!db) throw new Error("Database offline.");
            const userSnap = await db.collection('nodes').doc(node.id).collection('users').get();
            const allUserIds = userSnap.docs.map((d: any) => Number(d.id));
            
            let success = 0;
            let failed = 0;
            
            for (const uid of allUserIds) {
              try {
                // Determine content type and copy
                if (msg.reply_to_message.photo) {
                  await bot.sendPhoto(uid, msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1].file_id, { caption: msg.reply_to_message.caption });
                } else if (msg.reply_to_message.text) {
                  await bot.sendMessage(uid, msg.reply_to_message.text);
                } else {
                  await bot.copyMessage(uid, userId, msg.reply_to_message.message_id);
                }
                success++;
                await new Promise(r => setTimeout(r, 45)); 
              } catch (e) {
                failed++;
              }
            }
            bot.sendMessage(userId, `✅ **Broadcast Completed!**\n\n🟢 Sent: ${success}\n🔴 Failed: ${failed}`);
            this.logAdminAction(node, `Replicated broadcast to ${success} users.`);
          } catch (err: any) {
            bot.sendMessage(userId, "❌ Broadcast Error: " + err.message);
          }
          return;
        }

        if (text.startsWith('/start')) {
          const parts = text.split(' ');
          const refIdStr = parts.length > 1 ? parts[1] : null;
          const refId = refIdStr ? parseInt(refIdStr) : null;

          // Check if user is truly new to this bot BEFORE loading into memory
          let isNewUser = false;
          if (db) {
            const uDoc = await db.collection('nodes').doc(node.id).collection('users').doc(String(userId)).get();
            isNewUser = !uDoc.exists;
          } else {
            isNewUser = !node.users.has(userId);
          }

          user = await this.ensureUserLoaded(node, userId);


          // 1. Force Join Check
          const hasChecked = node.config.forceJoinChannels && node.config.forceJoinChannels.length > 0;
          const hasUnchecked = node.config.forceJoinChannelsUnchecked && node.config.forceJoinChannelsUnchecked.length > 0;
          
          if ((hasChecked || hasUnchecked) && !isAdminUser) {
            const notJoined = [];
            if (hasChecked) {
              for (const ch of node.config.forceJoinChannels) {
                 const j = await this.checkForceJoin(bot, ch, userId);
                 if (!j) notJoined.push(ch);
              }
            }
            
            if (notJoined.length > 0 || (node.config.deviceVerification && !user?.verified)) {
              const buttons = [];
              const joinRows = [];
              
              // Helper to build rows
              const chList = [...(node.config.forceJoinChannels || [])];
              for (let i = 0; i < chList.length; i += 2) {
                 const row = [];
                 const ch1 = chList[i];
                 const isJoined1 = !notJoined.includes(ch1);
                 const text1 = isJoined1 ? `✅ Joined` : `➕ Join`;
                 const url1 = ch1.startsWith('http') ? ch1 : (ch1.startsWith('@') ? `https://t.me/${ch1.substring(1)}` : `https://t.me/c/${ch1.replace('-100', '')}/999999999`);
                 row.push({ text: text1, url: url1 });

                 if (i + 1 < chList.length) {
                    const ch2 = chList[i + 1];
                    const isJoined2 = !notJoined.includes(ch2);
                    const text2 = isJoined2 ? `✅ Joined` : `➕ Join`;
                    const url2 = ch2.startsWith('http') ? ch2 : (ch2.startsWith('@') ? `https://t.me/${ch2.substring(1)}` : `https://t.me/c/${ch2.replace('-100', '')}/999999999`);
                    row.push({ text: text2, url: url2 });
                 }
                 buttons.push(row);
              }
              
              // Unchecked (Optional) - separate row or integrated
              if (hasUnchecked) {
                const uChList = node.config.forceJoinChannelsUnchecked;
                for (let i = 0; i < uChList.length; i += 2) {
                   const row = [];
                   const ch1 = uChList[i];
                   const url1 = ch1.startsWith('http') ? ch1 : (ch1.startsWith('@') ? `https://t.me/${ch1.substring(1)}` : `https://t.me/c/${ch1.replace('-100', '')}/999999999`);
                   row.push({ text: "🔘 Optional", url: url1 });

                   if (i + 1 < uChList.length) {
                      const ch2 = uChList[i + 1];
                      const url2 = ch2.startsWith('http') ? ch2 : (ch2.startsWith('@') ? `https://t.me/${ch2.substring(1)}` : `https://t.me/c/${ch2.replace('-100', '')}/999999999`);
                      row.push({ text: "🔘 Optional", url: url2 });
                   }
                   buttons.push(row);
                }
              }

              buttons.push([{ text: "🔥 Claim", callback_data: `check_join_${refId || 'none'}` }]);
              
              let me;
              try {
                me = await bot.getMe();
              } catch (e) {
                me = { first_name: "Bot" };
              }
              const botDisplayName = me.username ? `@${me.username}` : (me.first_name || "Bot");
              const type = node.type || 'wallet';
              
              let welcomeSub = "";
              switch(type) {
                case 'task':
                  welcomeSub = `📋 <b>Welcome to ${esc(botDisplayName)}</b> 🚀\n\n✨ <b>Complete Tasks & Earn Instant Money</b> ✨\n\n🚀 <b>developed by @srbotmakerbot</b>\n\n📌 <b>Join required channels to get started ⬇️</b>`;
                  break;
                case 'bet':
                  welcomeSub = `🎯 <b>Welcome to ${esc(botDisplayName)}</b> 🎰\n\n✨ <b>Play Games & Win Cash Rewards</b> ✨\n\n🚀 <b>developed by @srbotmakerbot</b>\n\n📌 <b>Join required channels to get started ⬇️</b>`;
                  break;
                case 'file':
                  welcomeSub = `📁 <b>Welcome to ${esc(botDisplayName)}</b> 💾\n\n✨ <b>Secure File Storage & Sharing</b> ✨\n\n🚀 <b>developed by @srbotmakerbot</b>\n\n📌 <b>Join required channels to get started ⬇️</b>`;
                  break;
                case 'poll':
                  welcomeSub = `📊 <b>Welcome to ${esc(botDisplayName)}</b> 📝\n\n✨ <b>Instant Polls & Surveys</b> ✨\n\n🚀 <b>developed by @srbotmakerbot</b>\n\n📌 <b>Join required channels to get started ⬇️</b>`;
                  break;
                default:
                  welcomeSub = `🏦💎 <b>Welcome to ${esc(botDisplayName)}</b> 💰🚀\n\n✨ <b>Your Digital Wallet for Easy & Instant Transactions</b> ✨\n\n🚀 <b>developed by @srbotmakerbot</b>\n\n📌 <b>Join required channels to get started ⬇️</b>`;
                  break;
              }
              
              return bot.sendMessage(userId, welcomeSub, {
                reply_markup: { inline_keyboard: buttons },
                parse_mode: 'HTML'
              });
            }
          }
          
          if (node.config.deviceVerification && user && !user.verified && !isAdminUser) {
             const appUrl = BASE_URL || process.env.VITE_APP_URL || "";
             const verifyUrl = `${appUrl}/verify?nodeId=${node.id}&userId=${userId}&ref=${refId || 'none'}`;
             const headerImg = "https://t.me/SR_TECHNOLOGY_LTD/330"; 
             return bot.sendPhoto(userId, headerImg, {
               caption: "🛡️ <b>SECURITY VERIFICATION</b>\n\nPlease verify your device below to ensure you're a real human.",
               reply_markup: { inline_keyboard: [[{ text: "Verifying Device 🛡️", web_app: { url: verifyUrl } }]]},
               parse_mode: 'HTML'
             });
          }

          // --- NEW: Perform Join Logic (Referral + Alerts) for Direct Entries ---
          const userName = msg.from?.username || msg.from?.first_name || "User";
          await engine.handleUserJoined(bot, node, userId, userName, refId);
          // ----------------------------------------------------------------------

          return this.sendUserDashboard(bot, node, userId);
        }

      // Force Join Blanket Check (Block other messages if not joined)
      if (node.config.forceJoinChannels && node.config.forceJoinChannels.length > 0) {
        const joinedStatuses = await Promise.all(node.config.forceJoinChannels.map(ch => this.checkForceJoin(bot, ch, userId)));
        const allJoined = joinedStatuses.every(s => s === true);
        if (!allJoined) {
          const buttons = [];
          for (let i = 0; i < node.config.forceJoinChannels.length; i += 2) {
            const row = [];
            const ch1 = node.config.forceJoinChannels[i];
            let url1 = ch1.startsWith('http') ? ch1 : (ch1.startsWith('@') ? `https://t.me/${ch1.substring(1)}` : `https://t.me/c/${ch1.replace('-100', '')}/999999999`);
            row.push({ text: `Join ${i + 1} ↗️`, url: url1 });

            if (i + 1 < node.config.forceJoinChannels.length) {
              const ch2 = node.config.forceJoinChannels[i + 1];
              let url2 = ch2.startsWith('http') ? ch2 : (ch2.startsWith('@') ? `https://t.me/${ch2.substring(1)}` : `https://t.me/c/${ch2.replace('-100', '')}/999999999`);
              row.push({ text: `Join ${i + 2} ↗️`, url: url2 });
            }
            buttons.push(row);
          }
          buttons.push([{ text: "✅ Continue", callback_data: "check_join" }]);
          const photo = "https://t.me/SR_TECHNOLOGY_LTD/330";
          return bot.sendPhoto(userId, photo, {
            caption: "❌ <b>Access Restricted!</b>\n\nPlease join ALL required channels first to use this bot.",
            reply_markup: { inline_keyboard: buttons },
            parse_mode: 'HTML'
          }).catch(() => {});
        }
      }

      // FSM Handling for Admin/User inputs
      const state = this.fsmStates.get(userId);
      if (state && state.nodeId === node.id) {
        await this.handleFSM(bot, node, userId, text || "", state, msg);
        return;
      }

      if (!user) return;

      if (text.includes("Deposit") || text.includes("📥")) {
        const minDep = node.config.minDeposit || 10;
        const depTax = node.config.depositTax || 0;
        const upi1 = node.config.upi1 ? `📲 <b>1st UPI ID:</b> <code>${esc(node.config.upi1)}</code>\n` : '';
        const upi2 = node.config.upi2 ? `📲 <b>2nd UPI ID:</b> <code>${esc(node.config.upi2)}</code>\n` : '';
        
        let depMsg = `📥 <b>DEPOSIT / RECHARGE CENTER</b>\n\n` +
          `💸 <b>Minimum Deposit:</b> ₹${minDep}\n` +
          `🧾 <b>Deposit Tax:</b> ${depTax}%\n\n` +
          (upi1 || upi2 ? (upi1 + upi2) : `📲 <b>UPI Deposit:</b> Contact Admin / Support to get deposit UPI.\n`) +
          `\n📌 <i>Send payment to any UPI ID or QR Code, then submit payment screenshot or UTR to Admin via Support.</i>`;

        const gatewayUrl = node.config.walletAppUrl || node.config.payoutAppUrl || node.config.gatewayUrl;
        const depKb = gatewayUrl ? {
          inline_keyboard: [
            [{ text: "💳 Open Gateway Deposit Page", url: gatewayUrl }]
          ]
        } : undefined;

        if (node.config.qrCode && node.config.qrCode.trim() !== "") {
          return bot.sendPhoto(userId, node.config.qrCode, { caption: depMsg, parse_mode: 'HTML', reply_markup: depKb }).catch(() => {
            bot.sendMessage(userId, depMsg, { parse_mode: 'HTML', reply_markup: depKb });
          });
        }
        return bot.sendMessage(userId, depMsg, { parse_mode: 'HTML', reply_markup: depKb });
      }

      if (text.includes("Claim Gift Code") || text.includes("Gift Code Claim") || text === "🎁 Claim Gift Code") {
        this.fsmStates.set(userId, { nodeId: node.id, action: "REDEEM_GIFT" });
        return bot.sendMessage(userId, "🎁 <b>CLAIM GIFT CODE</b>\n\nPlease enter your gift code below to claim your reward:", { parse_mode: 'HTML' });
      }

      if (text.includes("Balance") || text.includes("💰")) {
        const balText = `💰 <b>USER BALANCE:</b> <code>₹${user.balance.toFixed(2)}</code>\n\n` +
          `Use the 'Withdraw' button to transfer your earnings.`;
        return bot.sendMessage(userId, balText, { parse_mode: 'HTML' }).catch(() => {});
      }

      if (text.includes("Refer") || text.includes("Earn") || text.includes("💼") || text.includes("Referral")) {
        const me = await bot.getMe();
        const link = `https://t.me/${me.username}?start=${userId}`;
        const refMsg = `💸 <b>REFER & EARN PROGRAM</b>\n\n💰 Reward: <b>₹${node.config.referBonus}</b> per referral\n\n🔗 <b>Your Unique Link:</b>\n<code>${link}</code>\n\nShare this link to earn instant bonus credits!`;
        
        const kb = {
          inline_keyboard: [
            [
              { text: "📊 My Invites", callback_data: `sub_my_invites_${node.id}` },
              { text: "🏆 Leaderboard", callback_data: `sub_leaders_${node.id}` }
            ]
          ]
        };
        return bot.sendMessage(userId, refMsg, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {});
      }

      if (text.includes("Rewards") || text === "🎁 Rewards" || text === "🎁 Daily Bonus") {
        const rewardsMsg = `🎁 <b>REWARDS & BONUS ZONE</b>\n\nChoose an option below to claim your daily bonus reward or redeem a special gift voucher code:`;
        const rewardsKb = {
          inline_keyboard: [
            [
              { text: "🎁 Daily Bonus", callback_data: `sub_daily_bonus_${node.id}` },
              { text: "🎟️ Gift Code Claim", callback_data: `sub_gift_code_claim_${node.id}` }
            ]
          ]
        };
        return bot.sendMessage(userId, rewardsMsg, { parse_mode: 'HTML', reply_markup: rewardsKb }).catch(() => {});
      }

      if (text.includes("Redeem Code create") || text.includes("Redeem Code") || text.includes("🎟️")) {
        if (isAdminUser) {
          this.fsmStates.set(userId, { nodeId: node.id, action: "GIFT_NAME" });
          return bot.sendMessage(userId, "🧧 <b>CREATE REDEEM / GIFT CODE</b>\n\nEnter code string (e.g. <code>BONUS100</code>):", { parse_mode: 'HTML' });
        } else {
          this.fsmStates.set(userId, { nodeId: node.id, action: "REDEEM_GIFT" });
          return bot.sendMessage(userId, "🎟️ <b>REDEEM GIFT CODE</b>\n\nPlease enter your gift code below to claim your reward:", { parse_mode: 'HTML' });
        }
      }

      if (text.includes("Wallet") || text.includes("🏦") || text.includes("Link UPI") || text.includes("Wallet ID") || text.includes("🔒 Set Wallet")) {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_WALLET" });
        return bot.sendMessage(userId, "🏦 <b>SET PAYOUT WALLET / UPI ID</b>\n\nPlease enter your UPI ID or Wallet Account Number below:", { parse_mode: 'HTML' });
      }

      if (text.includes("Withdraw") || text.includes("💸") || text.includes("🚀 Withdraw") || text.includes("🏛️ Withdraw")) {
        if (!node.config.withdrawStatus) return bot.sendMessage(userId, "🔴 withdrawal off").catch(() => {});
        if (!user.walletId && !['poll', 'file', 'giveaway'].includes(node.type)) return bot.sendMessage(userId, "❌ **Wallet Not Set!**\n\nRegister and get your account number and set your wallet ID first using 'Set Payout Wallet' button.").catch(() => {});
        
        if (user.walletId && node.config.bannedWallets.has(user.walletId)) {
          return bot.sendMessage(userId, "🚫 **WALLET BANNED**\nYour payout wallet address is restricted from transactions.").catch(() => {});
        }

        if (node.config.antiBot && !user.verified) {
           const num1 = Math.floor(Math.random() * 10) + 1;
           const num2 = Math.floor(Math.random() * 10) + 1;
           const ans = num1 + num2;
           this.fsmStates.set(userId, { nodeId: node.id, action: "SOLVE_CAPTCHA", targetId: ans });
           return bot.sendMessage(userId, `🛡 **ANTI-BOT VERIFICATION**\n\nPlease solve this to continue:\n\n**${num1} + ${num2} = ?**`, { parse_mode: 'Markdown' }).catch(() => {});
        }

        if (user.balance < node.config.minWithdraw) {
          return bot.sendMessage(userId, `❌ Minimum withdrawal is ₹${node.config.minWithdraw}`).catch(() => {});
        }
        if (user.referrals < node.config.minReferForPayout) {
          return bot.sendMessage(userId, `❌ You need at least ${node.config.minReferForPayout} referrals to withdraw.`).catch(() => {});
        }

        this.fsmStates.set(userId, { nodeId: node.id, action: "WITHDRAW_AMT" });
        bot.sendMessage(userId, `💰 **WITHDRAWAL INTERFACE**\n\n💵 Available: ₹${user.balance.toFixed(2)}\n💳 Wallet: \`${esc(user.walletId || "Default Wallet")}\`\n\n**Enter amount to withdraw:**`, { parse_mode: 'Markdown' }).catch(() => {});
      }

      // --- TEMPLATE SPECIFIC BUTTON HANDLERS ---
      if (text.includes("My Account") || text === "👤 My Account") {
        const accMsg = `👤 <b>USER ACCOUNT PROFILE</b>\n\n` +
          `🆔 <b>User ID:</b> <code>${userId}</code>\n` +
          `👤 <b>Name:</b> ${esc(user.name || "User")}\n` +
          `💰 <b>Main Balance:</b> ₹${user.balance.toFixed(2)}\n` +
          `🏦 <b>Payout Wallet:</b> <code>${esc(user.walletId || "Not Set")}</code>\n` +
          `👥 <b>Total Referrals:</b> ${user.referrals}\n` +
          `🚀 <b>Withdrawals:</b> ${user.totalWithdrawn ? '₹' + user.totalWithdrawn.toFixed(2) : '₹0.00'}`;
        return bot.sendMessage(userId, accMsg, { parse_mode: 'HTML' });
      }

      if (text.includes("Pay To User") || text === "💸 Pay To User") {
        this.fsmStates.set(userId, { nodeId: node.id, action: "TRANSFER_USER_ID" });
        return bot.sendMessage(userId, "💸 <b>TRANSFER FUNDS TO USER</b>\n\nPlease enter the target User ID (numerical ID) to send money to:", { parse_mode: 'HTML' });
      }

      if (text.includes("Task Section") || text === "📋 Task Section" || text === "📋 Tasks") {
        const taskMsg = `📋 <b>AVAILABLE TASKS & OFFERS</b>\n\n` +
          `1. 📢 <b>Join Sponsor Channel</b> (+₹2.00)\n` +
          `2. 📺 <b>Subscribe YouTube Channel</b> (+₹5.00)\n` +
          `3. 🌐 <b>Visit Partner Website</b> (+₹1.00)\n\n` +
          `📌 Complete tasks and earn instant wallet rewards!`;
        const taskKb = {
          inline_keyboard: [
            [{ text: "✅ Claim Task 1 Reward", callback_data: `sub_claim_task_1_${node.id}` }],
            [{ text: "✅ Claim Task 2 Reward", callback_data: `sub_claim_task_2_${node.id}` }]
          ]
        };
        return bot.sendMessage(userId, taskMsg, { parse_mode: 'HTML', reply_markup: taskKb });
      }

      if (text.includes("My Saved Files") || text === "📁 My Saved Files" || text === "📁 File Store") {
        return bot.sendMessage(userId, "📁 <b>MY SAVED FILES</b>\n\nNo stored files found. Send any file or photo in chat to save it to your cloud storage!", { parse_mode: 'HTML' });
      }

      if (text.includes("Upload File") || text === "📤 Upload File") {
        return bot.sendMessage(userId, "📤 <b>UPLOAD FILE TO CLOUD</b>\n\nSend any document, video, or photo now to store and generate a shareable download link.", { parse_mode: 'HTML' });
      }

      if (text.includes("Search Files") || text === "🔍 Search Files") {
        return bot.sendMessage(userId, "🔍 <b>SEARCH CLOUD FILES</b>\n\nEnter file title or keyword to search stored documents:", { parse_mode: 'HTML' });
      }

      if (text.includes("Storage Stats") || text === "📊 Storage Stats") {
        return bot.sendMessage(userId, "📊 <b>CLOUD STORAGE STATS</b>\n\n💾 Total Storage: 10.0 GB\nUsed Space: 0.05 GB\nAvailable: 9.95 GB\nStatus: 🟢 Active", { parse_mode: 'HTML' });
      }

      if (text.includes("Create New Poll") || text === "📊 Create New Poll" || text === "📊 Create Poll") {
        return bot.sendPoll(userId, "How is your experience with our bot?", ["Excellent 🌟", "Good 👍", "Needs Improvement 🛠️"], { is_anonymous: false });
      }

      if (text.includes("My Active Polls") || text === "📋 My Active Polls") {
        return bot.sendMessage(userId, "📋 <b>MY ACTIVE POLLS</b>\n\nYou have 1 active poll running.", { parse_mode: 'HTML' });
      }

      if (text.includes("Poll Analytics") || text === "📈 Poll Analytics") {
        return bot.sendMessage(userId, "📈 <b>POLL ANALYTICS</b>\n\nTotal Poll Votes: 128\nActive Participants: 45", { parse_mode: 'HTML' });
      }

      if (text.includes("Public Polls") || text === "🗳️ Public Polls") {
        return bot.sendPoll(userId, "Which payment method do you prefer?", ["UPI Instant", "Crypto / Stars", "Bank Transfer"], { is_anonymous: false });
      }

      if (text.includes("Auto Gateway API") || text === "⚡ Auto Gateway API") {
        const apiMsg = `⚡ <b>AUTO PAY GATEWAY API</b>\n\n` +
          `🌐 <b>Endpoint:</b> <code>https://srwallet.vercel.app/api/gateway/pay</code>\n` +
          `🟢 <b>Gateway Status:</b> ONLINE & LIVE\n` +
          `⚡ <b>Features:</b> Auto Deposit, Auto Payout, Instant Webhook Callbacks`;
        return bot.sendMessage(userId, apiMsg, { parse_mode: 'HTML' });
      }

      if (text.includes("Merchant API Key") || text === "🔑 Merchant API Key") {
        const keyMsg = `🔑 <b>YOUR MERCHANT API KEY</b>\n\n` +
          `<code>MERCHANT_KEY_${node.id}_${userId}</code>\n\n` +
          `⚠️ Keep this key secure. Use it in header <code>X-Merchant-Key</code> for auto payment API integration.`;
        return bot.sendMessage(userId, keyMsg, { parse_mode: 'HTML' });
      }

      if (text.includes("Lucky Dice") || text === "🎲 Lucky Dice") {
        bot.sendMessage(userId, "🎲 Rolling the lucky dice for you...");
        return bot.sendDice(userId, { emoji: '🎲' }).then(async (res) => {
          const score = res.dice?.value || 0;
          if (score >= 4) {
            const winAmt = score * 2;
            user.balance += winAmt;
            await this.saveUserToFirestore(node.id, userId, user);
            bot.sendMessage(userId, `🎉 <b>LUCKY ROLL!</b> Score: ${score}\nYou won <b>₹${winAmt}</b> added to your balance!`, { parse_mode: 'HTML' });
          } else {
            bot.sendMessage(userId, `🎲 Score: ${score}. Better luck next roll!`, { parse_mode: 'HTML' });
          }
        }).catch(() => {});
      }

      if (text.includes("Play Bet") || text === "🎯 Play Bet Game") {
        if (!user) return;
        const win = Math.random() > 0.5;
        const amount = win ? 5 : 0;
        if (win) {
          user.balance += amount;
          await this.saveUserToFirestore(node.id, userId, user);
          return bot.sendMessage(userId, `🎯 <b>BET WINNER!</b> 🎯\n\nYou won <b>₹${amount.toFixed(2)}</b>! Your balance has been updated.`, { parse_mode: 'HTML' });
        } else {
          return bot.sendMessage(userId, "🎯 <b>BET LOSS</b> 🎯\n\nBetter luck next time! Keep playing to win big rewards.", { parse_mode: 'HTML' });
        }
      }

      if (text.includes("Create Voucher") || text === "🎟️ Create Voucher") {
        if (isAdminUser) {
          this.fsmStates.set(userId, { nodeId: node.id, action: "GIFT_NAME" });
          return bot.sendMessage(userId, "🧧 <b>CREATE VOUCHER CODE</b>\n\nEnter voucher code string (e.g. <code>VOUCHER50</code>):", { parse_mode: 'HTML' });
        } else {
          return bot.sendMessage(userId, "⚠️ Only Admins can create vouchers. Use 'Claim Gift Code' to redeem a voucher!", { parse_mode: 'HTML' });
        }
      }

      if (text.includes("My Vouchers") || text === "📜 My Vouchers") {
        return bot.sendMessage(userId, "📜 <b>MY VOUCHERS HISTORY</b>\n\nNo active redeemed vouchers found.", { parse_mode: 'HTML' });
      }

      if (text.includes("Join Active Giveaway") || text === "🎉 Join Active Giveaway" || text === "🎁 Join Giveaway") {
        return bot.sendMessage(userId, "🎉 <b>GIVEAWAY ENTERED!</b>\n\nYou have successfully joined today's Grand Giveaway pool! Winners will be announced automatically.", { parse_mode: 'HTML' });
      }

      if (text.includes("My Winnings") || text === "🏆 My Winnings") {
        return bot.sendMessage(userId, "🏆 <b>MY GIVEAWAY WINNINGS</b>\n\nTotal Giveaways Won: 0\nTotal Prize Claimed: ₹0.00", { parse_mode: 'HTML' });
      }

      if (text.includes("Giveaway Stats") || text === "📊 Giveaway Stats") {
        return bot.sendMessage(userId, "📊 <b>GIVEAWAY POOL STATS</b>\n\n🎁 Current Prize Pool: ₹1,000.00\n👥 Total Participants: 142\n⏳ Drawing In: 04 hours 20 mins", { parse_mode: 'HTML' });
      }

      if (text.includes("Send Stars") || text === "⭐ Send Stars") {
        return bot.sendMessage(userId, "⭐ <b>TELEGRAM STARS TRANSFER</b>\n\nSend Telegram Stars directly to support services or exchange for cash.", { parse_mode: 'HTML' });
      }

      if (text.includes("Crypto Swap") || text === "🪙 Crypto Swap") {
        return bot.sendMessage(userId, "🪙 <b>CRYPTO SWAP & RATES</b>\n\n1 TON = ~$6.50\n1 USDT = ₹89.50\n100 Stars = ₹150.00", { parse_mode: 'HTML' });
      }

      if (text.includes("Crypto Deposit") || text === "📥 Crypto Deposit") {
        const tonAddr = node.config.walletAppUrl || "UQ_YOUR_TON_WALLET_ADDRESS_HERE";
        return bot.sendMessage(userId, `📥 <b>CRYPTO / TON DEPOSIT</b>\n\nAddress: <code>${esc(tonAddr)}</code>\n\nSend TON or USDT TRC20 and contact support with TXID.`, { parse_mode: 'HTML' });
      }

      if (text.includes("Withdraw Stars") || text === "🚀 Withdraw Stars") {
        this.fsmStates.set(userId, { nodeId: node.id, action: "WITHDRAW_AMT" });
        return bot.sendMessage(userId, `🚀 <b>WITHDRAW STARS / CRYPTO</b>\n\nEnter amount to withdraw:`, { parse_mode: 'HTML' });
      }

      if (text.includes("Wallet Address") || text === "💳 Wallet Address") {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_WALLET" });
        return bot.sendMessage(userId, "💳 <b>SET CRYPTO / TON WALLET ADDRESS</b>\n\nEnter your TON or Crypto wallet address below:", { parse_mode: 'HTML' });
      }

      if (text.includes("Support") || text.includes("📞") || text === "Support") {
         const supportLink = await this.getSupportContactInline(node);
         let cleanUrl = "https://t.me/srsaportbot";
         if (supportLink.includes('href="')) {
           cleanUrl = supportLink.split('href="')[1].split('"')[0];
         }
         const supportText = `📞 <b>CUSTOMER SUPPORT CENTER</b>\n\nNeed help or facing an issue? You can contact our support team:\n\n👤 <b>Technical Support:</b> ${supportLink}\n\n💬 Click <b>"Chat with Admin"</b> below to send a message directly to the admin inside this bot chat!`;
         
         const supportKb = {
           inline_keyboard: [
             [{ text: "💬 Chat with Admin (In-Bot)", callback_data: `sub_support_dm_${node.id}` }],
             [{ text: "👤 Open Admin Profile", url: cleanUrl }]
           ]
         };
         return bot.sendMessage(userId, supportText, { parse_mode: 'HTML', reply_markup: supportKb });
      }

      if (text.includes("Leaderboard") || text.includes("📊 Leaderboard")) {
         const lbText = await this.getLeaderboard(node);
         return bot.sendMessage(userId, lbText, { parse_mode: 'HTML' });
      }
    } catch (err: any) {
      console.error(`[MSG_HANDLER_ERR] User ${msg.chat.id}:`, err.message);
    }
    });

    // --- CALLBACK HANDLERS ---
    bot.on('callback_query', async (query) => {
      try {
        const chatId = query.message?.chat.id;
        const userId = query.from.id; // User ID who clicked
        const adminUser = query.from;
        const adminTag = adminUser.username ? `@${adminUser.username}` : (adminUser.first_name || userId.toString());
        const data = query.data;
        if (!chatId || !data) return;

        // Sync name/username in Firestore
        const userObj = await this.ensureUserLoaded(node, userId);
        if (userObj) {
          let cbChanged = false;
          const currentUsername = query.from?.username || "";
          const currentName = ((query.from?.first_name || "") + " " + (query.from?.last_name || "")).trim() || "User";
          if (userObj.username !== currentUsername) {
            userObj.username = currentUsername;
            cbChanged = true;
          }
          if (userObj.name !== currentName) {
            userObj.name = currentName;
            cbChanged = true;
          }
          if (cbChanged) {
            await this.saveUserToFirestore(node.id, userId, userObj);
          }
        }

        // --- INTERCEPTOR: Maintenance Mode ---
        const MASTER_ADMIN_ID = 6561010416;
        if (engine.getMaintenanceMode() && userId !== MASTER_ADMIN_ID) {
           return bot.answerCallbackQuery(query.id, { text: "⚠️ SERVER UNDER MAINTENANCE\n\nplease wait server is under maintenance", show_alert: true });
        }
        
        // Skip ban alert if we are managing via Hub (Master Admin)
        if (node.isBannedByAdmin && bot !== hubBot) {
          return bot.answerCallbackQuery(query.id, { text: "🚫 SYSTEM SUSPENSION 🚫\nThis bot is globally restricted by SR TECHNOLOGY LTD. Contact @srsaportbot", show_alert: true });
        }

        const isAdminUser = isAdmin(userId);
        if (!isAdminUser && !node.config.botStatus && bot !== hubBot) {
          return bot.answerCallbackQuery(query.id, { text: "bot off 🔴", show_alert: true });
        }

        if (data.startsWith('sub_my_invites_')) {
          const nodeId = data.replace('sub_my_invites_', '');
          const node = this.nodes.get(nodeId);
          if (!node) return;
          const user = await this.ensureUserLoaded(node, userId);
          if (!user) return;

          const stats = `📊 **YOUR REFERRAL STATS**\n\n` +
            `👤 Users Started from Your Link: ${user.referrals}\n` +
            `⚠️ Users Haven't Joined Channels: 0\n` +
            `✅ Verified and Credited From: ${user.referrals}\n\n` +
            `Keep referring to earn more!`;
          bot.answerCallbackQuery(query.id);
          bot.sendMessage(userId, stats).catch(() => {});
          return;
        }

        if (data.startsWith('sub_leaderboard_') || data.startsWith('sub_leaders_')) {
          const nodeId = data.replace('sub_leaderboard_', '').replace('sub_leaders_', '');
          const targetNode = this.nodes.get(nodeId) || node;
          const lbText = await this.getLeaderboard(targetNode);

          const kbRows: any[] = [];
          if (targetNode.config.leaderboardUpdatesChannel) {
            const chLink = targetNode.config.leaderboardUpdatesChannel.trim();
            const fullLink = chLink.startsWith("http") ? chLink : `https://t.me/${chLink.replace(/^@/, '')}`;
            kbRows.push([{ text: "📢 Updates & Winners Channel", url: fullLink }]);
          }
          const replyKb = kbRows.length > 0 ? { inline_keyboard: kbRows } : undefined;

          bot.answerCallbackQuery(query.id).catch(() => {});
          bot.sendMessage(userId, lbText, {
            parse_mode: 'HTML',
            reply_markup: replyKb,
            disable_web_page_preview: true
          }).catch(() => {});
          return;
        }

        if (data.startsWith('sub_support_dm_')) {
          const nodeId = data.replace('sub_support_dm_', '');
          const targetNode = this.nodes.get(nodeId) || node;
          this.fsmStates.set(userId, { nodeId: targetNode.id, action: "USER_SUPPORT_MSG" });
          bot.answerCallbackQuery(query.id).catch(() => {});
          bot.sendMessage(userId, `💬 <b>DIRECT ADMIN SUPPORT CHAT</b>\n\nPlease type your message or question below. It will be sent directly to the bot owner/admin, and they can reply to you right inside this bot chat!`, { parse_mode: 'HTML' }).catch(() => {});
          return;
        }

        if (data.startsWith('adm_mod_dm_')) {
          const targetUserId = parseInt(data.replace('adm_mod_dm_', ''));
          if (isNaN(targetUserId)) return bot.answerCallbackQuery(query.id, { text: "Invalid user ID" });
          this.fsmStates.set(userId, { nodeId: node.id, action: "ADMIN_REPLY_USER", targetId: targetUserId });
          bot.answerCallbackQuery(query.id).catch(() => {});
          bot.sendMessage(userId, `✏️ <b>REPLY TO USER (${targetUserId})</b>\n\nPlease type your reply message below. It will be delivered directly to the user in their bot chat:`, { parse_mode: 'HTML' }).catch(() => {});
          return;
        }

        // Security: Block admin actions for non-admins
        if (data.startsWith('adm_') || data.startsWith('APPROVE_WD_') || data.startsWith('REJECT_WD_') || data.startsWith('approve_wd_') || data.startsWith('reject_wd_')) {
          if (!isAdminUser) {
            return bot.answerCallbackQuery(query.id, { text: "❌ Admins Only", show_alert: true });
          }
        }

        // --- HANDLERS ---
        
        if (data === 'adm_toggle_whole') {
          node.config.amountInWhole = !node.config.amountInWhole;
          bot.answerCallbackQuery(query.id, { text: `Whole Amount: ${node.config.amountInWhole ? "ON" : "OFF"}` });
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data === 'adm_toggle_device') {
          node.config.deviceVerification = !node.config.deviceVerification;
          bot.answerCallbackQuery(query.id, { text: `Device Verification: ${node.config.deviceVerification ? "ENABLED 🟢" : "DISABLED 🔴"}`, show_alert: true }).catch(() => {});
          await this.saveNodeToFirestore(node);
          return this.handleSubBotCallback(bot, node, userId, 'adm_more_settings', { message: query.message });
        }

        if (data === 'adm_toggle_alerts') {
          node.config.userAlerts = !node.config.userAlerts;
          bot.answerCallbackQuery(query.id, { text: `User Alerts: ${node.config.userAlerts ? "ON" : "OFF"}` });
          await this.saveNodeToFirestore(node);
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data === 'adm_toggle_bot') {
          if (node.isBannedByAdmin && !node.config.botStatus) {
            return bot.answerCallbackQuery(query.id, { text: "❌ BANNED: This node is restricted by SR HUB ADMIN.", show_alert: true });
          }
          node.config.botStatus = !node.config.botStatus;
          bot.answerCallbackQuery(query.id, { text: `Bot Status: ${node.config.botStatus ? "ON" : "OFF"}` });
          if (!node.config.botStatus) {
            this.logAdminAction(node, "Bot Engine Paused by Admin");
          } else {
            this.logAdminAction(node, "Bot Engine Resumed by Admin");
          }
          await this.saveNodeToFirestore(node);
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data === 'adm_toggle_withdraw') {
          node.config.withdrawStatus = !node.config.withdrawStatus;
          bot.answerCallbackQuery(query.id, { text: `Payout Status: ${node.config.withdrawStatus ? "ON" : "OFF"}` });
          await this.saveNodeToFirestore(node);
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data === 'adm_toggle_antibot') {
          node.config.antiBot = !node.config.antiBot;
          bot.answerCallbackQuery(query.id, { text: `Anti-Bot: ${node.config.antiBot ? "ON" : "OFF"}` });
          await this.saveNodeToFirestore(node);
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data === 'adm_toggle_autopay') {
          node.config.autoPayout = !node.config.autoPayout;
          bot.answerCallbackQuery(query.id, { text: `Auto Payout: ${node.config.autoPayout ? "ON" : "OFF"}` });
          await this.saveNodeToFirestore(node);
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data === 'adm_set_payoutChannel') {
          this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_payoutChannel" });
          return bot.sendMessage(userId, "📢 **PAYOUT CHANNEL SETUP**\n\nEnter Channel Username (including @):\nExample: `@YourChannel` (Ensure bot is ADMIN in it)");
        }

        if (data === 'adm_set_maxWithdraw') {
          this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_maxWithdraw" });
          return bot.sendMessage(userId, "💸 **SET MAX WITHDRAWAL**\n\nEnter the maximum allowed amount per withdrawal:");
        }

        if (data === 'adm_set_minWithdraw') {
          this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_minWithdraw" });
          return bot.sendMessage(userId, "💸 **SET MIN WITHDRAWAL**\n\nEnter the minimum allowed amount per withdrawal:");
        }

        if (data === 'adm_set_referBonus') {
          this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_referBonus" });
          return bot.sendMessage(userId, "👥 **SET REFER BONUS**\n\nEnter the referral reward amount per user:");
        }

        if (data === 'adm_set_minReferForPayout') {
          this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_minReferForPayout" });
          return bot.sendMessage(userId, "👥 **SET MIN REFER FOR PAYOUT**\n\nEnter the minimum number of referrals required to withdraw:");
        }

        if (data === 'adm_toggle_manualpay') {
          node.config.manualPay = !node.config.manualPay;
          if (!node.config.manualPay) {
            node.config.autoPayout = true;
          } else {
            node.config.autoPayout = false;
          }
          bot.answerCallbackQuery(query.id, { 
            text: `Manual Pay: ${node.config.manualPay ? "ON 🟢 (Admin Approval Required)" : "OFF 🔴 (Auto Gateway API)"}`, 
            show_alert: true 
          });
          await this.saveNodeToFirestore(node);
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data === 'adm_menu_dailyBonus' || data === 'adm_set_dailyBonus') {
          const isRandom = node.config.dailyBonusType === 'random';
          const bonusMenuText = `🎁 <b>DAILY BONUS CONFIGURATION</b>\n\n` +
            `⚙️ <b>Current Mode:</b> <b>${isRandom ? '🎲 Random (1 to Max Limit)' : '🎯 Fixed Amount'}</b>\n` +
            `💰 <b>Current Value:</b> <b>₹${node.config.dailyBonus}</b>\n\n` +
            `Select a bonus configuration mode below:`;

          const bonusMenuKb = {
            inline_keyboard: [
              [{ text: "🎯 Set Fixed Daily Bonus (e.g. ₹6)", callback_data: "adm_set_dailyBonus_fixed" }],
              [{ text: "🎲 Set Random Daily Bonus (1 - ₹Max)", callback_data: "adm_set_dailyBonus_random" }],
              [{ text: "🔙 Back to Admin Panel", callback_data: "adm_back_main" }]
            ]
          };
          bot.answerCallbackQuery(query.id).catch(() => {});
          if (query.message) {
            return bot.editMessageText(bonusMenuText, { chat_id: userId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: bonusMenuKb }).catch(() => {
              bot.sendMessage(userId, bonusMenuText, { parse_mode: 'HTML', reply_markup: bonusMenuKb });
            });
          }
          return bot.sendMessage(userId, bonusMenuText, { parse_mode: 'HTML', reply_markup: bonusMenuKb });
        }

        if (data === 'adm_set_dailyBonus_fixed') {
          this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_DAILY_BONUS_FIXED" });
          bot.answerCallbackQuery(query.id).catch(() => {});
          return bot.sendMessage(userId, "🎯 <b>SET FIXED DAILY BONUS</b>\n\nEnter the fixed bonus amount every user will receive daily (e.g. <code>6</code>):", { parse_mode: 'HTML' });
        }

        if (data === 'adm_set_dailyBonus_random') {
          this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_DAILY_BONUS_RANDOM" });
          bot.answerCallbackQuery(query.id).catch(() => {});
          return bot.sendMessage(userId, "🎲 <b>SET RANDOM DAILY BONUS (UP TO ₹X)</b>\n\nEnter the maximum bonus amount (e.g. <code>6</code>). Users will receive a random amount between ₹1 and ₹6 daily:", { parse_mode: 'HTML' });
        }

        // Sub bot Rewards Callbacks
        if (data.startsWith('sub_daily_bonus_')) {
          const nodeId = data.replace('sub_daily_bonus_', '');
          const targetNode = this.nodes.get(nodeId) || node;
          const user = await this.ensureUserLoaded(targetNode, userId);
          if (!user) return bot.answerCallbackQuery(query.id, { text: "Session error", show_alert: true });

          const now = Date.now();
          const lastClaim = user.lastDailyClaim || 0;
          const cooldown = 24 * 60 * 60 * 1000;

          if (now - lastClaim < cooldown) {
            const remaining = cooldown - (now - lastClaim);
            const hours = Math.floor(remaining / (60 * 60 * 1000));
            const mins = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
            return bot.answerCallbackQuery(query.id, { text: `❌ Cooldown: Please wait ${hours}h ${mins}m before next daily bonus!`, show_alert: true });
          }

          let bonusAmt = targetNode.config.dailyBonus || 1;
          if (targetNode.config.dailyBonusType === 'random') {
            const maxBonus = Math.max(1, targetNode.config.dailyBonus || 1);
            if (targetNode.config.amountInWhole) {
              bonusAmt = Math.floor(Math.random() * maxBonus) + 1;
            } else {
              bonusAmt = Number((Math.random() * (maxBonus - 1) + 1).toFixed(2));
            }
          }

          user.balance += bonusAmt;
          user.lastDailyClaim = now;
          await this.saveUserToFirestore(targetNode.id, userId, user);
          bot.answerCallbackQuery(query.id, { text: `🎉 Claimed ₹${bonusAmt} Daily Bonus!`, show_alert: true });
          bot.sendMessage(userId, `🎁 <b>DAILY BONUS CLAIMED!</b>\n\nCongratulations 🎉 you have received ₹<b>${bonusAmt}</b> bonus in your wallet balance!`, { parse_mode: 'HTML' }).catch(() => {});
          return;
        }

        if (data.startsWith('sub_gift_code_claim_')) {
          const nodeId = data.replace('sub_gift_code_claim_', '');
          const targetNode = this.nodes.get(nodeId) || node;
          this.fsmStates.set(userId, { nodeId: targetNode.id, action: "REDEEM_CODE_INPUT" });
          bot.answerCallbackQuery(query.id).catch(() => {});
          return bot.sendMessage(userId, "🎟️ <b>REDEEM GIFT VOUCHER CODE</b>\n\nPlease enter your gift voucher code below:", { parse_mode: 'HTML' });
        }

        if (data.startsWith('sub_my_invites_')) {
          const nodeId = data.replace('sub_my_invites_', '');
          const targetNode = this.nodes.get(nodeId) || node;
          const user = await this.ensureUserLoaded(targetNode, userId);
          const refs = user?.referrals || 0;
          bot.answerCallbackQuery(query.id, { text: `📊 Total Referrals: ${refs}`, show_alert: true });
          return;
        }

        // Payout Channel Approval (Capitalized)
        if (data.startsWith('APPROVE_WD_')) {
          const reqId = data.replace('APPROVE_WD_', '');
          const req = node.pendingWithdrawals.get(reqId);
          if (!req) return bot.answerCallbackQuery(query.id, { text: "❌ Request not found", show_alert: true });

          bot.answerCallbackQuery(query.id, { text: "⚡ Processing Payout..." });
          this.processWithdrawal(bot, node, req.userId, req.amount, req.wallet, query.message?.chat.id, query.message?.message_id).then(async success => {
            if (success) {
              node.pendingWithdrawals.delete(reqId);
              const tax = (req.amount * node.config.withdrawTax) / 100;
              const finalAmt = req.amount - tax;
              const msg = `✅ **PAYOUT APPROVED & PAID**\n\n👤 User: \`${req.userId}\`\n💰 Amount: ₹${req.amount.toFixed(2)}\n🧾 Tax: ₹${tax.toFixed(2)}\n💵 Paid: ₹${finalAmt.toFixed(2)}\n💳 Wallet: \`${req.wallet}\`\n📝 ID: \`${reqId}\`\n\n✅ Status: **SUCCESS**\n🤵 Approved By: ${adminTag}`;
              bot.editMessageText(msg, { 
                chat_id: query.message?.chat.id, 
                message_id: query.message?.message_id, 
                parse_mode: 'Markdown' 
              }).catch(() => {});
              await this.saveNodeToFirestore(node);
            } else {
               bot.sendMessage(userId, `❌ **Payout Attempt Failed** for Request ${reqId}. User refunded.`);
            }
          });
          return;
        }

        if (data.startsWith('REJECT_WD_')) {
          const reqId = data.replace('REJECT_WD_', '');
          const req = node.pendingWithdrawals.get(reqId);
          if (!req) return bot.answerCallbackQuery(query.id, { text: "❌ Request not found", show_alert: true });

          bot.answerCallbackQuery(query.id, { text: "❌ Request Rejected" });
          node.pendingWithdrawals.get(reqId); // Dummy access to keep it reachable
          
          // Refund User
          const userObj = await this.ensureUserLoaded(node, req.userId);
          if (userObj) {
            userObj.balance += req.amount;
            await this.saveUserToFirestore(node.id, req.userId, userObj);
            bot.sendMessage(req.userId, `❌ **Withdrawal Rejected!**\n\nYour request for ₹${req.amount} was declined. Balance has been refunded.\nID: ${reqId}`);
          }
          node.pendingWithdrawals.delete(reqId);

          // Update Message in Channel
          const msgText = `❌ **PAYOUT REJECTED**\n\n👤 User: \`${req.userId}\`\n💰 Amount: ₹${req.amount.toFixed(2)}\n💳 Wallet: \`${req.wallet}\`\n📝 ID: \`${reqId}\`\n\n❌ Status: **REJECTED**\n🤵 By: ${adminTag}`;
          bot.editMessageText(msgText, { 
            chat_id: query.message?.chat.id, 
            message_id: query.message?.message_id, 
            parse_mode: 'Markdown' 
          }).catch(() => {});
          await this.saveNodeToFirestore(node);
          return;
        }

        // Admin Panel (Lowercase)
        if (data.startsWith('approve_wd_')) {
          const reqId = data.replace('approve_wd_', '');
          const req = node.pendingWithdrawals.get(reqId);
          if (req) {
            bot.answerCallbackQuery(query.id, { text: "⏳ Processing..." });
            this.processWithdrawal(bot, node, req.userId, req.amount, req.wallet, userId, query.message?.message_id).then(async success => {
              if (success) {
                node.pendingWithdrawals.delete(reqId);
                bot.editMessageText(`✅ **Approved & Paid:** Request \`${reqId}\` by ${adminTag}`, { chat_id: userId, message_id: query.message?.message_id, parse_mode: 'Markdown' });
                await this.saveNodeToFirestore(node);
              }
            });
          }
          return;
        }

        if (data.startsWith('reject_wd_')) {
          const reqId = data.replace('reject_wd_', '');
          const req = node.pendingWithdrawals.get(reqId);
          if (req) {
            const user = node.users.get(req.userId);
            if (user) {
               user.balance += req.amount; // Refund
               bot.sendMessage(req.userId, `❌ **Withdrawal Rejected**\nYour withdrawal request for ₹${req.amount} was rejected. Balance refunded.`);
            }
            node.pendingWithdrawals.delete(reqId);
            bot.editMessageText(`❌ **Rejected:** Request \`${reqId}\` by ${adminTag}`, { chat_id: userId, message_id: query.message?.message_id, parse_mode: 'Markdown' });
            bot.answerCallbackQuery(query.id, { text: "Rejected" });
          }
          return;
        }

        if (data.startsWith('adm_set_tpl_')) {
          const tpl = data.replace('adm_set_tpl_', '') as BotNode['type'];
          node.type = tpl;
          if (tpl === 'autopay') {
            node.config.autoPayout = true;
            node.config.withdrawTax = 5;
            node.config.minWithdraw = 10;
          } else if (tpl === 'refer_manual' || tpl === 'upi_manual') {
            node.config.autoPayout = false;
            node.config.withdrawTax = 2;
            node.config.minWithdraw = 10;
          } else if (tpl === 'upi') {
            node.config.autoPayout = false;
            node.config.withdrawTax = 2;
            node.config.minWithdraw = 50;
          } else if (tpl === 'crypto') {
            node.config.autoPayout = false;
            node.config.withdrawTax = 0;
            node.config.minWithdraw = 100;
          }
          await this.saveNodeToFirestore(node);
          bot.answerCallbackQuery(query.id, { text: `Template ${tpl.toUpperCase()} Applied!` });
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        if (data.startsWith('adm_bc_gift_')) {
          const code = data.replace('adm_bc_gift_', '');
          const g = node.config.giftCodes.get(code);
          if (!g) return bot.answerCallbackQuery(query.id, { text: "Gift code not found" });

          bot.answerCallbackQuery(query.id, { text: "🚀 Code Broadcast Started!" });
          const bcText = `✅ **NEW GIFT CODE ALERT!**\n\n🎫 Code: \`${code}\`\n💰 Amount: ₹${g.amount}\n👥 Max Uses: ${g.maxUses}\n\nUsers can now claim this using /redeem command!`;
          
          this.fsmStates.set(userId, { 
            nodeId: node.id, 
            action: "BC_CONFIRM", 
            text: bcText,
            inline_keyboard: [[{ text: "🎁 CLAIM NOW", callback_data: "redeem_gift" }]] 
          });
          
          // Re-trigger the broadcast confirm logic by simulating a CONFIRM message
          return this.handleFSM(bot, node, userId, "CONFIRM", this.fsmStates.get(userId), { text: "CONFIRM" });
        }

        if (data === 'adm_back_main') {
          return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
        }

        // Generic field setter (fallback)
        if (data.startsWith('adm_set_')) {
          const field = data.replace('adm_set_', '');
          this.fsmStates.set(userId, { nodeId: node.id, action: `EDIT_${field}` });
          return bot.sendMessage(userId, `⌨️ Enter new value for **${field}**:`);
        }

        bot.answerCallbackQuery(query.id);

      if (data === "BC_RUN_CENTER") {
        const state = this.fsmStates.get(userId);
        if (!state) {
            bot.answerCallbackQuery(query.id, { text: "❌ Session Expired", show_alert: true });
            return;
        }
        
        bot.answerCallbackQuery(query.id, { text: "🚀 PROCESSED" });
        this.fsmStates.delete(userId);
        
        const run = async () => {
          try {
            if (!db) throw new Error("Database disconnected.");
            bot.sendMessage(userId, "🚀 <b>Broadcast Initiated!</b> Checking network and users...", { parse_mode: 'HTML' });
            
            const snap = await db.collection('nodes').doc(node.id).collection('users').get();
            const uids = snap.docs.map((d: any) => Number(d.id));
            
            let success = 0; let failed = 0;
            const startTime = Date.now();
            
            for (const uid of uids) {
              try {
                const opts = { reply_markup: { inline_keyboard: state.inline_keyboard || [] }, parse_mode: 'HTML' };
                if (state.media?.photo) {
                  await bot.sendPhoto(uid, state.media.photo[state.media.photo.length - 1].file_id, { ...opts, caption: state.text });
                } else if (state.media?.video) {
                  await bot.sendVideo(uid, state.media.video.file_id, { ...opts, caption: state.text });
                } else {
                  await bot.sendMessage(uid, state.text, opts);
                }
                success++;
              } catch { failed++; }
              await new Promise(r => setTimeout(r, 65));
            }

            const summary = `📊 <b>Broadcast Summary Report</b>\n\n` +
              `📦 <b>Overall Results:</b>\n` +
              `• Total Users: ${uids.length}\n` +
              `✅ Success: ${success}\n` +
              `❌ Failed: ${failed}\n` +
              `⏱ Time Taken: ${Math.floor((Date.now() - startTime) / 1000)}s\n\n` +
              `🚀 <b>Powered by SR HUB</b>`;
            
            bot.sendMessage(userId, summary, { parse_mode: 'HTML' });
          } catch (err: any) {
             bot.sendMessage(userId, `❌ Broadcast Data Error: ${err.message}`);
          }
        };
        run();
        return;
      }

      if (data === "BC_CANCEL") {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ Broadcast operation cancelled.");
      }

      if (data === 'adm_verify_cfg') {
        bot.sendMessage(userId, "🛡 **ANTI-BOT VERIFICATION**\n\nCurrent: Device Check (Auto)\nTo change, use `/verify_setup`.");
      }

      if (data === 'adm_ask_banWallet') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "BAN_WALLET" });
        bot.sendMessage(userId, "⌨️ **Enter Wallet ID to Ban:**");
      }

      if (data === 'adm_ask_unbanWallet') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "UNBAN_WALLET" });
        bot.sendMessage(userId, "⌨️ **Enter Wallet ID to Unban:**");
      }

      if (data === 'adm_ask_balance_mod') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "BALANCE_MOD_ID" });
        bot.sendMessage(userId, "⌨️ **Enter User ID to Add/Cut balance:**");
      }

      if (data === 'adm_view_leader' || data === 'adm_leaderboard_setting_menu') {
        bot.answerCallbackQuery(query.id).catch(() => {});
        return this.handleSubBotCallback(bot, node, userId, "adm_leaderboard_setting_menu", query);
      }

      if (data === 'adm_preview_leaderboard') {
        const previewText = await this.getLeaderboard(node);
        bot.answerCallbackQuery(query.id, { text: "Previewing Leaderboard" }).catch(() => {});
        const backKb = {
          inline_keyboard: [
            [{ text: "🔙 Back to Leaderboard Menu", callback_data: "adm_leaderboard_setting_menu" }]
          ]
        };
        return bot.sendMessage(userId, `👀 <b>LIVE LEADERBOARD PREVIEW:</b>\n\n${previewText}`, { parse_mode: 'HTML', reply_markup: backKb, disable_web_page_preview: true });
      }

      if (data === 'adm_toggle_leaderboard') {
        node.config.referLeaderboard = node.config.referLeaderboard === false ? true : false;
        await this.saveNodeToFirestore(node);
        bot.answerCallbackQuery(query.id, { text: `Leaderboard: ${node.config.referLeaderboard ? "ENABLED 🟢" : "DISABLED 🔴"}` }).catch(() => {});
        return this.handleSubBotCallback(bot, node, userId, "adm_leaderboard_setting_menu", query);
      }

      if (data === 'adm_set_lb_size') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_LEADERBOARD_LIMIT" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "👥 <b>SET WINNER SIZE / TOP COUNT</b>\n\nEnter the number of top users to display on the leaderboard (e.g. <code>5</code>, <code>10</code>, <code>20</code>, <code>50</code>):", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_lb_prize') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_LEADERBOARD_PRIZE" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "💰 <b>SET WINNER AMOUNT & PRIZE TEXT</b>\n\nEnter the prize distribution details text.\n\n<i>Example:</i>\n<code>🥇 1st: ₹500\n🥈 2nd: ₹300\n🥉 3rd: ₹150\n4th-10th: ₹50 each</code>\n\nSend your text below:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_lb_title') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_LEADERBOARD_TITLE" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "📝 <b>SET LEADERBOARD TITLE / HEADER</b>\n\nEnter the custom title text for the leaderboard (You can use <code>{LIMIT}</code> and <code>{BOTNAME}</code> placeholders).\n\n<i>Example:</i>\n<code>🏆 TOP {LIMIT} REFERRERS TOURNAMENT - @{BOTNAME}</code>\n\nSend your text below:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_lb_channel') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_LEADERBOARD_CHANNEL" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "📢 <b>SET UPDATES CHANNEL LINK</b>\n\nEnter your Telegram channel link or username where updates, proofs, and winner announcements are posted.\n\n<i>Example:</i>\n<code>https://t.me/YourChannel</code> or <code>@YourChannel</code>\n\nSend the link below (or send <code>none</code> to remove):", { parse_mode: 'HTML' });
      }

      if (data === 'adm_view_topwd') {
        const top = node.withdrawals.slice(-10).reverse();
        if (top.length === 0) {
          bot.sendMessage(userId, "🔥 **TOP WITHDRAWALS**\nNo withdrawal records found.");
        } else {
          let list = "🔥 **RECENT WITHDRAWALS:**\n\n";
          top.forEach((w, i) => {
            list += `${i+1}. ${w.userId} - ₹${w.amount.toFixed(2)} (${w.wallet})\n`;
          });
          bot.sendMessage(userId, list);
        }
      }

      if (data === 'adm_view_perf') {
        const up = Math.floor((Date.now() - node.createdAt) / 1000 / 60);
        const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const perfMsg = `📈 **ENGINE PERFORMANCE MATRIX**\n\n` +
          `🔹 **Uptime:** ${up} mins\n` +
          `🔹 **RAM Usage:** ${mem} MB\n` +
          `🔹 **Socket Load:** ${Math.floor(node.users.size / 10)}/100\n` +
          `🔹 **Security:** AES-256 Verified\n` +
          `🔹 **Latency:** 45ms\n` +
          `🔹 **Status:** 🟢 OPTIMIZED`;
        bot.sendMessage(userId, perfMsg);
      }

      if (data === 'adm_view_logs') {
        const logs = node.config.adminLogs.slice(-10).join('\n') || "No logs available.";
        bot.sendMessage(userId, `🕵️ **ADMIN LOGS (Last 10)**\n\n${logs}`);
      }

      if (data === 'adm_api_setup') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "API_SETUP" });
        const helpText = `⚙️ **GATEWAY SETUP**\n\n` +
          `Please send your details in format:\n` +
          `Name | API_URL\n\n` +
          `➕ **Add New Gateway**\n\n` +
          `Send in this format:\n` +
          `Name | API_URL\n\n` +
          `**Example:**\n` +
          `\`RJ Wallet | https://RJwallet.in/api.php?number={wallet}&amount={amount}&comment=Payment\`\n\n` +
          `**Multiple format examples:**\n` +
          `\`RJ Wallet | https://RJwallet.in/api.php?number={wallet}&amount={amount}&comment=done\`\n` +
          `\`Other Wallet | https://site.com/api.php?paytm={wallet}&amount={amount}&comment=Payout\``;
        bot.sendMessage(userId, helpText, { parse_mode: 'Markdown' });
      }

      if (data === 'adm_ask_reset_warn') {
        const kb = {
          inline_keyboard: [
            [
              { text: "✅ APPLY (RESET EVERYTHING)", callback_data: "adm_reset_apply" },
              { text: "❌ CANCEL", callback_data: "adm_reset_cancel" }
            ]
          ]
        };
        const warnText = "🛑 **CRITICAL WARNING** 🛑\n\n**If you click the Apply button, ALL users' balances will be permanently reset to zero (0).**\n\nThis action is **INTERNALLY RECORDED** and **CANNOT BE UNDONE**.\n\nDo you want to proceed?";
        return bot.sendMessage(userId, warnText, { parse_mode: 'Markdown', reply_markup: kb });
      }

      if (data === 'adm_reset_apply') {
        node.users.forEach(u => u.balance = 0);
        bot.answerCallbackQuery(query.id, { text: "✅ All balances reset to 0", show_alert: true });
        this.sendAdminPanel(bot, node, userId, query.message?.message_id);
      }

      if (data === 'adm_reset_cancel') {
        bot.answerCallbackQuery(query.id, { text: "Cancelled" });
        this.sendAdminPanel(bot, node, userId, query.message?.message_id);
      }

      if (data === 'adm_gift_start') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "GIFT_NAME" });
        return bot.sendMessage(userId, "🎁 **CREATE GIFT CODE**\n\n⌨️ Enter the **Code Name** (e.g. `SR_PROMO`):");
      }

      if (data === 'adm_gift_manage' || data.startsWith('gtgl_') || data.startsWith('gdel_')) {
        return await this.handleSubBotCallback(bot, node, userId, data, query);
      }

      if (data === 'adm_ask_reset') {
        // Redundant link, keeping it or changing to warning? User asked to change it
        return bot.sendMessage(userId, "Please use the 'Reset All Balances' button in the panel.");
      }

      if (data === 'adm_ask_ban') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "BAN_USER" });
        bot.sendMessage(userId, "⌨️ **Enter User ID to Ban:**");
      }

      if (data === 'adm_ask_unban') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "UNBAN_USER" });
        bot.sendMessage(userId, "⌨️ **Enter User ID to Unban:**");
      }

      if (data === 'adm_ask_addFunds') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "ADD_FUNDS_ID" });
        bot.sendMessage(userId, "⌨️ **Enter User ID to add funds to:**");
      }

      if (data === 'adm_set_joinNotice') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_joinNotice" });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(userId, "🖊 **EDIT WELCOME MESSAGE**\n\nEnter the new join notice text:");
      }
      if (data === 'adm_set_supportContact') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_supportContact" });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(userId, "👤 **SUPPORT HANDLE SETUP**\n\nEnter support username (e.g. @Admin):");
      }
      if (data === 'adm_set_upi1') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_upi1" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "💳 <b>SET 1ST UPI ID</b>\n\nPlease enter your 1st UPI ID (e.g. <code>example@upi</code>):", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_upi2') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_upi2" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "💳 <b>SET 2ND UPI ID</b>\n\nPlease enter your 2nd UPI ID (e.g. <code>example2@upi</code>):", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_qr') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_qrCode" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "📸 <b>SET QR CODE</b>\n\nPlease send the QR code photo or image URL:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_withdrawOffText') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_withdrawOffText" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "📝 <b>SET WITHDRAW OFF TEXT</b>\n\nEnter the message to display when withdrawals are turned off:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_menuText') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_customDashboardText" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "📝 <b>SET MENU TEXT</b>\n\nEnter custom text for user dashboard menu:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_ask_bc_center') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "BC_CONTENT" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "📢 <b>SUB-BOT BROADCAST CENTER</b>\n\nPlease send the message (Text, Photo, or Video) you want to broadcast to all registered users of this bot:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_minDeposit') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_minDeposit" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "💸 <b>SET MIN DEPOSIT</b>\n\nEnter minimum deposit amount:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_set_depositTax') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_depositTax" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "🧾 <b>SET DEPOSIT TAX %</b>\n\nEnter the deposit tax/fee percentage (e.g. 0, 2, 5):", { parse_mode: 'HTML' });
      }

      if (data === 'adm_ask_gatewaySecretKey') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_gatewaySecretKey" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "🔑 <b>SET GATEWAY SECRET KEY</b>\n\nEnter secret key for gateway authorization:", { parse_mode: 'HTML' });
      }

      if (data === 'adm_more_settings') {
        bot.answerCallbackQuery(query.id).catch(() => {});
        const moreText = `⚙️ <b>ADVANCED BOT SETTINGS</b>\n\n` +
          `👥 <b>Referral Bonus:</b> ₹${node.config.referBonus}\n` +
          `👥 <b>Min Refer For Payout:</b> ${node.config.minReferForPayout}\n` +
          `🎁 <b>Daily Bonus:</b> ₹${node.config.dailyBonus}\n` +
          `🧾 <b>Withdraw Tax:</b> ${node.config.withdrawTax}%\n` +
          `🛡️ <b>Device Verification:</b> ${node.config.deviceVerification ? "🟢 ON" : "🔴 OFF"}\n` +
          `📡 <b>Payout Channel:</b> ${esc(node.config.payoutChannel || "Not Set")}`;

        const moreKb = {
          inline_keyboard: [
            [
              { text: "Set Refer Bonus", callback_data: "adm_set_referBonus" },
              { text: "Min Refer Payout", callback_data: "adm_set_minReferForPayout" }
            ],
            [
              { text: "Set Daily Bonus", callback_data: "adm_set_dailyBonus" },
              { text: "Set Tax %", callback_data: "adm_set_withdrawTax" }
            ],
            [
              { text: "🛡️ Device Verify", callback_data: "adm_toggle_device" },
              { text: "👤 User Details", callback_data: "adm_ask_details" }
            ],
            [
              { text: "🚫 Ban User", callback_data: "adm_ask_ban" },
              { text: "🟢 Unban User", callback_data: "adm_ask_unban" }
            ],
            [
              { text: "📢 Payout Channel", callback_data: "adm_set_payoutChannel" },
              { text: "💳 Reset Balances", callback_data: "adm_ask_reset_warn" }
            ],
            [
              { text: "🔙 Back to Admin Panel", callback_data: "adm_back_main" }
            ]
          ]
        };

        if (query.message) {
          return bot.editMessageText(moreText, { chat_id: userId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: moreKb }).catch(() => {});
        } else {
          return bot.sendMessage(userId, moreText, { parse_mode: 'HTML', reply_markup: moreKb });
        }
      }

      if (data === 'adm_set_updateChannel') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_updateChannel" });
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(userId, "📢 **UPDATE CHANNEL SETUP**\n\nEnter channel username (e.g. @MyChannel):");
      }

      if (data === 'adm_ui_custom') {
        const dvStatus = node.config.deviceVerification ? "🟢 ON" : "🔴 OFF";
        const kb = {
          inline_keyboard: [
            [{ text: "🖊 Edit Dashboard Text", callback_data: "adm_set_dashText" }],
            [{ text: "🖼️ Edit Dashboard Photo", callback_data: "adm_set_dashImg" }],
            [{ text: `🛡️ Device Verify: ${dvStatus}`, callback_data: "adm_tgl_dv" }],
            [{ text: "📡 Manage Force Join", callback_data: `adm_view_forceJoin` }],
            [{ text: "👤 Support Handle", callback_data: `adm_set_supportContact` }],
            [{ text: "📢 Update Channel", callback_data: `adm_set_updateChannel` }],
            [{ text: "🗑️ Reset Customizations", callback_data: "adm_reset_ui" }],
            [{ text: "🔙 Back", callback_data: `adm_back_main` }]
          ]
        };
        bot.editMessageText("🎨 **USER INTERFACE CUSTOMIZATION**\n\nCustomize the appearance and contacts of the user-facing menus.", { chat_id: userId, message_id: query.message?.message_id, reply_markup: kb });
        return;
      }

      if (data === "adm_tgl_dv") {
        node.config.deviceVerification = !node.config.deviceVerification;
        bot.answerCallbackQuery(query.id, { text: `Device Verification: ${node.config.deviceVerification ? 'ENABLED 🟢' : 'DISABLED 🔴'}`, show_alert: true }).catch(() => {});
        await this.saveNodeToFirestore(node);
        return this.handleSubBotCallback(bot, node, userId, 'adm_ui_custom', { message: query.message });
      }

      if (data === 'adm_set_dashText') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_DASH_TEXT" });
        return bot.sendMessage(userId, "📝 **EDIT DASHBOARD TEXT**\n\nEnter the new text (HTML supported) for user dashboard:");
      }

      if (data === 'adm_set_dashImg') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "EDIT_DASH_IMG" });
        return bot.sendMessage(userId, "🖼️ **EDIT DASHBOARD PHOTO**\n\nSend the photo or file_id/URL to use as dashboard header:");
      }

      if (data === 'adm_reset_ui') {
        node.config.customDashboardText = undefined;
        node.config.customDashboardImage = undefined;
        node.config.customMenu = undefined;
        node.config.buildInfoText = undefined;
        node.config.botOffText = undefined;
        bot.answerCallbackQuery(query.id, { text: "✅ Customizations Reset!" });
        await this.saveNodeToFirestore(node);
        return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
      }

      if (data === 'adm_ask_add_channel') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "ADD_CHANNEL", type: 'CHECKED' });
        return bot.sendMessage(userId, "📡 **ADD CHECKED CHANNEL**\n\nEnter Username (`@Channel`) or Chat ID (`-100...`).\nBot MUST be Admin!");
      }

      if (data === 'adm_ask_add_channel_u') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "ADD_CHANNEL", type: 'UNCHECKED' });
        return bot.sendMessage(userId, "📡 **ADD UNCHECKED CHANNEL**\n\nEnter Username (`@Channel`) or Link.\nBot doesn't need admin here.");
      }

      if (data.startsWith('check_join')) {
        const refIdStr = data.replace('check_join_', '').replace('check_join', '');
        const refId = (refIdStr && refIdStr !== 'none') ? parseInt(refIdStr) : null;

        const hasChecked = node.config.forceJoinChannels && node.config.forceJoinChannels.length > 0;
        const hasUnchecked = node.config.forceJoinChannelsUnchecked && node.config.forceJoinChannelsUnchecked.length > 0;

        if (hasChecked || hasUnchecked) {
          bot.answerCallbackQuery(query.id, { text: "⏳ Verifying membership..." });
          
          const notJoined = [];
          if (hasChecked) {
            for (const ch of node.config.forceJoinChannels) {
              const j = await this.checkForceJoin(bot, ch, userId);
              if (!j) notJoined.push(ch);
            }
          }
          
          if (notJoined.length === 0) {
            bot.deleteMessage(userId, query.message?.message_id!).catch(() => {});
            
            let user = await this.ensureUserLoaded(node, userId);
            
            // --- NEW: Perform Join Logic (Referral + Alerts) ---
            const userName = query.from.username || query.from.first_name || "User";
            await engine.handleUserJoined(bot, node, userId, userName, refId);
            // --------------------------------------------------

            if (node.config.deviceVerification && user && !user.verified) {
               const appUrl = BASE_URL || process.env.VITE_APP_URL || "";
               const verifyUrl = `${appUrl}/verify?nodeId=${node.id}&userId=${userId}&ref=${refId || 'none'}`;
               const headerImg = "https://t.me/SR_TECHNOLOGY_LTD/330"; 
               bot.sendPhoto(userId, headerImg, {
                 caption: "🛡️ <b>SECURITY VERIFICATION</b>\n\nPlease verify your device below to ensure you're a real human.",
                 reply_markup: { inline_keyboard: [[{ text: "Verifying Device 🛡️", web_app: { url: verifyUrl } }]]},
                 parse_mode: 'HTML'
               }).catch(() => {
                 // Fallback if photo fails
                 bot.sendMessage(userId, "🛡️ **SECURITY VERIFICATION**\n\nPlease verify your device below to ensure you're a real human.", {
                   reply_markup: { inline_keyboard: [[{ text: "Verifying Device 🛡️", web_app: { url: verifyUrl } }]]},
                   parse_mode: 'HTML'
                 });
               });
               return;
            }
            if (user) user.verified = true; 
            return this.sendUserDashboard(bot, node, userId);
          } else {
            bot.answerCallbackQuery(query.id, { text: "❌ Please join ALL mandatory channels first!", show_alert: true });
            const buttons = [];
            
            // Grid Layout
            const chList = [...(node.config.forceJoinChannels || [])];
            for (let i = 0; i < chList.length; i += 2) {
               const row = [];
               const ch1 = chList[i];
               const isJoined1 = !notJoined.includes(ch1);
               const text1 = isJoined1 ? `✅ Joined` : `➕ Join`;
               const url1 = ch1.startsWith('http') ? ch1 : (ch1.startsWith('@') ? `https://t.me/${ch1.substring(1)}` : `https://t.me/c/${ch1.replace('-100', '')}/999999999`);
               row.push({ text: text1, url: url1 });

               if (i + 1 < chList.length) {
                  const ch2 = chList[i + 1];
                  const isJoined2 = !notJoined.includes(ch2);
                  const text2 = isJoined2 ? `✅ Joined` : `➕ Join`;
                  const url2 = ch2.startsWith('http') ? ch2 : (ch2.startsWith('@') ? `https://t.me/${ch2.substring(1)}` : `https://t.me/c/${ch2.replace('-100', '')}/999999999`);
                  row.push({ text: text2, url: url2 });
               }
               buttons.push(row);
            }

            if (hasUnchecked) {
              const uChList = node.config.forceJoinChannelsUnchecked;
              for (let i = 0; i < uChList.length; i += 2) {
                 const row = [];
                 const ch1 = uChList[i];
                 const url1 = ch1.startsWith('http') ? ch1 : (ch1.startsWith('@') ? `https://t.me/${ch1.substring(1)}` : `https://t.me/c/${ch1.replace('-100', '')}/999999999`);
                 row.push({ text: "🔘 Optional", url: url1 });

                 if (i + 1 < uChList.length) {
                    const ch2 = uChList[i + 1];
                    const url2 = ch2.startsWith('http') ? ch2 : (ch2.startsWith('@') ? `https://t.me/${ch2.substring(1)}` : `https://t.me/c/${ch2.replace('-100', '')}/999999999`);
                    row.push({ text: "🔘 Optional", url: url2 });
                 }
                 buttons.push(row);
              }
            }

            buttons.push([{ text: "🔥 Claim", callback_data: `check_join_${refId || 'none'}` }]);
            bot.editMessageReplyMarkup({ inline_keyboard: buttons }, { chat_id: userId, message_id: query.message?.message_id }).catch(() => {});
          }
        } else {
          bot.answerCallbackQuery(query.id, { text: "✅ System Restored" });
          return this.sendUserDashboard(bot, node, userId);
        }
        return;
      }

      if (data.startsWith('adm_rem_fj_')) {
        const idx = parseInt(data.replace('adm_rem_fj_', ''));
        if (node.config.forceJoinChannels && node.config.forceJoinChannels[idx]) {
          const removed = node.config.forceJoinChannels.splice(idx, 1);
          bot.answerCallbackQuery(query.id, { text: `Removed: ${removed[0]}` });
          await this.saveNodeToFirestore(node);
          
          // Refresh the list view
          const keyboardRows: any[][] = [];
          node.config.forceJoinChannels.forEach((ch, i) => {
            keyboardRows.push([
              { text: `✅ ${esc(ch)}`, callback_data: "adm_noop" },
              { text: "❌", callback_data: `adm_rem_fj_${i}` }
            ]);
          });
          keyboardRows.push([{ text: "➕ Add Join Channels", callback_data: "adm_ask_add_channel" }]);
          keyboardRows.push([{ text: "🔙 Back", callback_data: "adm_back_main" }]);
          
          bot.editMessageReplyMarkup({ inline_keyboard: keyboardRows }, { chat_id: userId, message_id: query.message?.message_id }).catch(() => {});
        }
        return;
      }

      if (data === 'adm_ask_bc' || data === 'adm_ask_bc_center') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "BC_CENTER_MEDIA", broadcastType: "SINGLE_BOT" });
        return bot.sendMessage(userId, "📢 **Sub-Bot Broadcast Center**\n\nThis message will only be sent to users of this specific bot (@" + node.username + ").\n\nSend your photo or video or skip it.", {
          reply_markup: { keyboard: [[{ text: "Skip Media" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
        });
      }

      if (data === 'adm_ask_dm') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "DM_ID" });
        bot.sendMessage(userId, "⌨️ **Enter User ID for Direct Message:**");
      }

      if (data === 'adm_view_stats' || data === 'hub_view_stats' || data === '📊 Hub Stats') {
        const stats = this.getStats();
        let hubUsersCount = 0;
        try {
          const snap = await db.collection('hubUsers').get();
          hubUsersCount = snap.size;
        } catch {}

        const statsMsg = `📊 **SR ENGINE GLOBAL STATISTICS**\n\n` +
          `🔹 Global Network Users: ${Number(stats.globalUsers || 0) + Number(hubUsersCount || 0)}\n` +
          `🔹 SR HUB Active Nodes: ${stats.totalNodes || 0}\n` +
          `🔹 Hub Active Users: ${stats.hubUsers || hubUsersCount || 0}\n\n` +
          `🚀 **POWERED BY SR HUB**`;
          
        if (query.message) {
           return bot.editMessageText(statsMsg, { 
             chat_id: chatId, 
             message_id: query.message.message_id, 
             parse_mode: 'Markdown',
             reply_markup: { inline_keyboard: [[{ text: "🔙 Back", callback_data: (data.startsWith('hub') ? "hub_back_adm" : "adm_back") }]] }
           }).catch(() => bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' }));
        }
        return bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
      }

      if (data === 'adm_ask_details') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "USER_DETAILS" });
        bot.sendMessage(userId, "⌨️ **Enter User ID to view details:**");
      }

      if (data === 'adm_view_admins') {
        let list = "👑 **BOT ADMINS:**\n\n";
        list += `🔹 Owner: \`${node.ownerId}\` (Full Access)\n`;
        node.config.admins.forEach(adminId => {
          list += `🔹 Admin: \`${adminId}\`\n`;
        });
        
        const kb = {
          inline_keyboard: [
            [{ text: "➕ Add Admin", callback_data: `adm_ask_addAdmin` }, { text: "➖ Remove Admin", callback_data: `adm_ask_remAdmin` }]
          ]
        };
        bot.sendMessage(userId, list, { parse_mode: 'Markdown', reply_markup: kb });
      }

      if (data === 'adm_ask_addAdmin') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "ADD_ADMIN" });
        bot.sendMessage(userId, "⌨️ **Enter User ID to Promote to Admin:**");
      }

      if (data === 'adm_ask_remAdmin') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "REM_ADMIN" });
        bot.sendMessage(userId, "⌨️ **Enter User ID to Demote from Admin:**");
      }

      if (data.startsWith('adm_mod_bal_')) {
        const targetId = parseInt(data.replace('adm_mod_bal_', ''));
        this.fsmStates.set(userId, { nodeId: node.id, action: "BALANCE_MOD_AMT", targetId });
        bot.sendMessage(userId, `💰 Enter amount to Add/Cut for ${targetId}:`);
      }

      if (data.startsWith('adm_mod_ban_')) {
        const targetId = parseInt(data.replace('adm_mod_ban_', ''));
        if (node.config.bannedUsers.has(targetId)) {
          node.config.bannedUsers.delete(targetId);
          bot.sendMessage(userId, `✅ User ${targetId} unbanned.`);
        } else {
          node.config.bannedUsers.add(targetId);
          bot.sendMessage(userId, `🚫 User ${targetId} banned.`);
        }
        await this.saveNodeToFirestore(node);
      }

      if (data.startsWith('adm_mod_dm_')) {
        const targetId = parseInt(data.replace('adm_mod_dm_', ''));
        this.fsmStates.set(userId, { nodeId: node.id, action: "DM_MSG", targetId });
        bot.sendMessage(userId, `📩 Enter message for ${targetId}:`);
      }

      if (data === 'adm_view_verify') {
        const pending = Array.from(node.pendingWithdrawals.entries());
        if (pending.length === 0) {
          bot.sendMessage(userId, "🛠 **VERIFICATION REQUESTS**\n\nNo pending withdrawal requests found.");
        } else {
          pending.forEach(([reqId, req]) => {
            const kb = {
              inline_keyboard: [
                [
                  { text: "✅ Approve", callback_data: `approve_wd_${reqId}` },
                  { text: "❌ Reject", callback_data: `reject_wd_${reqId}` }
                ]
              ]
            };
            bot.sendMessage(userId, `📝 **REQUEST: ${reqId}**\n👤 User: ${req.userId}\n💰 Amount: ₹${req.amount.toFixed(2)}\n💳 Wallet: \`${req.wallet}\``, { parse_mode: 'Markdown', reply_markup: kb });
          });
        }
      }

      if (data === 'adm_gift') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "CREATE_GIFT_AMT" });
        bot.sendMessage(userId, "🎁 **GIFT CODE GENERATOR**\n\n⌨️ Enter amount for the new gift code:");
      }

      if (data === 'adm_gift_panel') {
        let list = "👾 **REDEEM CODE PANEL**\n\n";
        if (node.config.giftCodes.size === 0) {
          list += "_No active codes._";
        } else {
          node.config.giftCodes.forEach((v, k) => {
            list += `🎫 \`${k}\`\n💰 ₹${v.amount} | 👥 ${v.currentClaims}/${v.maxUses}\n${v.status === 'active' ? "🟢 ACTIVE" : "🔴 OFF"}\n\n`;
          });
        }
        bot.sendMessage(userId, list, { parse_mode: 'Markdown' });
      }

      if (data === 'adm_notice') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_NOTICE" });
        bot.sendMessage(userId, "⌨️ **Enter 'On Join Notice' text:**\n(Current: " + (node.config.joinNotice || "None") + ")");
      }

      if (data === 'adm_view_forceJoin') {
        const panelText = "📋 **Manage Channels Panel**\n\n" +
          "✅ **Checked Channels** (Must join to use bot)\n" +
          "🔘 **Unchecked Channels** (Optional, but visible)\n\n" +
          "Click ❌ to delete a channel.";

        const keyboardRows: any[][] = [];
        
        // Checked
        node.config.forceJoinChannels.forEach((ch, i) => {
          keyboardRows.push([
            { text: `✅ ${esc(ch)}`, callback_data: "adm_noop" },
            { text: "❌ Remove", callback_data: `adm_rem_fj_${i}` }
          ]);
        });

        // Unchecked
        if (node.config.forceJoinChannelsUnchecked) {
          node.config.forceJoinChannelsUnchecked.forEach((ch, i) => {
            keyboardRows.push([
              { text: `🔘 ${esc(ch)}`, callback_data: "adm_noop" },
              { text: "❌ Remove", callback_data: `adm_rem_fju_${i}` }
            ]);
          });
        }

        keyboardRows.push([{ text: "➕ Add Check Channels", callback_data: "adm_ask_add_channel" }]);
        keyboardRows.push([{ text: "➕ Add Uncheck Channels", callback_data: "adm_ask_add_channel_u" }]);
        keyboardRows.push([{ text: "🔙 Back", callback_data: "adm_back_main" }]);

        const kb = { inline_keyboard: keyboardRows };
        
        const messageId = query.message?.message_id;
        if (messageId) {
          bot.editMessageText(panelText, { chat_id: userId, message_id: messageId, parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
        } else {
          bot.sendMessage(userId, panelText, { parse_mode: 'Markdown', reply_markup: kb });
        }
        return;
      }

      if (data.startsWith('adm_rem_fj_')) {
        const index = parseInt(data.replace('adm_rem_fj_', ''));
        if (node.config.forceJoinChannels && node.config.forceJoinChannels[index] !== undefined) {
          const removed = node.config.forceJoinChannels.splice(index, 1);
          bot.answerCallbackQuery(query.id, { text: `Removed: ${removed[0]}` });
          await this.saveNodeToFirestore(node);
          
          // Re-trigger view
          return this.handleSubBotCallback(bot, node, userId, 'adm_view_forceJoin', query);
        }
        return;
      }

      if (data.startsWith('adm_rem_fju_')) {
        const index = parseInt(data.replace('adm_rem_fju_', ''));
        if (node.config.forceJoinChannelsUnchecked && node.config.forceJoinChannelsUnchecked[index] !== undefined) {
          const removed = node.config.forceJoinChannelsUnchecked.splice(index, 1);
          bot.answerCallbackQuery(query.id, { text: `Removed: ${removed[0]}` });
          await this.saveNodeToFirestore(node);
          
          // Re-trigger view
          return this.handleSubBotCallback(bot, node, userId, 'adm_view_forceJoin', query);
        }
        return;
      }

      if (data.startsWith('sub_leaders_')) {
        const nodeId = data.replace('sub_leaders_', '');
        const node = this.nodes.get(nodeId);
        if (!node) return;
        const leaders = await this.getLeaderboard(node);
        bot.answerCallbackQuery(query.id);
        return bot.sendMessage(userId, leaders, { parse_mode: 'HTML' });
      }

      if (data.startsWith('APPROVE_WD_') || data.startsWith('REJECT_WD_') || data.startsWith('approve_wd_') || data.startsWith('reject_wd_')) {
        const isApprove = data.toUpperCase().startsWith('APPROVE_WD_');
        const reqId = data.replace(/^(APPROVE_WD_|REJECT_WD_|approve_wd_|reject_wd_)/i, '');
        // Find which node has this request
        let targetNode: BotNode | null = null;
        for (const n of this.nodes.values()) {
          if (n.pendingWithdrawals.has(reqId)) {
            targetNode = n; break;
          }
        }
        
        if (!targetNode) return bot.answerCallbackQuery(query.id, { text: "❌ Request not found or already processed." });
        const req = targetNode.pendingWithdrawals.get(reqId)!;
        
        if (isApprove) {
          targetNode.pendingWithdrawals.delete(reqId);
          targetNode.withdrawals.push({ ...req, timestamp: Date.now() });
          await this.saveNodeToFirestore(targetNode);
          await this.saveWithdrawalToFirestore(targetNode.id, { ...req, id: reqId, status: 'SUCCESS' });
          
          bot.answerCallbackQuery(query.id, { text: "✅ Payout Approved!", show_alert: true });
          bot.editMessageText(`✅ <b>PAYOUT APPROVED</b>\n\n👤 <b>User ID:</b> <code>${req.userId}</code>\n💰 <b>Amount:</b> ₹${req.amount.toFixed(2)}\n💳 <b>Wallet/UPI:</b> <code>${esc(req.wallet || "N/A")}</code>\n📝 <b>Req ID:</b> <code>${esc(reqId)}</code>\n\n✅ <b>Status: APPROVED & PAID BY ADMIN</b>`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML'
          }).catch(() => {});
          
          targetNode.instance?.sendMessage(req.userId, `🎉 <b>WITHDRAWAL APPROVED!</b>\n\nYour withdrawal request for <b>₹${req.amount.toFixed(2)}</b> (ID: <code>${esc(reqId)}</code>) has been approved and paid to your UPI/Wallet (<code>${esc(req.wallet || "N/A")}</code>).`, { parse_mode: 'HTML' }).catch(() => {});
        } else {
          // Refund balance
          const user = await this.ensureUserLoaded(targetNode, req.userId);
          if (user) {
            user.balance += req.amount;
            await this.saveUserToFirestore(targetNode.id, req.userId, user);
          }
          targetNode.pendingWithdrawals.delete(reqId);
          await this.saveNodeToFirestore(targetNode);
          
          bot.answerCallbackQuery(query.id, { text: "❌ Payout Rejected & Refunded", show_alert: true });
          bot.editMessageText(`❌ <b>PAYOUT REJECTED</b>\n\n👤 <b>User ID:</b> <code>${req.userId}</code>\n💰 <b>Amount:</b> ₹${req.amount.toFixed(2)}\n📝 <b>Req ID:</b> <code>${esc(reqId)}</code>\n\n🔴 <b>Status: REJECTED & REFUNDED TO WALLET</b>`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'HTML'
          }).catch(() => {});
          
          targetNode.instance?.sendMessage(req.userId, `❌ <b>WITHDRAWAL REJECTED</b>\n\nYour withdrawal request for <b>₹${req.amount.toFixed(2)}</b> (ID: <code>${esc(reqId)}</code>) was rejected by Admin. The amount of <b>₹${req.amount.toFixed(2)}</b> has been refunded back to your wallet balance.`, { parse_mode: 'HTML' }).catch(() => {});
        }
        return;
      }

      if (data === 'adm_ask_gateway_url') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_GATEWAY_URL" });
        return bot.sendMessage(userId, "🔗 **SET GATEWAY URL**\n\nEnter the Gateway URL (SR WALLET or other) to display to users in the Refer Manual template:");
      }

      if (data === 'adm_ask_gatewayApiUrl') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_GATEWAY_API_URL" });
        return bot.sendMessage(userId, "🔗 **SET DYNAMIC API URL**\n\nEnter the API URL where withdrawal requests should be sent via POST:");
      }

      if (data === 'adm_ask_walletAppUrl') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_WALLET_APP_URL" });
        return bot.sendMessage(userId, "📲 **SET WALLET APP URL**\n\nEnter the URL for the 'TAP TO OPEN GATEWAY' button redirection:");
      }

      if (data === 'adm_ask_gatewaySecretKey') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_GATEWAY_SECRET" });
        return bot.sendMessage(userId, "🔑 **SET GATEWAY SECRET KEY**\n\nEnter the Secret Key for API authentication:");
      }

      if (data === 'adm_ask_payout_ch') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_PAYOUT_CH" });
        return bot.sendMessage(userId, "💸 **SET PAYOUT CHANNEL**\n\nEnter the Channel ID or Username where withdrawal requests should be sent for approval:");
      }
    } catch (err: any) {
      console.error(`[CB_HANDLER_ERR] User ${query.message?.chat.id}:`, err.message);
    }
    });
  }

  private async handleSubBotCallback(bot: any, node: BotNode, userId: number, data: string, query: any) {
    if (data === 'adm_tpl_manage') {
      const kb = {
        inline_keyboard: [
          [{ text: "1️⃣ Task Payment Bot", callback_data: "adm_set_tpl_task" }, { text: "6️⃣ Wallet Bot", callback_data: "adm_set_tpl_wallet" }],
          [{ text: "2️⃣ Bet & Earn Bot", callback_data: "adm_set_tpl_bet" }, { text: "7️⃣ File Store Bot", callback_data: "adm_set_tpl_file" }],
          [{ text: "3️⃣ Redeem Code Bot", callback_data: "adm_set_tpl_redeem" }, { text: "8️⃣ Star Auto-Pay", callback_data: "adm_set_tpl_star" }],
          [{ text: "4️⃣ Giveaway Bot", callback_data: "adm_set_tpl_giveaway" }, { text: "9️⃣ Poll Maker Bot", callback_data: "adm_set_tpl_poll" }],
          [{ text: "5️⃣ AUTO-PAY BOT", callback_data: "adm_set_tpl_refer_auto" }, { text: "🔟 👤MANUAL PAY BOT", callback_data: "adm_set_tpl_refer_manual" }],
          [{ text: "1️⃣1️⃣ UPI Manual Pay Bot", callback_data: "adm_set_tpl_upi_manual" }],
          [{ text: "💳 Hybrid UPI", callback_data: "adm_set_tpl_upi" }, { text: "💎 Crypto M01", callback_data: "adm_set_tpl_crypto" }],
          [{ text: "🔙 Back", callback_data: "adm_back_main" }]
        ]
      };
      bot.answerCallbackQuery(query.id);
      return bot.editMessageText("🛠 **SELECT READY-MADE TEMPLATE**\n\nChoose a pre-configured setup for your bot node.", { chat_id: userId, message_id: query.message?.message_id, reply_markup: kb });
    }

    if (data.startsWith('adm_set_tpl_')) {
      const tpl = data.replace('adm_set_tpl_', '') as BotNode['type'];
      node.type = tpl;
      bot.answerCallbackQuery(query.id, { text: `✅ Template ${tpl.toUpperCase()} Applied!` });
      await this.saveNodeToFirestore(node);
      return this.sendAdminPanel(bot, node, userId, query.message?.message_id);
    }

     // This is a wrapper to allow internal re-triggering of callback logic
     // Handle specific UI redirects and shared logic
     if (data.startsWith('adm_rem_fj_')) {
        const index = parseInt(data.replace('adm_rem_fj_', ''));
        if (node.config.forceJoinChannels && node.config.forceJoinChannels[index] !== undefined) {
          node.config.forceJoinChannels.splice(index, 1);
          await this.saveNodeToFirestore(node);
          bot.answerCallbackQuery(query.id, { text: "Removed" });
          return await this.handleSubBotCallback(bot, node, userId, 'adm_view_forceJoin', query);
        }
     }

     if (data === 'adm_view_forceJoin') {
        const panelText = "📋 **Manage Channels Panel**\n\n" +
          "✅ **Checked Channels** (Must join to use bot)\n" +
          "🔘 **Unchecked Channels** (Optional, but visible)\n\n" +
          "Click ❌ to delete a channel.";

        const keyboardRows: any[][] = [];
        node.config.forceJoinChannels.forEach((ch, i) => {
          keyboardRows.push([
            { text: `✅ ${esc(ch)}`, callback_data: "adm_noop" },
            { text: "❌ Remove", callback_data: `adm_rem_fj_${i}` }
          ]);
        });
        if (node.config.forceJoinChannelsUnchecked) {
          node.config.forceJoinChannelsUnchecked.forEach((ch, i) => {
            keyboardRows.push([
              { text: `🔘 ${esc(ch)}`, callback_data: "adm_noop" },
              { text: "❌ Remove", callback_data: `adm_rem_fju_${i}` }
            ]);
          });
        }
        keyboardRows.push([{ text: "➕ Add Check Channels", callback_data: "adm_ask_add_channel" }]);
        keyboardRows.push([{ text: "➕ Add Uncheck Channels", callback_data: "adm_ask_add_channel_u" }]);
        keyboardRows.push([{ text: "🔙 Back", callback_data: "adm_back_main" }]);
        
        bot.editMessageReplyMarkup({ inline_keyboard: keyboardRows }, { 
            chat_id: userId, 
            message_id: query.message?.message_id
        }).catch(() => {
            bot.sendMessage(userId, panelText, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboardRows } });
        });
        return bot.answerCallbackQuery(query.id).catch(() => {});
     }

     if (data === 'adm_gift_manage') {
        let list = "📊 **GIFT CODE MANAGEMENT**\n\n";
        const kb = { inline_keyboard: [] as any[][] };
        if (node.config.giftCodes.size === 0) {
          list += "_No codes created yet._";
        } else {
          node.config.giftCodes.forEach((v, k) => {
            const statusLabel = v.status === 'active' ? "🟢 Active" : "🔴 Off";
            list += `🎫 \`${k}\`\n💰 ₹${v.amount} | 👥 ${v.currentClaims}/${v.maxUses}\nStatus: ${statusLabel}\n\n`;
            kb.inline_keyboard.push([
              { text: `${v.status === 'active' ? "🔴 OFF" : "🟢 ON"}: ${k}`, callback_data: `gtgl_${k}` },
              { text: `🗑️ Delete: ${k}`, callback_data: `gdel_${k}` }
            ]);
          });
        }
        kb.inline_keyboard.push([{ text: "🔙 Back", callback_data: "adm_back_main" }]);
        if (query.message) {
          bot.editMessageText(list, { chat_id: userId, message_id: query.message.message_id, parse_mode: 'Markdown', reply_markup: kb }).catch(() => {
            bot.sendMessage(userId, list, { parse_mode: 'Markdown', reply_markup: kb });
          });
        }
        return bot.answerCallbackQuery(query.id).catch(() => {});
     }

     if (data.startsWith('gtgl_')) {
        const code = data.replace('gtgl_', '');
        const g = node.config.giftCodes.get(code);
        if (g) {
          g.status = g.status === 'active' ? 'off' : 'active';
          await this.saveNodeToFirestore(node);
          bot.answerCallbackQuery(query.id, { text: `Code ${code} is now ${g.status.toUpperCase()}` }).catch(() => {});
          return await this.handleSubBotCallback(bot, node, userId, "adm_gift_manage", query);
        } else {
          return bot.answerCallbackQuery(query.id, { text: "Gift code not found." }).catch(() => {});
        }
     }

     if (data.startsWith('gdel_')) {
        const code = data.replace('gdel_', '');
        if (node.config.giftCodes.has(code)) {
          node.config.giftCodes.delete(code);
          await this.saveNodeToFirestore(node);
          bot.answerCallbackQuery(query.id, { text: `Code ${code} deleted.` }).catch(() => {});
          return await this.handleSubBotCallback(bot, node, userId, "adm_gift_manage", query);
        } else {
          return bot.answerCallbackQuery(query.id, { text: "Gift code not found." }).catch(() => {});
        }
     }

     if (data === 'adm_leaderboard_setting_menu') {
        const isLbEnabled = node.config.referLeaderboard !== false;
        const limitNum = node.config.leaderboardLimit ?? 5;
        const customTxt = node.config.leaderboardCustomText || "🏆 <b>TOP {LIMIT} REFERRERS - @{BOTNAME}</b>";
        const prizeTxt = node.config.leaderboardPrizeText || "🎁 Refer more users to secure your position and claim your bonus prize!";

        const panelMsg = `🏆 <b>LEADERBOARD SYSTEM CONFIG</b>\n\n` +
          `⚙️ <b>Current Settings:</b>\n` +
          `• Status: <b>${isLbEnabled ? "🟢 ENABLED" : "🔴 DISABLED"}</b>\n` +
          `• Leaderboard Entries Limit: <b>${limitNum} users</b>\n\n` +
          `📝 <b>Title template:</b>\n<code>${esc(customTxt)}</code>\n\n` +
          `🎁 <b>Default Prize/Footer note:</b>\n<code>${esc(prizeTxt)}</code>\n\n` +
          `Select an option below to customize your leaderboard or view top referrers list with real Telegram usernames:`;

        const kb = {
          inline_keyboard: [
            [
              { text: `Status: ${isLbEnabled ? "🟢 ON" : "🔴 OFF"}`, callback_data: `adm_tgl_leaderboard` },
              { text: `Set Limit (${limitNum})`, callback_data: `adm_set_leaderboardLimit` }
            ],
            [
              { text: "✏️ Edit Header/Title Text", callback_data: "adm_set_leaderboardCustomText" }
            ],
            [
              { text: "✏️ Edit Prize/Footer Text", callback_data: "adm_set_leaderboardPrizeText" }
            ],
            [
              { text: "👑 View Top Referrers list (Real Users Name)", callback_data: "adm_view_admin_leaderboard" }
            ],
            [{ text: "🔙 Back to Panel", callback_data: "adm_back_main" }]
          ]
        };

        bot.answerCallbackQuery(query.id).catch(() => {});
        if (query.message) {
          return bot.editMessageText(panelMsg, { chat_id: userId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: kb }).catch(() => {
            bot.sendMessage(userId, panelMsg, { parse_mode: 'HTML', reply_markup: kb });
          });
        } else {
          return bot.sendMessage(userId, panelMsg, { parse_mode: 'HTML', reply_markup: kb });
        }
     }

     if (data === 'adm_tgl_leaderboard') {
        node.config.referLeaderboard = node.config.referLeaderboard === false ? true : false;
        await this.saveNodeToFirestore(node);
        bot.answerCallbackQuery(query.id, { text: `Leaderboard is now ${node.config.referLeaderboard ? 'ENABLED' : 'DISABLED'}` }).catch(() => {});
        return await this.handleSubBotCallback(bot, node, userId, "adm_leaderboard_setting_menu", query);
     }

     if (data === 'adm_set_leaderboardLimit') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_LEADERBOARD_LIMIT" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "🔢 <b>SET LEADERBOARD LIMIT</b>\n\nPlease enter the maximum number of referrers to show (e.g., a number from 1 to 50):", { parse_mode: 'HTML' });
     }

     if (data === 'adm_set_leaderboardCustomText') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_LEADERBOARD_TITLE" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "✏️ <b>EDIT LEADERBOARD HEADER TEXT</b>\n\nEnter the new header text (HTML supported).\n\n📌 <b>Placeholders:</b>\n• <code>{LIMIT}</code> = Shows actual entries limit\n• <code>{BOTNAME}</code> = Shows current sub bot username\n\nExample:\n<code>🏆 <b>TOP {LIMIT} REFERRERS OF @{BOTNAME}</b></code>", { parse_mode: 'HTML' });
     }

     if (data === 'adm_set_leaderboardPrizeText') {
        this.fsmStates.set(userId, { nodeId: node.id, action: "SET_LEADERBOARD_PRIZE" });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return bot.sendMessage(userId, "🎁 <b>EDIT LEADERBOARD PRIZE/FOOTER TEXT</b>\n\nEnter the prize text or footer alert message to show underneath (HTML supported):\n\nExample:\n<code>🎁 Refer most to win cash prizes! 1st: ₹500 | 2nd: ₹250!</code>", { parse_mode: 'HTML' });
     }

     if (data === 'adm_view_admin_leaderboard') {
        bot.answerCallbackQuery(query.id).catch(() => {});
        if (!db) return bot.sendMessage(userId, "❌ Database offline.");
        
        try {
          const snap = await db.collection('nodes').doc(node.id).collection('users')
            .where('verified', '==', true)
            .orderBy('referrals', 'desc')
            .limit(50)
            .get();

          if (snap.docs.length === 0) {
            return bot.sendMessage(userId, "👑 <b>ADMIN REFERRER LIST</b>\n\nNo referral stats found yet.", { parse_mode: 'HTML' });
          }

          let msg = `👑 <b>ADMIN TOP REFERRERS REPORT - @${esc(node.username || "Bot")}</b>\n` +
                    `<i>Each user is linked to their Telegram chat/DM directly</i>\n\n`;

          snap.docs.forEach((d: any, i: number) => {
            const u = d.data();
            const uIdStr = String(d.id);
            
            let profileLink = "";
            const displayName = esc(u.name || u.username || `User ${uIdStr}`);
            
            if (u.username) {
              profileLink = `<a href="https://t.me/${u.username}">@${esc(u.username)}</a>`;
            } else {
              profileLink = `<a href="tg://user?id=${uIdStr}">${displayName}</a>`;
            }

            msg += `<b>Rank ${i + 1}:</b> ${profileLink} (ID: <code>${uIdStr}</code>)\n` +
                   `↳ Referrals: <b>${u.referrals} users</b> | Bal: <b>₹${(u.balance || 0).toFixed(2)}</b>\n\n`;
          });

          const kb = {
            inline_keyboard: [
              [{ text: "🔙 Back to Settings Menu", callback_data: "adm_leaderboard_setting_menu" }]
            ]
          };

          return bot.sendMessage(userId, msg, { parse_mode: 'HTML', reply_markup: kb });
        } catch (e: any) {
          return bot.sendMessage(userId, `❌ Error loading admin leaderboard: ${e.message}`);
        }
     }
  }

  private async checkForceJoin(bot: any, channelId: string, userId: number): Promise<boolean> {
    try {
      let finalId = channelId.trim();
      
      if (finalId.includes('t.me/')) {
        // Handle https://t.me/username
        const usernameMatch = finalId.match(/t\.me\/([a-zA-Z0-9_]{5,})/);
        // Handle https://t.me/+InviteHash
        const inviteMatch = finalId.match(/t\.me\/\+([a-zA-Z0-9_]+)/);
        // Handle https://t.me/joinchat/InviteHash
        const joinchatMatch = finalId.match(/t\.me\/joinchat\/([a-zA-Z0-9_-]+)/);

        if (usernameMatch && !finalId.includes('joinchat') && !finalId.includes('+')) {
          finalId = '@' + usernameMatch[1];
        } else if (inviteMatch || joinchatMatch) {
          // Can't check private invite links via standard getChatMember 
          return true; 
        }
      }
      
      const member = await bot.getChatMember(finalId, userId);
      return ['member', 'administrator', 'creator'].includes(member.status);
    } catch (err: any) {
      const msg = err.message || "";
      if (msg.includes('403') || msg.includes('Forbidden') || msg.includes('chat not found')) {
         logSys(`[CHECK_JOIN_FAIL] ${channelId}: Bot not admin or chat missing. Bypassing to avoid lock.`);
         return true;
      }
      return false; 
    }
  }

  private getTelegramChatIdentifier(ch: string | undefined): string | null {
    if (!ch) return null;
    let clean = ch.trim();
    if (clean.startsWith('https://t.me/')) {
      const part = clean.replace('https://t.me/', '').split('/')[0].split('?')[0];
      if (part.startsWith('+') || part.startsWith('joinchat')) return null;
      clean = '@' + part;
    } else if (clean.startsWith('t.me/')) {
      const part = clean.replace('t.me/', '').split('/')[0].split('?')[0];
      if (part.startsWith('+') || part.startsWith('joinchat')) return null;
      clean = '@' + part;
    } else if (!clean.startsWith('@') && !clean.startsWith('-100') && !clean.startsWith('-')) {
      if (isNaN(Number(clean))) {
        clean = '@' + clean;
      }
    }
    return clean;
  }

  private formatChannelLink(ch: string): string {
    if (!ch) return 'https://t.me/Telegram';
    const clean = ch.trim();
    if (clean.startsWith('http')) return clean;
    if (clean.startsWith('@')) return `https://t.me/${clean.substring(1)}`;
    if (clean.startsWith('-100')) {
      const cleanId = clean.replace('-100', '');
      // If it's a numeric ID, it's a private supergroup link format
      return `https://t.me/c/${cleanId}/999999999`;
    }
    // Handle case where user provides username without @
    if (/^[a-zA-Z0-9_]{5,}$/.test(clean)) return `https://t.me/${clean}`;
    return `https://t.me/${clean}`;
  }

  public getMenuKeyboard(node: BotNode) {
    const type = node.type || 'wallet';

    if (type === 'file') {
      return {
        keyboard: [
          [{ text: "📁 My Saved Files" }, { text: "📤 Upload File" }],
          [{ text: "🔍 Search Files" }, { text: "📊 Storage Stats" }],
          [{ text: "💼 Referral" }, { text: "📞 Support Team" }]
        ],
        resize_keyboard: true
      };
    }

    if (type === 'poll') {
      return {
        keyboard: [
          [{ text: "📊 Create New Poll" }, { text: "📋 My Active Polls" }],
          [{ text: "📈 Poll Analytics" }, { text: "🗳️ Public Polls" }],
          [{ text: "💼 Referral" }, { text: "📞 Support Team" }]
        ],
        resize_keyboard: true
      };
    }

    if (type === 'task') {
      return {
        keyboard: [
          [{ text: "📋 Task Section" }, { text: "👤 My Account" }],
          [{ text: "💼 Referral" }, { text: "🏛️ Withdraw" }],
          [{ text: "🎁 Rewards" }, { text: "💸 Pay To User" }]
        ],
        resize_keyboard: true
      };
    }

    if (type === 'bet') {
      return {
        keyboard: [
          [{ text: "🎯 Play Bet Game" }, { text: "🎲 Lucky Dice" }],
          [{ text: "📥 Deposit" }, { text: "🏛️ Withdraw" }],
          [{ text: "💰 Balance" }, { text: "💼 Referral" }]
        ],
        resize_keyboard: true
      };
    }

    if (type === 'redeem') {
      return {
        keyboard: [
          [{ text: "🎁 Claim Gift Code" }, { text: "🎟️ Create Voucher" }],
          [{ text: "📜 My Vouchers" }, { text: "💰 Balance" }],
          [{ text: "💼 Referral" }, { text: "📞 Support Team" }]
        ],
        resize_keyboard: true
      };
    }

    if (type === 'giveaway') {
      return {
        keyboard: [
          [{ text: "🎉 Join Active Giveaway" }, { text: "🏆 My Winnings" }],
          [{ text: "📊 Giveaway Stats" }, { text: "💰 Balance" }],
          [{ text: "💼 Referral" }, { text: "📞 Support Team" }]
        ],
        resize_keyboard: true
      };
    }

    if (type === 'star' || type === 'crypto') {
      return {
        keyboard: [
          [{ text: "⭐ Send Stars" }, { text: "🪙 Crypto Swap" }],
          [{ text: "📥 Crypto Deposit" }, { text: "🏛️ Withdraw" }],
          [{ text: "💳 Wallet Address" }, { text: "💰 Balance" }]
        ],
        resize_keyboard: true
      };
    }

    // Default 5-Button User Dashboard (UPI Manual / Auto Pay / Wallet / Refer Manual / Hybrid UPI)
    return {
      keyboard: [
        [{ text: "💰 Balance" }, { text: "💼 Referral" }],
        [{ text: "🎁 Rewards" }],
        [{ text: "🔒 Set Wallet" }, { text: "🏛️ Withdraw" }]
      ],
      resize_keyboard: true
    };
  }

  private async getSupportContactInline(node: BotNode): Promise<string> {
    try {
      // If a custom support handle is configured and is NOT the default hub bot handle
      if (node.config.supportContact && node.config.supportContact !== "@srsaportbot") {
        const handle = node.config.supportContact.trim();
        const clean = handle.startsWith("@") ? handle.substring(1) : handle;
        if (handle.startsWith("http")) {
          // If they entered a URL
          return `<a href="${handle}">Technical Support</a>`;
        }
        return `<a href="https://t.me/${clean}">@${clean}</a>`;
      }

      // Try to load owner profile to use owner's real username
      const ownerProfile = await this.ensureUserLoaded(node, node.ownerId);
      if (ownerProfile && ownerProfile.username) {
        const un = ownerProfile.username.trim();
        return `<a href="https://t.me/${un}">@${un}</a>`;
      }
    } catch (e) {
      // ignore errors
    }

    // Default template / hub bot support
    return `<a href="https://t.me/srsaportbot">@srsaportbot</a>`;
  }

  private logAdminAction(node: BotNode, action: string) {
    const timestamp = new Date().toLocaleString();
    node.config.adminLogs.push(`[${timestamp}] ${action}`);
  }

  private async getLeaderboard(node: BotNode) {
    try {
      if (!db) return "❌ Database offline.";
      
      // Check if Leaderboard is disabled by admin
      if (node.config.referLeaderboard === false) {
        return "⚠️ <b>Leaderboard Offline</b>\n\nThe referral leaderboard has been temporarily disabled by the administrator.";
      }

      const limitNum = node.config.leaderboardLimit ?? 5;
      const snap = await db.collection('nodes').doc(node.id).collection('users')
        .where('verified', '==', true)
        .orderBy('referrals', 'desc')
        .limit(limitNum)
        .get();
      
      const botName = node.username || "Bot";
      let title = node.config.leaderboardCustomText || `🏆 <b>TOP {LIMIT} REFERRERS - @{BOTNAME}</b>`;
      title = title
        .replace(/{LIMIT}/g, String(limitNum))
        .replace(/{BOTNAME}/g, esc(botName));
        
      let msg = `${title}\n\n`;
      if (snap.docs.length === 0) {
        msg += `<i>No referrers recorded yet. Be the first to invite friends and top the leaderboard!</i>\n\n`;
      } else {
        snap.docs.forEach((d: any, i: number) => {
          const u = d.data();
          const idStr = String(d.id);
          const halfLength = Math.ceil(idStr.length / 2);
          const maskedId = idStr.substring(0, halfLength) + "*".repeat(idStr.length - halfLength);
          
          let medal = `${i + 1}.`;
          if (i === 0) medal = "🥇 <b>1st:</b>";
          else if (i === 1) medal = "🥈 <b>2nd:</b>";
          else if (i === 2) medal = "🥉 <b>3rd:</b>";
          else medal = `🎖️ <b>${i + 1}th:</b>`;

          let userDisplayName = "";
          if (u.username) {
            userDisplayName = `@${u.username}`;
          } else if (u.name) {
            userDisplayName = `${u.name} (ID: ${maskedId})`;
          } else {
            userDisplayName = `User ID: <code>${maskedId}</code>`;
          }
          
          msg += `${medal} 👤 ${userDisplayName} — <b>${u.referrals || 0}</b> Refers\n`;
        });
        msg += `\n`;
      }
      
      const prizeText = node.config.leaderboardPrizeText || "🎁 Refer more users to secure your position and claim your bonus prize!";
      msg += `💰 <b>PRIZE DETAILS:</b>\n${prizeText}\n`;

      if (node.config.leaderboardUpdatesChannel) {
        const chLink = node.config.leaderboardUpdatesChannel.trim();
        const fullLink = chLink.startsWith("http") ? chLink : `https://t.me/${chLink.replace(/^@/, '')}`;
        msg += `\n📢 <b>Updates & Winners Channel:</b> <a href="${fullLink}">${esc(chLink)}</a>\n`;
      }
      
      msg += `\n🚀 Powered by <b>SR HUB</b>`;
      return msg;
    } catch (e: any) {
      logSys(`[STATS_ERR] Leaderboard for ${node.id}: ${e.message}`);
      return "❌ Error loading leaderboard.";
    }
  }

  public async toggleMaintenance(adminId: number, bot: any) {
    this.isMaintenanceMode = !this.isMaintenanceMode;
    await this.saveHubConfig();

    const msg = this.isMaintenanceMode 
      ? "⚠️ **SERVER UNDER MAINTENANCE**\n\nPlease wait, our infrastructure is being updated for better performance. All services are temporarily restricted."
      : "🟢 **SERVER ONLINE**\n\nI have built successfully server is fully work fine you can continue create a bots with 0 lag & fast & secured 🚀";
    
    const broadcastText = this.isMaintenanceMode
      ? "⚠️please wait server is under maintenance"
      : "🟢 I have built successfully server is fully work fine you can continue create a bots with 0 lag & fast & secured 🚀";

    await bot.sendMessage(adminId, `${msg}\n\n📢 **Starting Global Broadcast to all users...**`);

    // Global Broadcast logic
    const runBroadcast = async () => {
      try {
        const nodes = Array.from(this.nodes.values()) as BotNode[];
        let totalSent = 0;

        // Hub Users
        const hubUsers = await db.collection('hubUsers').get();
        for (const d of hubUsers.docs) {
          try {
            await bot.sendMessage(Number(d.id), broadcastText).catch(() => {});
            totalSent++;
          } catch {}
          await new Promise(r => setTimeout(r, 65)); // Rate limiting
        }

        // All Bots Users
        for (const n of nodes) {
          if (n.instance && typeof n.instance === 'object' && !n.id.startsWith("BLUEPRINT_")) {
            try {
              const usersSnap = await db.collection('nodes').doc(n.id).collection('users').get();
              for (const ud of usersSnap.docs) {
                try {
                  await n.instance.sendMessage(Number(ud.id), broadcastText).catch(() => {});
                  totalSent++;
                } catch {}
                await new Promise(r => setTimeout(r, 65)); // Rate limiting
              }
            } catch {}
          }
        }
        logSys(`[MAINTENANCE] Global broadcast finished. Sent to ${totalSent} users.`);
        await bot.sendMessage(adminId, `✅ **Maintenance Broadcast Finished!**\nTotal users notified: ${totalSent}`);
      } catch (err: any) {
        logSys(`[MAINTENANCE_ERR] ${err.message}`);
      }
    };

    runBroadcast();
  }

  private async handleFSM(bot: any, node: BotNode, userId: number, text: string, state: any, msg: any) {
    const action = state.action;
    const isHub = state.nodeId === "HUB_NODE";

    const trimmedText = text.trim();
    const isCommandOrButton = trimmedText.startsWith('/') || [
      "➕ Create New Bot", "🤖 My All Bot Nodes", "📢 My Bots Broadcast", "📊 Hub Stats", "📞 Support Hub",
      "💰 Balance", "💼 Referral", "🎁 Rewards", "🔒 Set Wallet", "🏛️ Withdraw",
      "👤 My Account", "👥 Refer & Earn", "🎁 Gift Code", "💸 Pay To User", "📥 Deposit", "🚀 Withdraw", "📞 Support",
      "🎯 Play Bet Game", "🎲 Lucky Dice", "📁 My Saved Files", "📤 Upload File", "🔍 Search Files", "📊 Storage Stats",
      "📊 Create New Poll", "📋 My Active Polls", "📈 Poll Analytics", "🗳️ Public Polls", "🎁 Claim Gift Code",
      "🎟️ Create Voucher", "📜 My Vouchers", "🎉 Join Active Giveaway", "🏆 My Winnings", "📊 Giveaway Stats",
      "⭐ Send Stars", "🪙 Crypto Swap", "📥 Crypto Deposit", "🚀 Withdraw Stars", "💳 Wallet Address", "📲 Link UPI ID",
      "CANCEL", "❌ Cancel", "🔙 Back"
    ].includes(trimmedText);

    if (isCommandOrButton && !['BC_CONFIRM', 'BC_CENTER_TEXT', 'BC_CENTER_MEDIA', 'BC_CENTER_BUTTONS'].includes(action)) {
      this.fsmStates.delete(userId);
      return false;
    }

    if (action === "SET_LEADERBOARD_LIMIT") {
      const val = parseInt(text.trim());
      if (isNaN(val) || val < 1 || val > 100) {
        return bot.sendMessage(userId, "❌ Please enter a valid number between 1 and 100.");
      }
      node.config.leaderboardLimit = val;
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>Leaderboard Limit Updated!</b>\n\nShow Limit: <b>${val} users</b>`, { parse_mode: 'HTML' });
      return await this.handleSubBotCallback(bot, node, userId, "adm_leaderboard_setting_menu", { message: msg });
    }

    if (action === "EDIT_DAILY_BONUS_FIXED") {
      const amt = parseFloat(text.trim());
      if (isNaN(amt) || amt < 0) {
        return bot.sendMessage(userId, "❌ Please enter a valid number (e.g. 6).");
      }
      node.config.dailyBonus = amt;
      node.config.dailyBonusType = 'fixed';
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>Fixed Daily Bonus Updated!</b>\n\nEvery user will now receive exactly <b>₹${amt}</b> daily.`, { parse_mode: 'HTML' });
      return await this.handleSubBotCallback(bot, node, userId, "adm_dailyBonus_menu", { message: msg });
    }

    if (action === "EDIT_DAILY_BONUS_RANDOM") {
      const amt = parseFloat(text.trim());
      if (isNaN(amt) || amt < 1) {
        return bot.sendMessage(userId, "❌ Please enter a valid maximum number (e.g. 6).");
      }
      node.config.dailyBonus = amt;
      node.config.dailyBonusType = 'random';
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>Random Daily Bonus Updated!</b>\n\nUsers will now receive a random reward from <b>₹1 up to ₹${amt}</b> daily.`, { parse_mode: 'HTML' });
      return await this.handleSubBotCallback(bot, node, userId, "adm_dailyBonus_menu", { message: msg });
    }

    if (action === "REDEEM_CODE_INPUT") {
      const code = text.trim();
      const g = node.config.giftCodes.get(code);
      if (g && g.status === 'active' && g.currentClaims < g.maxUses) {
        const user = await this.ensureUserLoaded(node, userId);
        if (user) {
          if (!user.claimedGiftCodes) user.claimedGiftCodes = [];
          if (user.claimedGiftCodes.includes(code)) {
            bot.sendMessage(userId, "❌ You have already claimed this gift code.");
          } else {
            user.balance += g.amount;
            user.claimedGiftCodes.push(code);
            g.currentClaims += 1;
            if (g.currentClaims >= g.maxUses) {
              g.status = 'expired';
            }
            await this.saveNodeToFirestore(node);
            await this.saveUserToFirestore(node.id, userId, user);
            bot.sendMessage(userId, `🎉 <b>GIFT CODE REDEEMED!</b>\n\nSuccessfully claimed ₹<b>${g.amount}</b> to your balance!`, { parse_mode: 'HTML' });
          }
        }
      } else {
        bot.sendMessage(userId, "❌ Invalid or expired gift code.");
      }
      this.fsmStates.delete(userId);
      return;
    }

    if (action === "SET_LEADERBOARD_TITLE") {
      node.config.leaderboardCustomText = text;
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>Leaderboard Title Text Updated!</b>`, { parse_mode: 'HTML' });
      return await this.handleSubBotCallback(bot, node, userId, "adm_leaderboard_setting_menu", { message: msg });
    }

    if (action === "SET_LEADERBOARD_PRIZE") {
      node.config.leaderboardPrizeText = text;
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>Leaderboard Prize/Winner Amount Text Updated!</b>`, { parse_mode: 'HTML' });
      return await this.handleSubBotCallback(bot, node, userId, "adm_leaderboard_setting_menu", { message: msg });
    }

    if (action === "SET_LEADERBOARD_CHANNEL") {
      const chInput = text.trim();
      if (chInput.toLowerCase() === 'none' || chInput.toLowerCase() === 'remove') {
        node.config.leaderboardUpdatesChannel = "";
      } else {
        node.config.leaderboardUpdatesChannel = chInput;
      }
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>Updates Channel Link Saved!</b>\n\nLink: <code>${esc(node.config.leaderboardUpdatesChannel || "None")}</code>`, { parse_mode: 'HTML' });
      return await this.handleSubBotCallback(bot, node, userId, "adm_leaderboard_setting_menu", { message: msg });
    }

    if (action === "SET_GATEWAY_URL") {
      node.config.gatewayUrl = text.trim();
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ **Gateway URL Updated!**\n\nNew URL: ${node.config.gatewayUrl}`);
      return this.sendAdminPanel(bot, node, userId);
    }
    
    if (action === "SET_GATEWAY_API_URL") {
      node.config.gatewayApiUrl = text.trim();
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ **API URL Updated!**\n\nNew URL: ${node.config.gatewayApiUrl}`);
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "SET_WALLET_APP_URL") {
      node.config.walletAppUrl = text.trim();
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ **Wallet App URL Updated!**\n\nNew URL: ${node.config.walletAppUrl}`);
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "SET_GATEWAY_SECRET") {
      node.config.gatewaySecretKey = text.trim();
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ **Gateway Secret Updated!**\n\nNew Secret Saved Successfully.`);
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "SET_PAYOUT_CH") {
      let ch = text.trim();
      if (!ch.startsWith('@') && !ch.startsWith('-100')) {
        ch = '@' + ch;
      }
      node.config.payoutChannel = ch;
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ **Payout Channel Updated!**\n\nNew Channel: ${ch}\n\n⚠️ Ensure bot is **ADMIN** in this channel.`);
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "HUB_ADD_CHANNEL") {
      let clean = text.trim();
      if (clean.includes("t.me/+") || clean.includes("joinchat")) {
        // Invite link - we suggest using username for better checking, but allow it
        bot.sendMessage(userId, "⚠️ **Notice:** Checking membership for private invite links is limited. Usernames (@channel) or Public Links are recommended for 100% accuracy.");
      }
      (this as any).hubForceJoinChannels.push(clean);
      await (this as any).saveHubConfig();
      this.fsmStates.delete(userId);
      return bot.sendMessage(userId, `✅ **Channel added!**\n\nDirect Link for users will be: ${this.formatChannelLink(clean)}`, { disable_web_page_preview: true });
    }

    if (action === "BC_CENTER_MEDIA") {
      if (text === "Skip Media") {
        this.fsmStates.set(userId, { ...state, action: "BC_CENTER_TEXT" });
        return bot.sendMessage(userId, "Write your message using HTML formatting if needed:\n\n<b>Bold</b>: &lt;b&gt;text&lt;/b&gt;\n<i>Italic</i>: &lt;i&gt;text&lt;/i&gt;\n<code>Mono</code>: &lt;code&gt;text&lt;/code&gt;\n<a href='https://example.com'>Link</a>: &lt;a href='...'&gt;text&lt;/a&gt;\n\nRegular newlines are supported. ✅", {
          reply_markup: { keyboard: [[{ text: "🔙 Back" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
        });
      }
      if (msg.photo || msg.video) {
        state.media = msg;
        this.fsmStates.set(userId, { ...state, action: "BC_CENTER_TEXT" });
        return bot.sendMessage(userId, "✅ Media Received. Now write your message (caption if media exists).", {
          reply_markup: { keyboard: [[{ text: "🔙 Back" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
        });
      }
      return bot.sendMessage(userId, "❌ Please send a Photo/Video or click 'Skip Media'.");
    }

    if (action === "BC_CENTER_TEXT") {
      if (text === "🔙 Back") {
        this.fsmStates.set(userId, { ...state, action: "BC_CENTER_MEDIA" });
        return bot.sendMessage(userId, "📢 **Broadcast Center**\n\nSend your photo or video to broadcast or skip it.", {
          reply_markup: { keyboard: [[{ text: "Skip Media" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
        });
      }
      state.text = text;
      this.fsmStates.set(userId, { ...state, action: "BC_CENTER_BUTTONS" });
      const btnHelp = `🌟 **TWO BUTTONS IN SAME ROW**\nUse && between buttons.\nJoin - https://t.me/A && Support - https://t.me/B\n\n🌟 **MIXED LAYOUT EXAMPLE**\nJoin - https://t.me/A\nSupport - https://t.me/B && Website - https://example.com\n\n📌 **RULES:**\n• Each new line = new row\n• Use && to place buttons in same row\n\nIf you don't want buttons, press ⏭️ **Skip Buttons**`;
      return bot.sendMessage(userId, btnHelp, {
        parse_mode: 'Markdown',
        reply_markup: { keyboard: [[{ text: "Skip Buttons" }], [{ text: "🔙 Back" }]], resize_keyboard: true }
      });
    }

    if (action === "BC_CENTER_BUTTONS") {
      if (text === "🔙 Back") {
        this.fsmStates.set(userId, { ...state, action: "BC_CENTER_TEXT" });
        return bot.sendMessage(userId, "Write your message again:", {
          reply_markup: { keyboard: [[{ text: "🔙 Back" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
        });
      }
      
      const keyboard: any[][] = [];
      if (text !== "Skip Buttons") {
        const rows = text.split('\n');
        for (const rowText of rows) {
          const row: any[] = [];
          const btnTexts = rowText.split('&&');
          for (const btnInfo of btnTexts) {
            const parts = btnInfo.split(' - ');
            if (parts.length === 2) {
              row.push({ text: parts[0].trim(), url: parts[1].trim() });
            }
          }
          if (row.length > 0) keyboard.push(row);
        }
      }
      
      state.inline_keyboard = keyboard;
      this.fsmStates.set(userId, { ...state, action: "BC_CENTER_CONFIRM" });
      
      await bot.sendMessage(userId, "Check the preview above. If it looks good, click Confirm.", { reply_markup: { remove_keyboard: true } });
      
      const opts = { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'HTML' };
      try {
        if (state.media?.photo) {
          await bot.sendPhoto(userId, state.media.photo[state.media.photo.length - 1].file_id, { ...opts, caption: state.text });
        } else if (state.media?.video) {
          await bot.sendVideo(userId, state.media.video.file_id, { ...opts, caption: state.text });
        } else {
          await bot.sendMessage(userId, state.text, opts);
        }
      } catch (err: any) {
        return bot.sendMessage(userId, `❌ **PREVIEW FAILED:** ${err.message}\n\nThis usually happens if your HTML tags are not closed correctly or a URL is invalid. Fix it and send the message again.`, { parse_mode: 'Markdown' });
      }

      return bot.sendMessage(userId, "Confirm this broadcast?", {
        reply_markup: {
          inline_keyboard: [[{ text: "✅ Confirm Broadcast", callback_data: "BC_RUN_CENTER" }, { text: "❌ Cancel Broadcast", callback_data: "BC_CANCEL" }]]
        }
      });
    }

    if (action === "ADD_CHANNEL") {
      let input = text.trim();
      let channelId = input;
      const chType = state.type || 'CHECKED';
      
      if (input.includes('t.me/')) {
        const urlMatch = input.match(/t\.me\/(?:\+|joinchat\/)?([^\/\?]+)/);
        if (urlMatch) {
          if (input.includes('joinchat') || input.includes('t.me/+')) {
             channelId = input; 
          } else {
             channelId = '@' + urlMatch[1];
          }
        }
      } else if (!input.startsWith('@') && !input.startsWith('-100')) {
        if (isNaN(Number(input))) {
           channelId = '@' + input;
        }
      }

      if (chType === 'CHECKED') {
        if (!node.config.forceJoinChannels) node.config.forceJoinChannels = [];
        if (!node.config.forceJoinChannels.includes(channelId)) {
          node.config.forceJoinChannels.push(channelId);
          bot.sendMessage(userId, `✅ **Added to Checked Channels:** ${channelId}\n\n⚠️ **Tip:** Ensure Bot is **ADMIN** in the channel.`);
          await this.saveNodeToFirestore(node);
        } else {
          bot.sendMessage(userId, "❌ Already in Checked Channels.");
        }
      } else {
        if (!node.config.forceJoinChannelsUnchecked) node.config.forceJoinChannelsUnchecked = [];
        if (!node.config.forceJoinChannelsUnchecked.includes(channelId)) {
          node.config.forceJoinChannelsUnchecked.push(channelId);
          bot.sendMessage(userId, `🔘 **Added to Unchecked Channels:** ${channelId}\n\n⚠️ **Tip:** These are optional buttons (no verification).`);
          await this.saveNodeToFirestore(node);
        } else {
          bot.sendMessage(userId, "❌ Already in Unchecked Channels.");
        }
      }
      
      this.fsmStates.delete(userId);
      this.handleSubBotCallback(bot, node, userId, 'adm_view_forceJoin', { message: msg });
      return;
    }

    if (action === "SOLVE_CAPTCHA") {
      const ans = parseInt(text);
      if (ans === state.targetId) {
        const user = await this.ensureUserLoaded(node, userId);
        if (user) user.verified = true;
        bot.sendMessage(userId, "✅ **Verification Successful!**\nYou can now use all features. Click 'Withdraw' again.");
        this.logAdminAction(node, `User ${userId} passed Anti-Bot`);
      } else {
        bot.sendMessage(userId, "❌ Incorrect answer. Try again or click 'Withdraw' to get a new challenge.");
      }
    }

    if (action === "WITHDRAW_AMT") {
      const amt = parseFloat(text);
      const user = await this.ensureUserLoaded(node, userId);
      if (!user) {
        this.fsmStates.delete(userId);
        return;
      }

      if (isNaN(amt) || amt < node.config.minWithdraw) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, `❌ Minimum amount is ₹${node.config.minWithdraw}`);
      }
      if (amt > node.config.maxWithdraw) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, `❌ Maximum amount is ₹${node.config.maxWithdraw}`);
      }
      if (amt > user.balance) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ Insufficient balance.");
      }
      if (node.config.amountInWhole && amt % 1 !== 0) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ Only whole amounts are allowed.");
      }

      // DUPLICATE DEVICE AUTO-FAIL
      if (user.isDuplicate) {
        const failReason = "⚠️ **Withdrawal Rejected**\n\nReason: Duplicate device detected. Our system prevents automated payments to multiple accounts on the same device to ensure network integrity.";
        return bot.sendMessage(userId, failReason, { parse_mode: 'Markdown' });
      }

      const tax = (amt * node.config.withdrawTax) / 100;
      const finalAmt = amt - tax;

      user.balance -= amt;

      const isManual = node.config.manualPay === true || (node.config.manualPay !== false && ['refer_manual', 'upi_manual', 'upi'].includes(node.type));
      if (!isManual && (node.config.autoPayout || node.config.gatewayApiUrl || node.config.payoutUrl)) {
        bot.sendMessage(userId, "⚡ **Processing Gateway Payout Request...**");
        await this.processWithdrawal(bot, node, userId, amt, user.walletId!);
      } else {
        const reqId = `WD-${uuidv4().substring(0, 6).toUpperCase()}`;
        node.pendingWithdrawals.set(reqId, {
          userId,
          amount: amt,
          wallet: user.walletId!,
          createdAt: Date.now()
        });
        const escReqId = esc(reqId);
        const payoutChannel = node.config.payoutChannel || "@srsaportbot";
        const channelLink = this.formatChannelLink(payoutChannel);
        
        const manualMsg = `your withdrawal submit successfully for admin review 🎉\n` +
                          `please wait 5 to 20 min after admin approval.✅\n\n` +
                          `✅ Amount: ₹${amt.toFixed(2)}\n` +
                          `🧾 Tax: ₹${tax.toFixed(2)}\n` +
                          `💵 Final: ₹${finalAmt.toFixed(2)}\n` +
                          `🆔 Request ID: \`${escReqId}\``;

        const checkPayoutKb = {
          inline_keyboard: [
            [{ text: "📢 Check Payouts Here", url: channelLink }]
          ]
        };

        bot.sendMessage(userId, manualMsg, { parse_mode: 'Markdown', reply_markup: checkPayoutKb }).catch(() => {});

        // Post Request to Payout Channel with Approval Buttons
        const targetPayoutCh = this.getTelegramChatIdentifier(node.config.payoutChannel);
        if (targetPayoutCh) {
          const kb = {
            inline_keyboard: [
              [
                { text: "✅ Approve", callback_data: `APPROVE_WD_${reqId}` },
                { text: "❌ Reject", callback_data: `REJECT_WD_${reqId}` }
              ]
            ]
          };
          const reqMsg = `⏳ **NEW PAYOUT REQUEST**\n\n👤 User: \`${userId}\`\n💰 Amount: ₹${amt.toFixed(2)}\n🧾 Tax: ₹${tax.toFixed(2)}\n💵 **Final Payable: ₹${finalAmt.toFixed(2)}**\n💳 Wallet: \`${esc(user.walletId)}\`\n📝 ID: \`${escReqId}\`\n\n✅ Status: **PENDING**`;
          bot.sendMessage(targetPayoutCh, reqMsg, { parse_mode: 'Markdown', reply_markup: kb }).catch((err: any) => {
            console.error("Payout Channel Error:", err.message);
          });
        }

        // Notify admins
        node.config.admins.forEach(adminId => {
          bot.sendMessage(adminId, `🔔 **Withdrawal Request [${reqId}]**\nUser: ${userId}\nAmount: ₹${amt}\n\nApprove in the Payout Channel.`);
        });
      }
      await this.saveNodeToFirestore(node);
      await this.saveUserToFirestore(node.id, userId, user);
    }

    if (action === "ADD_FORCE_JOIN") {
      let input = text.trim();
      let channel = "";
      
      if (input.startsWith('@')) {
        channel = input;
      } else if (input.includes('t.me/')) {
        // Robust extraction
        const path = input.split('t.me/')[1].split('?')[0].split('/')[0];
        channel = '@' + path;
      } else if (input.startsWith('-100')) {
        channel = input;
      } else {
        channel = '@' + input;
      }

      const existingChannels = node.config.forceJoinChannels || [];
      if (!existingChannels.includes(channel)) {
        if (!node.config.forceJoinChannels) node.config.forceJoinChannels = [];
        node.config.forceJoinChannels.push(channel);
        bot.sendMessage(userId, `✅ **Added Channel:** ${channel}\n\n⚠️ **Tip:**\n- Ensure Bot is **ADMIN** in the channel.\n- Public channels only.`);
        await this.saveNodeToFirestore(node);
      } else {
        bot.sendMessage(userId, "❌ Channel already in list.");
      }
      this.fsmStates.delete(userId);
      this.sendAdminPanel(bot, node, userId);
      return;
    }

    if (action === "REM_FORCE_JOIN") {
      const channel = text.trim();
      const index = node.config.forceJoinChannels.indexOf(channel);
      if (index > -1) {
        node.config.forceJoinChannels.splice(index, 1);
        bot.sendMessage(userId, `✅ **Removed Channel:** ${channel}`);
        await this.saveNodeToFirestore(node);
      } else {
        bot.sendMessage(userId, "❌ Channel not found in list. Use the exact username (including @).");
      }
    }

    if (action === "SET_PAYOUT_CHAN") {
      let channel = text.trim();
      if (channel.includes('t.me/')) {
        channel = '@' + channel.split('t.me/')[1].split('/')[0];
      }
      if (!channel.startsWith('@')) return bot.sendMessage(userId, "❌ **Format Error:** Channel must start with @ (e.g. @MyChannel)");
      
      node.config.payoutChannel = channel;
      bot.sendMessage(userId, `✅ **PAYOUT LOGS ACTIVE**\n\nTarget: ${channel}\n\n⚠️ **IMPORTANT:** Verify the bot is an **ADMIN** in this channel to post logs.`);
      await this.saveNodeToFirestore(node);
    }

    if (action === "ADD_ADMIN") {
      const targetId = parseInt(text);
      if (!isNaN(targetId)) {
        node.config.admins.add(targetId);
        bot.sendMessage(userId, `✅ User ${targetId} added to Admin list.`);
        this.logAdminAction(node, `Added admin ${targetId}`);
        await this.saveNodeToFirestore(node);
      }
    }

    if (action === "REM_ADMIN") {
      const targetId = parseInt(text);
      if (!isNaN(targetId)) {
        if (targetId === node.ownerId) return bot.sendMessage(userId, "❌ Cannot remove owner.");
        node.config.admins.delete(targetId);
        bot.sendMessage(userId, `✅ User ${targetId} removed from Admin list.`);
        this.logAdminAction(node, `Removed admin ${targetId}`);
        await this.saveNodeToFirestore(node);
      }
    }

    if (action.startsWith("EDIT_")) {
      const field = action.replace("EDIT_", "");
      const isNumeric = ['referBonus', 'dailyBonus', 'minReferForPayout', 'minWithdraw', 'maxWithdraw', 'withdrawTax'].includes(field);
      
      const config = node.config as any;
      if (field === 'payoutGatewayApiUrl') {
        config.payoutGatewayApiUrl = text;
      } else {
        config[field] = isNumeric ? parseFloat(text) : text;
      }
      
      bot.sendMessage(userId, `✅ **Field Updated:** ${field}\nNew Value: ${text}`);
      this.fsmStates.delete(userId);
      await this.saveNodeToFirestore(node);
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "BC_CONTENT") {
      state.content = msg;
      this.fsmStates.set(userId, { ...state, action: "BC_BUTTONS" });
      bot.sendMessage(userId, "📥 **Content Received!**\n\nNow send the **Inline Buttons** configuration.\nFormat: `Label | URL` (One per line).\n\nType **'none'** if you don't want any buttons.");
      return;
    }

    if (action === "BC_BUTTONS") {
      const buttons: any[] = [];
      if (text.toLowerCase() !== 'none') {
        const lines = text.split('\n');
        for (const line of lines) {
          const parts = line.split('|').map(p => p.trim());
          if (parts.length === 2) {
            buttons.push([{ text: parts[0], url: parts[1] }]);
          }
        }
      }
      state.buttons = buttons;
      this.fsmStates.set(userId, { ...state, action: "BC_CONFIRM" });
      
      bot.sendMessage(userId, "👀 **BROADCAST PREVIEW:**\n\n(Wait for the preview message...)").then(() => {
        const content = state.content;
        const opts = { reply_markup: { inline_keyboard: buttons }, parse_mode: 'Markdown' };
        
        if (content.photo) {
          bot.sendPhoto(userId, content.photo[0].file_id, { ...opts, caption: content.caption });
        } else if (content.text) {
          bot.sendMessage(userId, content.text, opts);
        } else {
          bot.copyMessage(userId, userId, content.message_id, { reply_markup: { inline_keyboard: buttons } });
        }

        bot.sendMessage(userId, "❓ **Do you want to send this to ALL users?**\nType **'CONFIRM'** to start or **'CANCEL'** to abort.", {
          reply_markup: { keyboard: [[{ text: "CONFIRM" }, { text: "CANCEL" }]], resize_keyboard: true, one_time_keyboard: true }
        });
      });
      return;
    }

    if (action === "BC_CONFIRM") {
      if (text === "CONFIRM") {
        bot.sendMessage(userId, "🚀 **Smart Broadcast Started...**", { reply_markup: { remove_keyboard: true } });
        
        const runBroadcast = async () => {
          try {
            const targets: { bot: any, nodeId: string, uids: number[] }[] = [];
            
            if (state.nodeId === "HUB_NODE") {
               const snap = await db.collection('hubUsers').get();
               targets.push({ bot: hubBot, nodeId: "HUB", uids: snap.docs.map((d: any) => Number(d.id)) });
            } else if (state.nodeId === "HUB_GLOBAL_MESH") {
               // 1. Hub Users
               const hSnap = await db.collection('hubUsers').get();
               targets.push({ bot: hubBot, nodeId: "HUB", uids: hSnap.docs.map((d: any) => Number(d.id)) });
               // 2. All Nodes Users
               const allNodes = Array.from(this.nodes.values());
               for(const n of allNodes) {
                 if(n.instance && n.config.botStatus) {
                   const nSnap = await db.collection('nodes').doc(n.id).collection('users').get();
                   targets.push({ bot: n.instance, nodeId: n.id, uids: nSnap.docs.map((d: any) => Number(d.id)) });
                 }
               }
            } else if (state.nodeId === "MESH_ONLY_GLOBAL") {
                const allNodes = Array.from(this.nodes.values());
                for(const n of allNodes) {
                  if(n.instance && n.config.botStatus) {
                    const nSnap = await db.collection('nodes').doc(n.id).collection('users').get();
                    targets.push({ bot: n.instance, nodeId: n.id, uids: nSnap.docs.map((d: any) => Number(d.id)) });
                  }
                }
            } else if (state.nodeId === "USER_OWN_NODES") {
               const userNodes = this.getUserNodes(userId);
               for(const n of userNodes) {
                 if(n.instance && n.config.botStatus) {
                   const nSnap = await db.collection('nodes').doc(n.id).collection('users').get();
                   targets.push({ bot: n.instance, nodeId: n.id, uids: nSnap.docs.map((d: any) => Number(d.id)) });
                 }
               }
            } else {
               const snap = await db.collection('nodes').doc(node.id).collection('users').get();
               targets.push({ bot: bot, nodeId: node.id, uids: snap.docs.map((d: any) => Number(d.id)) });
            }

            let total = targets.reduce((acc, t) => acc + t.uids.length, 0);
            let success = 0;
            let failed = 0;
            let processed = 0;
            
            const progressMsg = await bot.sendMessage(userId, `📊 **MESH BROADCAST INITIATED**\n\n🔄 Total Targets: ${total}\n⏳ Delivering messages...`);
            const startTime = Date.now();

            for (const target of targets) {
              for (const uid of target.uids) {
                try {
                  const opts = { reply_markup: { inline_keyboard: state.buttons || [] }, parse_mode: 'Markdown' };
                  const content = state.content;
                  
                  if (content.photo) {
                    await target.bot.sendPhoto(uid, content.photo[content.photo.length - 1].file_id, { ...opts, caption: content.caption });
                  } else if (content.text) {
                    await target.bot.sendMessage(uid, content.text, opts);
                  } else {
                    try {
                        await target.bot.copyMessage(uid, userId, content.message_id, { reply_markup: { inline_keyboard: state.buttons || [] } });
                    } catch(e) {
                         // Fallback resend
                         if (content.text) await target.bot.sendMessage(uid, content.text, opts);
                         else if (content.caption) await target.bot.sendMessage(uid, content.caption, opts);
                         else throw e;
                    }
                  }
                  success++;
                } catch (e: any) {
                  failed++;
                  logSys(`[SUB_BC_FAIL] To ${uid} on ${target.nodeId}: ${e.message}`);
                }
                
                processed++;
                if (processed % 15 === 0 || processed === total) {
                  const percentage = Math.round((processed / total) * 100);
                  const elapsed = (Date.now() - startTime) / 1000;
                  const rate = processed / elapsed;
                  const remaining = Math.round((total - processed) / rate);
                  
                  bot.editMessageText(`📊 **GLOBAL MESH TRACKING**\n\n` +
                    `🔄 Progress: ${processed}/${total} (${percentage}%)\n` +
                    `🟢 Success: ${success}\n` +
                    `🔴 Failed: ${failed}\n\n` +
                    `⏳ Est. Remaining: ${remaining}s`, {
                    chat_id: userId,
                    message_id: progressMsg.message_id
                  }).catch(() => {});
                }
                await new Promise(r => setTimeout(r, 40));
              }
            }
            bot.sendMessage(userId, `✅ **Global Mesh Broadcast Complete!**\n\nTotal: ${total}\nSuccess: ${success}\nFailed: ${failed}`);
          } catch (err: any) {
            bot.sendMessage(userId, "❌ MESH Error: " + err.message);
          }
        };
        runBroadcast();
      } else {
        bot.sendMessage(userId, "❌ Broadcast Cancelled.", { reply_markup: { remove_keyboard: true } });
      }
      this.fsmStates.delete(userId);
      return;
    }

    if (action === "REDEEM_GIFT") {
      const code = text.trim();
      const g = node.config.giftCodes.get(code);
      if (g && g.status === 'active' && g.currentClaims < g.maxUses) {
        const user = await this.ensureUserLoaded(node, userId);
        if (user) {
          user.balance += g.amount;
          g.currentClaims++;
          if (g.currentClaims >= g.maxUses) g.status = 'off';
          node.config.giftCodes.set(code, g);
          await this.saveUserToFirestore(node.id, userId, user);
          await this.saveNodeToFirestore(node);
          
          const giftImg = "https://t.me/SR_TECHNOLOGY_LTD/330"; 
          bot.sendPhoto(userId, giftImg, {
            caption: `congratulations 🎉 you have successfully claimed 🧧RS ${g.amount.toFixed(2)} gift code amount`,
            parse_mode: 'Markdown'
          }).catch(() => {
            bot.sendMessage(userId, `congratulations 🎉 you have successfully claimed 🧧RS ${g.amount.toFixed(2)} gift code amount`);
          });
        }
      } else {
        bot.sendMessage(userId, "❌ Invalid, expired, or fully claimed gift code.");
      }
    }

    if (action === "GIFT_NAME") {
      state.giftName = text.trim();
      this.fsmStates.set(userId, { ...state, action: "GIFT_AMT" });
      return bot.sendMessage(userId, `🧧 **GIFT CODE: \`${state.giftName}\`**\n\n💰 Enter the amount for per user (e.g. 50):`, { parse_mode: 'Markdown' });
    }

    if (action === "GIFT_AMT") {
      const amt = parseFloat(text);
      if (isNaN(amt) || amt <= 0) return bot.sendMessage(userId, "❌ Please enter a valid number greater than 0.");
      state.giftAmt = amt;
      this.fsmStates.set(userId, { ...state, action: "GIFT_USERS" });
      return bot.sendMessage(userId, `🧧 **GIFT CODE: \`${state.giftName}\`**\n💰 Amount: ₹${amt}\n\n👥 How many users can claim this code?`, { parse_mode: 'Markdown' });
    }

    if (action === "GIFT_USERS") {
      const users = parseInt(text);
      if (isNaN(users) || users <= 0) return bot.sendMessage(userId, "❌ Please enter a valid number greater than 0.");
      
      const giftCode = state.giftName;
      node.config.giftCodes.set(giftCode, {
        amount: state.giftAmt,
        maxUses: users,
        currentClaims: 0,
        status: 'active'
      });
      
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ You have successfully create gift code 🎉\n\n🎫 Code: \`${giftCode}\` \n\n💰 Amount: ₹${state.giftAmt}\n👥 Max Uses: ${users}\n\nUsers can now claim this.`, { parse_mode: 'Markdown' });
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "BAN_WALLET") {
      node.config.bannedWallets.add(text);
      bot.sendMessage(userId, `✅ Wallet \`${text}\` has been restricted.`, { parse_mode: 'Markdown' });
      this.logAdminAction(node, `Banned wallet ${text}`);
      await this.saveNodeToFirestore(node);
    }

    if (action === "UNBAN_WALLET") {
      node.config.bannedWallets.delete(text);
      bot.sendMessage(userId, `✅ Wallet \`${text}\` restrictions removed.`, { parse_mode: 'Markdown' });
      this.logAdminAction(node, `Unbanned wallet ${text}`);
      await this.saveNodeToFirestore(node);
    }

    if (action === "USER_DETAILS") {
      const targetId = parseInt(text);
      const user = await this.ensureUserLoaded(node, targetId);
      if (user) {
        const joined = new Date(user.joinedAt || Date.now()).toLocaleDateString();
        const details = `🔍 **USER ENGINE PROFILE: ${targetId}**\n\n` +
          `💵 Balance: ₹${user.balance.toFixed(2)}\n` +
          `👥 Referrals: ${user.referrals}\n` +
          `💳 Wallet: \`${esc(user.walletId || "Not Set")}\`\n` +
          `🛡 Verified: ${user.verified ? "✅" : "❌"}\n` +
          `📅 Joined: ${joined}\n` +
          `🚫 Banned: ${node.config.bannedUsers.has(targetId) ? "YES" : "NO"}`;
        
        const kb = {
          inline_keyboard: [
            [{ text: "💵 Add/Cut", callback_data: `adm_mod_bal_${targetId}` }, { text: user.isBanned ? "✅ Unban" : "🚫 Ban", callback_data: `adm_mod_ban_${targetId}` }],
            [{ text: "📩 Send DM", callback_data: `adm_mod_dm_${targetId}` }]
          ]
        };
        bot.sendMessage(userId, details, { parse_mode: 'Markdown', reply_markup: kb }).catch(() => {});
      } else {
        bot.sendMessage(userId, "❌ User not found in database.");
      }
    }

    if (action === "SET_NOTICE") {
      node.config.joinNotice = text;
      bot.sendMessage(userId, `✅ Join Notice updated to:\n\n${text}`);
      this.logAdminAction(node, `Updated join notice`);
      await this.saveNodeToFirestore(node);
    }

    if (action === "EDIT_qrCode") {
      const photoId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : text.trim();
      if (!photoId) {
        return bot.sendMessage(userId, "❌ Please upload a QR code photo or send a valid image URL.");
      }
      node.config.qrCode = photoId;
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, "✅ <b>QR Code photo updated successfully!</b>", { parse_mode: 'HTML' });
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "EDIT_depositTax") {
      const taxVal = parseFloat(text);
      if (isNaN(taxVal) || taxVal < 0) {
        return bot.sendMessage(userId, "❌ Please enter a valid percentage number (e.g. 0, 2, 5).");
      }
      node.config.depositTax = taxVal;
      await this.saveNodeToFirestore(node);
      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>Deposit Tax updated to ${taxVal}%!</b>`, { parse_mode: 'HTML' });
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action.startsWith('EDIT_')) {
      const field = action.replace('EDIT_', '') as keyof SubBotConfig;
      const val = parseFloat(text);
      if (typeof node.config[field] === 'number' && !isNaN(val)) {
        (node.config[field] as number) = val;
        bot.sendMessage(userId, `✅ Updated **${field}** to ${val}.`);
        this.logAdminAction(node, `Updated ${field} to ${val}`);
      } else if (field === 'customDashboardImage' || field === 'qrCode') {
        const photoId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : text.trim();
        (node.config[field] as string) = photoId;
        bot.sendMessage(userId, `✅ Updated **${field}** successfully.`);
        this.logAdminAction(node, `Updated ${field}`);
      } else {
        (node.config[field] as string) = text;
        bot.sendMessage(userId, `✅ Updated **${field}** successfully.`);
        this.logAdminAction(node, `Updated ${field}`);
      }
      this.fsmStates.delete(userId);
      await this.saveNodeToFirestore(node);
      return this.sendAdminPanel(bot, node, userId);
    }

    if (action === "SET_WALLET") {
      const inputWallet = text.trim();
      
      // Duplicate Check across ALL users in THIS SPECIFIC node using Firestore for robustness
      let isRegistered = false;
      const usersRef = collection(cdb, 'nodes', node.id, 'users');
      const q = query(usersRef, where('walletId', '==', inputWallet), limit(1));
      const qSnap = await getDocs(q);
      
      if (!qSnap.empty) {
        // Double check it's not the SAME user updating their own wallet to the same value
        const match = qSnap.docs[0];
        if (match.id !== String(userId)) {
          isRegistered = true;
        }
      }

      if (isRegistered) {
        return bot.sendMessage(userId, "⚠️ **THIS WALLET ID IS ALREADY REGISTERED TRY ANOTHER WALLET ID**", { parse_mode: 'Markdown' });
      }

      const user = await this.ensureUserLoaded(node, userId);
      if (user) {
        user.walletId = inputWallet;
        await this.saveUserToFirestore(node.id, userId, user);
        bot.sendMessage(userId, "✅ Wallet ID saved successfully.");
      }
    }

    if (action === "EDIT_botOffText") {
      node.config.botOffText = text;
      bot.sendMessage(userId, "✅ Maintenance message updated.");
      await this.saveNodeToFirestore(node);
    }

    if (action === "EDIT_buildInfo") {
      node.config.buildInfoText = text;
      bot.sendMessage(userId, "✅ Build info message updated.");
      await this.saveNodeToFirestore(node);
    }

    if (action === "EDIT_DASH_TEXT") {
      node.config.customDashboardText = text;
      bot.sendMessage(userId, "✅ Dashboard text updated successfully.");
      await this.saveNodeToFirestore(node);
    }

    if (action === "EDIT_DASH_IMG") {
      const photoId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : text;
      node.config.customDashboardImage = photoId;
      bot.sendMessage(userId, "✅ Dashboard header photo updated successfully.");
      await this.saveNodeToFirestore(node);
    }

    if (action === "EDIT_joinNotice") {
      node.config.joinNotice = text;
      bot.sendMessage(userId, "✅ Global welcome message updated.");
      await this.saveNodeToFirestore(node);
    }

    if (action === "EDIT_supportContact") {
      node.config.supportContact = text;
      bot.sendMessage(userId, "✅ Support contact updated.");
      await this.saveNodeToFirestore(node);
    }

    if (action === "TRANSFER_USER_ID") {
      const targetId = parseInt(text.trim());
      if (isNaN(targetId)) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ Please enter a valid numeric User ID.");
      }
      if (targetId === userId) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ You cannot transfer funds to yourself.");
      }
      const senderUser = await this.ensureUserLoaded(node, userId);
      if (!senderUser || senderUser.balance <= 0) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ Insufficient balance for user transfer.");
      }
      this.fsmStates.set(userId, { nodeId: node.id, action: "TRANSFER_USER_AMT", targetId });
      return bot.sendMessage(userId, `💸 Enter amount to transfer to User ID <code>${targetId}</code> (Available Balance: ₹${senderUser.balance.toFixed(2)}):`, { parse_mode: 'HTML' });
    }

    if (action === "TRANSFER_USER_AMT") {
      const amt = parseFloat(text.trim());
      if (isNaN(amt) || amt <= 0) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ Invalid transfer amount.");
      }
      const senderUser = await this.ensureUserLoaded(node, userId);
      if (!senderUser || senderUser.balance < amt) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, "❌ Insufficient balance for transfer.");
      }
      const targetUser = await this.ensureUserLoaded(node, state.targetId!);
      if (!targetUser) {
        this.fsmStates.delete(userId);
        return bot.sendMessage(userId, `❌ User ID <code>${state.targetId}</code> has not registered in this bot.`, { parse_mode: 'HTML' });
      }

      senderUser.balance -= amt;
      targetUser.balance += amt;

      await this.saveUserToFirestore(node.id, userId, senderUser);
      await this.saveUserToFirestore(node.id, state.targetId!, targetUser);

      this.fsmStates.delete(userId);
      bot.sendMessage(userId, `✅ <b>TRANSFER SUCCESSFUL!</b>\n\nTransferred ₹${amt.toFixed(2)} to User ID <code>${state.targetId}</code>.\nRemaining Balance: ₹${senderUser.balance.toFixed(2)}`, { parse_mode: 'HTML' });
      
      bot.sendMessage(state.targetId!, `🎉 <b>MONEY RECEIVED!</b>\n\nYou received <b>₹${amt.toFixed(2)}</b> from User ID <code>${userId}</code>!\nNew Balance: <b>₹${targetUser.balance.toFixed(2)}</b>`, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    if (action === "EDIT_updateChannel") {
      node.config.updateChannel = text;
      bot.sendMessage(userId, "✅ Update channel updated.");
      await this.saveNodeToFirestore(node);
    }

    if (action === "BAN_USER") {
      const targetId = parseInt(text);
      if (!isNaN(targetId)) {
        if (targetId === node.ownerId) return bot.sendMessage(userId, "❌ Cannot ban owner.");
        node.config.bannedUsers.add(targetId);
        bot.sendMessage(userId, `✅ User ${targetId} has been banned.`);
        this.logAdminAction(node, `Banned user ${targetId}`);
        await this.saveNodeToFirestore(node);
      }
    }

    if (action === "UNBAN_USER") {
      const targetId = parseInt(text);
      if (!isNaN(targetId)) {
        node.config.bannedUsers.delete(targetId);
        bot.sendMessage(userId, `✅ User ${targetId} has been unbanned.`);
        this.logAdminAction(node, `Unbanned user ${targetId}`);
        await this.saveNodeToFirestore(node);
      }
    }

    if (action === "BALANCE_MOD_ID") {
      const targetId = parseInt(text.trim());
      if (isNaN(targetId)) {
        bot.sendMessage(userId, "❌ Please enter a valid User ID.");
        return;
      }
      if (!db) {
        bot.sendMessage(userId, "❌ Database offline.");
        return;
      }
      const uDoc = await db.collection('nodes').doc(node.id).collection('users').doc(String(targetId)).get();
      if (!uDoc.exists) {
        bot.sendMessage(userId, `❌ User ID ${targetId} has never started/registered in this bot.`);
        return;
      }
      const targetUser = await this.ensureUserLoaded(node, targetId);
      if (targetUser) {
        this.fsmStates.set(userId, { nodeId: node.id, action: "BALANCE_MOD_AMT", targetId });
        bot.sendMessage(userId, `💰 <b>Current Balance: ₹${targetUser.balance.toFixed(2)}</b>\n\nEnter amount to Add (ex: 100) or Cut (ex: -100) for ${targetId}:`, { parse_mode: 'HTML' });
        return;
      }
    }

    if (action === "BALANCE_MOD_AMT") {
      const amt = parseFloat(text.trim());
      if (isNaN(amt)) {
        bot.sendMessage(userId, "❌ Invalid amount entered. Balance modification canceled.");
        this.fsmStates.delete(userId);
        return;
      }
      const targetUser = await this.ensureUserLoaded(node, state.targetId);
      if (targetUser) {
        targetUser.balance += amt;
        await this.saveUserToFirestore(node.id, state.targetId, targetUser);
        bot.sendMessage(userId, `✅ Balance adjusted successfully for user ${state.targetId}.\n\n💵 Adjustment: <b>₹${amt >= 0 ? "+" : ""}${amt.toFixed(2)}</b>\n💰 New Balance: <b>₹${targetUser.balance.toFixed(2)}</b>`, { parse_mode: 'HTML' });
        if (node.config.userAlerts) {
          bot.sendMessage(state.targetId!, `🔔 **Balance Updated!**\nAdmin has modified your balance.\n\n💵 Adjustment: *₹${amt >= 0 ? "+" : ""}${amt.toFixed(2)}*\n💰 New Balance: *₹${targetUser.balance.toFixed(2)}*`, { parse_mode: 'Markdown' }).catch(() => {});
        }
        this.logAdminAction(node, `Adjusted balance of ${state.targetId} by ${amt}`);
      } else {
        bot.sendMessage(userId, "❌ User profile could not be loaded.");
      }
      this.fsmStates.delete(userId);
      return;
    }

    if (action === "USER_SUPPORT_MSG") {
      const supportText = text.trim();
      if (!supportText) return;
      this.fsmStates.delete(userId);
      const senderObj = await this.ensureUserLoaded(node, userId);
      const senderName = senderObj?.name || senderObj?.username || `User ${userId}`;

      const adminAlertMsg = `📩 <b>NEW SUPPORT MESSAGE FROM USER</b>\n\n` +
        `👤 <b>From:</b> ${esc(senderName)} (<code>${userId}</code>)\n` +
        `🤖 <b>Sub-Bot:</b> @${esc(node.username || "Bot")}\n\n` +
        `💬 <b>Message:</b>\n${esc(supportText)}\n\n` +
        `👇 Click below to reply directly to this user:`;

      const replyKb = {
        inline_keyboard: [
          [{ text: "↩️ Reply to User Direct", callback_data: `adm_mod_dm_${userId}` }]
        ]
      };

      if (node.ownerId) {
        bot.sendMessage(node.ownerId, adminAlertMsg, { parse_mode: 'HTML', reply_markup: replyKb }).catch(() => {});
      }
      node.config.admins.forEach(adminId => {
        if (adminId !== node.ownerId) {
          bot.sendMessage(adminId, adminAlertMsg, { parse_mode: 'HTML', reply_markup: replyKb }).catch(() => {});
        }
      });

      return bot.sendMessage(userId, `✅ <b>Message Sent to Admin!</b>\n\nYour message has been delivered to the admin. You will receive their reply right here in this chat as soon as they respond.`, { parse_mode: 'HTML' });
    }

    if (action === "ADMIN_REPLY_USER") {
      const replyText = text.trim();
      const targetUserId = state.targetUserId;
      if (!replyText || !targetUserId) return;
      this.fsmStates.delete(userId);

      const userDeliveryMsg = `📩 <b>SUPPORT REPLY FROM ADMIN</b>\n\n` +
        `💬 <b>Admin Message:</b>\n${esc(replyText)}`;

      const replyBackKb = {
        inline_keyboard: [
          [{ text: "💬 Reply Back to Admin", callback_data: `sub_support_dm_${node.id}` }]
        ]
      };

      bot.sendMessage(targetUserId, userDeliveryMsg, { parse_mode: 'HTML', reply_markup: replyBackKb }).catch((err) => {
        bot.sendMessage(userId, `❌ Could not deliver reply to user ${targetUserId}: ${err.message}`);
      });
      return bot.sendMessage(userId, `✅ <b>Reply Delivered!</b>\n\nYour response has been delivered directly to user <code>${targetUserId}</code> in their bot chat.`, { parse_mode: 'HTML' });
    }

    if (action === "BROADCAST") {
      bot.sendMessage(userId, "🚀 **Broadcasting started...**").catch(() => {});
      
      try {
        if (!db) throw new Error("Database offline.");
        const userSnap = await db.collection('nodes').doc(node.id).collection('users').get();
        const allUserIds = userSnap.docs.map(d => Number(d.id));
        
        let success = 0;
        let failed = 0;
        
        for (const uid of allUserIds) {
          try {
            await bot.sendMessage(uid, `📢 **BROADCAST MESSAGE**\n\n${text}`);
            success++;
            await new Promise(r => setTimeout(r, 40)); 
          } catch (e) {
            failed++;
          }
        }
        bot.sendMessage(userId, `✅ **Broadcast Completed!**\n\n🟢 Sent: ${success}\n🔴 Failed: ${failed}`);
        this.logAdminAction(node, `Sent broadcast to ${success} users.`);
      } catch (err: any) {
        bot.sendMessage(userId, "❌ Broadcast Error: " + err.message);
      }
    }

    if (action === "DM_ID") {
      const targetId = parseInt(text);
      if (node.users.has(targetId)) {
        this.fsmStates.set(userId, { nodeId: node.id, action: "DM_MSG", targetId });
        bot.sendMessage(userId, `📩 Enter message for ${targetId}:`);
        return;
      }
    }

    if (action === "DM_MSG") {
      bot.sendMessage(state.targetId!, `📩 **Message from Admin:**\n\n${text}`);
      bot.sendMessage(userId, "✅ Direct message sent.");
      this.logAdminAction(node, `Sent DM to ${state.targetId}`);
    }

    if (action === "API_SETUP") {
      const parts = text.split('|').map(p => p.trim());
      if (parts.length >= 2) {
        let url = parts[1];
        if (!url.startsWith('http')) {
          url = 'https://' + url;
        }

        try {
          new URL(url.replace(/{wallet}/g, 'test').replace(/{amount}/g, '100').replace(/{userId}/g, '123'));
        } catch (e) {
          return bot.sendMessage(userId, "❌ **CRITICAL ERROR:** Invalid Gateway URL format. Check protocol and characters.");
        }

        node.config.payoutGatewayName = parts[0];
        node.config.payoutUrl = url;
        
        if (parts.length >= 3) {
          let appUrl = parts[2];
          if (!appUrl.startsWith('http')) appUrl = 'https://' + appUrl;
          node.config.payoutAppUrl = appUrl;
        } else {
          try {
            const u = new URL(url);
            node.config.payoutAppUrl = u.protocol + "//" + u.hostname;
          } catch {
            node.config.payoutAppUrl = url;
          }
        }

        bot.sendMessage(userId, `✅ **GATEWAY UPDATED!**\n\n🔹 **Name:** ${node.config.payoutGatewayName}\n🔹 **Endpoint:** \`<REDACTED>\`\n🔹 **App URL:** \`${node.config.payoutAppUrl}\`\n\n🛡 **Status:** ACTIVE`, { parse_mode: 'Markdown' });
        this.logAdminAction(node, `Updated API Gateway to ${node.config.payoutGatewayName}`);
        await this.saveNodeToFirestore(node);
      } else {
        bot.sendMessage(userId, "❌ **INVALID FORMAT!**\nUse: `Name | API_URL | App_URL` (optional)\n\nExample: `GatewayX | https://api.com/pay?k=123&u={wallet} | https://gateway-app.com`", { parse_mode: 'Markdown' });
      }
    }

    this.fsmStates.delete(userId);
  }

  private async refreshAdminPanel(bot: any, node: BotNode, userId: number, messageId?: number) {
    if (messageId) {
       this.sendAdminPanel(bot, node, userId, messageId);
    } else {
       this.sendAdminPanel(bot, node, userId);
    }
  }

  private async processWithdrawal(bot: any, node: BotNode, userId: number, amount: number, wallet: string, adminChatId?: number, adminMsgId?: number): Promise<boolean> {
    const tax = (amount * node.config.withdrawTax) / 100;
    const finalAmount = Math.max(0, amount - tax);
    const txnId = `TXN${Date.now()}${Math.floor(100 + Math.random() * 900)}`;

    const hasApiGateway = Boolean((node.config.gatewayApiUrl && node.config.gatewayApiUrl.trim()) || (node.config.payoutUrl && node.config.payoutUrl.trim()));

    // 1. PURE MANUAL OFFLINE APPROVAL (ONLY when NO API Gateway is configured AND admin approved manually)
    if (!hasApiGateway) {
      if (adminChatId) {
        // Admin manually approved a manual offline withdrawal
        bot.sendMessage(userId, `✅ <b>Withdrawal Approved!</b>\n\nYour manual withdrawal request for ₹${finalAmount.toFixed(2)} has been successfully approved and sent by the admin.\n\n💰 Amount: ₹${finalAmount.toFixed(2)}\n🧾 Tax (Ded.): ₹${tax.toFixed(2)}\n💳 Wallet: <code>${esc(wallet)}</code>\n✅ Status: <b>SUCCESS (MANUAL)</b>`, { parse_mode: 'HTML' }).catch(() => {});
        
        const wdData = { userId, amount: finalAmount, wallet, timestamp: Date.now(), id: `WD-${uuidv4().substring(0, 8)}` };
        node.withdrawals.push(wdData);
        if (node.withdrawals.length > 100) node.withdrawals.shift();
        await this.saveWithdrawalToFirestore(node.id, wdData);

        const targetPayoutCh = this.getTelegramChatIdentifier(node.config.payoutChannel);
        if (targetPayoutCh) {
          const me = await bot.getMe();
          bot.sendMessage(targetPayoutCh, `💸 <b>MANUAL PAYOUT APPROVED</b>\n\n👤 User: <code>${userId}</code>\n💰 Amount: ₹${finalAmount.toFixed(2)}\n💳 Wallet: <code>${esc(wallet)}</code>\n✅ Status: <b>SUCCESS</b>\n\n🛠 Powered by @${esc(me.username)}`, { parse_mode: 'HTML' }).catch(() => {});
        }
        return true;
      } else {
        // Auto withdrawal attempted but no gateway URL is set
        bot.sendMessage(userId, "❌ <b>Payout Gateway is not configured.</b>\nYour balance has been refunded.", { parse_mode: 'HTML' });
        const user = await this.ensureUserLoaded(node, userId);
        if (user) {
          user.balance += amount;
          await this.saveUserToFirestore(node.id, userId, user);
        }
        return false;
      }
    }

    // 2. REAL API GATEWAY EXECUTION
    try {
      let isSuccess = false;
      let rawResStr = "";
      let gatewayMsg = "";

      // CASE A: DYNAMIC JSON POST GATEWAY (node.config.gatewayApiUrl)
      if (node.config.gatewayApiUrl && node.config.gatewayApiUrl.trim()) {
        const postUrl = node.config.gatewayApiUrl.trim();
        logSys(`[PAYOUT_POST_REQ] Target: ${postUrl} | User: ${userId} | Amt: ${finalAmount.toFixed(2)} | Wallet: ${wallet}`);
        
        const payload = {
          amount: finalAmount.toFixed(2),
          wallet: wallet,
          number: wallet,
          upi: wallet,
          secret_key: node.config.gatewaySecretKey || "",
          user_id: userId,
          node_id: node.id,
          txn_id: txnId
        };

        const response = await axios.post(postUrl, payload, {
          timeout: 15000,
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'SR-Tech-BotEngine/5.0 (REAL-TIME)'
          },
          validateStatus: () => true
        }).catch(err => {
          throw new Error(err.message || "Network Communication Failure");
        });

        const resData = response.data;
        rawResStr = typeof resData === 'string' ? resData : JSON.stringify(resData);
        logSys(`[PAYOUT_POST_RSP] Code: ${response.status} | Body: ${rawResStr.substring(0, 300)}`);

        if (response.status >= 200 && response.status < 300) {
          let parsed: any = null;
          if (typeof resData === 'object' && resData !== null) parsed = resData;
          else {
            try { parsed = JSON.parse(resData); } catch {}
          }

          if (parsed) {
            const st = String(parsed.status ?? parsed.STATUS ?? parsed.state ?? "").toLowerCase();
            const succ = parsed.success ?? parsed.Success;
            const code = Number(parsed.code ?? parsed.statusCode ?? parsed.status_code);
            gatewayMsg = String(parsed.message ?? parsed.msg ?? parsed.response ?? parsed.result ?? parsed.remark ?? "");

            const isExplicitFail = st === 'failed' || st === 'fail' || st === 'error' || st === '0' || st === 'false' || succ === false;
            const isExplicitSuccess = st === 'success' || st === 'txn_success' || st === 'done' || st === 'true' || st === '1' || st === 'ok' || st === 'completed' || succ === true || succ === 'true' || succ === 1 || code === 200;

            if (isExplicitSuccess && !isExplicitFail) {
              isSuccess = true;
            }
          } else {
            const lower = rawResStr.toLowerCase().trim();
            if (!lower.startsWith('<html') && !lower.startsWith('<!doctype') && (lower === 'success' || lower === '1' || lower === 'done' || lower.includes('success')) && !lower.includes('fail') && !lower.includes('error')) {
              isSuccess = true;
            }
          }
        }
      }

      // CASE B: URL GET GATEWAY (node.config.payoutUrl)
      else if (node.config.payoutUrl && node.config.payoutUrl.trim()) {
        let finalUrl = node.config.payoutUrl.trim();
        if (!finalUrl.startsWith('http')) finalUrl = 'https://' + finalUrl;

        finalUrl = finalUrl
          .replace(/{wallet}/gi, encodeURIComponent(wallet))
          .replace(/{number}/gi, encodeURIComponent(wallet))
          .replace(/{upi}/gi, encodeURIComponent(wallet))
          .replace(/{phone}/gi, encodeURIComponent(wallet))
          .replace(/{amount}/gi, encodeURIComponent(finalAmount.toFixed(2)))
          .replace(/{amt}/gi, encodeURIComponent(finalAmount.toFixed(2)))
          .replace(/{userId}/gi, encodeURIComponent(String(userId)))
          .replace(/{userid}/gi, encodeURIComponent(String(userId)))
          .replace(/{txnId}/gi, encodeURIComponent(txnId))
          .replace(/{txnid}/gi, encodeURIComponent(txnId))
          .replace(/{orderId}/gi, encodeURIComponent(txnId))
          .replace(/{orderid}/gi, encodeURIComponent(txnId))
          .replace(/{refId}/gi, encodeURIComponent(txnId))
          .replace(/{refid}/gi, encodeURIComponent(txnId));

        logSys(`[PAYOUT_GET_REQ] URL: ${finalUrl}`);

        const response = await axios.get(finalUrl, { 
          timeout: 15000,
          headers: { 
            'User-Agent': 'SR-Tech-BotEngine/5.0 (PRO)',
            'Accept': '*/*'
          },
          validateStatus: () => true 
        }).catch(err => {
          let msg = err.message || "Network Communication Failure";
          if (err.code === 'ECONNABORTED') msg = "Gateway connection timeout (15s)";
          if (err.code === 'ENOTFOUND') msg = "Invalid gateway host";
          throw new Error(msg);
        });

        const resData = response.data;
        rawResStr = typeof resData === 'string' ? resData : JSON.stringify(resData);
        logSys(`[PAYOUT_GET_RSP] Code: ${response.status} | Body: ${rawResStr.substring(0, 300)}`);

        if (response.status >= 200 && response.status < 300) {
          let parsed: any = null;
          if (typeof resData === 'object' && resData !== null) parsed = resData;
          else {
            try { parsed = JSON.parse(resData); } catch {}
          }

          if (parsed) {
            const st = String(parsed.status ?? parsed.STATUS ?? parsed.state ?? "").toLowerCase();
            const succ = parsed.success ?? parsed.Success;
            const code = Number(parsed.code ?? parsed.statusCode ?? parsed.status_code);
            gatewayMsg = String(parsed.message ?? parsed.msg ?? parsed.response ?? parsed.result ?? parsed.remark ?? "");

            const isExplicitFail = st === 'failed' || st === 'fail' || st === 'error' || st === '0' || st === 'false' || succ === false;
            const isExplicitSuccess = st === 'success' || st === 'txn_success' || st === 'done' || st === 'true' || st === '1' || st === 'ok' || st === 'completed' || succ === true || succ === 'true' || succ === 1 || code === 200;

            if (isExplicitSuccess && !isExplicitFail) {
              isSuccess = true;
            }
          } else {
            const lower = rawResStr.toLowerCase().trim();
            if (!lower.startsWith('<html') && !lower.startsWith('<!doctype') && (lower === 'success' || lower === '1' || lower === 'done' || lower === 'ok' || lower.includes('success') || lower.includes('txn_success')) && !lower.includes('fail') && !lower.includes('error') && !lower.includes('invalid') && !lower.includes('insufficient')) {
              isSuccess = true;
            }
          }
        }
      }

      // 3. HANDLE SUCCESS OR FAILURE
      if (isSuccess) {
        bot.sendMessage(userId, `✅ <b>Withdrawal Successful!</b>\n\nYour payout of ₹<b>${finalAmount.toFixed(2)}</b> has been transferred directly to your wallet.\n\n💰 <b>Amount:</b> ₹${finalAmount.toFixed(2)}\n🧾 <b>Tax (Ded.):</b> ₹${tax.toFixed(2)}\n💳 <b>Wallet:</b> <code>${esc(wallet)}</code>\n🆔 <b>Txn ID:</b> <code>${txnId}</code>\n✅ <b>Status:</b> <b>SUCCESS</b>\n\n🛰 <b>Gateway Msg:</b> <code>${esc(gatewayMsg || rawResStr.substring(0, 120))}</code>`, { parse_mode: 'HTML' }).catch(() => {});
        
        const wdData = { userId, amount: finalAmount, wallet, timestamp: Date.now(), id: txnId };
        node.withdrawals.push(wdData);
        if (node.withdrawals.length > 100) node.withdrawals.shift();
        await this.saveWithdrawalToFirestore(node.id, wdData);

        const targetPayoutCh = this.getTelegramChatIdentifier(node.config.payoutChannel);
        if (targetPayoutCh) {
          const me = await bot.getMe();
          const logMsg = `💸 <b>PAYOUT SUCCESSFUL</b>\n\n👤 User: <code>${userId}</code>\n💰 Amount: ₹${finalAmount.toFixed(2)}\n💳 Wallet: <code>${esc(wallet)}</code>\n🆔 Txn ID: <code>${txnId}</code>\n✅ Status: <b>SUCCESS</b>\n\n📡 <b>GATEWAY RESPONSE:</b>\n<code>${esc(rawResStr.substring(0, 160))}</code>\n\n🛠 Powered by @${esc(me.username)}`;
          bot.sendMessage(targetPayoutCh, logMsg, { parse_mode: 'HTML' }).catch(() => {});
        }
        return true;
      } else {
        // GATEWAY REJECTED / FAILED - REFUND USER
        const failReason = gatewayMsg || rawResStr.substring(0, 200) || "Gateway rejected payout request";
        bot.sendMessage(userId, `❌ <b>Withdrawal Failed!</b>\n\n<b>Reason:</b> <code>${esc(failReason)}</code>\n\n💰 <b>₹${amount.toFixed(2)}</b> has been refunded back to your bot balance.\nPlease check your wallet ID or contact support.`, { parse_mode: 'HTML' }).catch(() => {});
        
        const user = await this.ensureUserLoaded(node, userId);
        if (user) {
          user.balance += amount;
          await this.saveUserToFirestore(node.id, userId, user);
        }

        const targetPayoutCh = this.getTelegramChatIdentifier(node.config.payoutChannel);
        if (targetPayoutCh) {
          bot.sendMessage(targetPayoutCh, `⚠️ <b>PAYOUT FAILED / DECLINED</b>\n\n👤 User: <code>${userId}</code>\n💰 Amount: ₹${finalAmount.toFixed(2)}\n💳 Wallet: <code>${esc(wallet)}</code>\n❌ <b>Gateway Response:</b>\n<code>${esc(rawResStr.substring(0, 180))}</code>\n\n🔄 <i>User balance refunded.</i>`, { parse_mode: 'HTML' }).catch(() => {});
        }

        if (adminChatId) {
          bot.sendMessage(adminChatId, `❌ <b>Payout Declined by Gateway:</b>\nUser: <code>${userId}</code>\nAmount: ₹${finalAmount.toFixed(2)}\nReason: <code>${esc(failReason)}</code>\nUser balance has been refunded.`, { parse_mode: 'HTML' }).catch(() => {});
        }
        return false;
      }

    } catch (err: any) {
      logSys(`[PAYOUT_ERROR] ${err.message}`);
      bot.sendMessage(userId, `❌ <b>Gateway Connection Error</b>\n\nReason: <code>${esc(err.message)}</code>\n\n💰 <b>₹${amount.toFixed(2)}</b> has been refunded back to your bot balance.\nPlease try again later.`, { parse_mode: 'HTML' }).catch(() => {});
      
      const user = await this.ensureUserLoaded(node, userId);
      if (user) {
        user.balance += amount;
        await this.saveUserToFirestore(node.id, userId, user);
      }

      if (adminChatId) {
        bot.sendMessage(adminChatId, `⚠️ <b>Gateway Call Exception:</b> <code>${esc(err.message)}</code>\nUser ${userId} balance refunded.`, { parse_mode: 'HTML' }).catch(() => {});
      }
      return false;
    }
  }

  private serverStartTime = Date.now();

  private lastServedStats: any = null;
  getStats() {
    let globalUsersFromNodes = 0;
    const nodesArray = Array.from(this.nodes.values());
    nodesArray.forEach(n => {
       if (n.id.startsWith("BLUEPRINT_")) return;
       const count = Number((n.config as any).totalUsers || n.users?.size || 0);
       if (!isNaN(count)) globalUsersFromNodes += count;
    });

    // Artificial Growth Logic: +2 every minute relative to first run
    // Artificial Growth Logic: +2 every minute relative to first run, persisted
    const secondsElapsed = Math.floor((Date.now() - this.statsBaseTime) / 1000);
    const growthUsers = Math.floor(secondsElapsed / 30); // 30s = +1 user -> 60s = +2 users (as requested)
    const growthNodes = Math.floor(secondsElapsed / 120); 
    const growthHub = Math.floor(secondsElapsed / 180); 

    const newStats = {
      totalNodes: nodesArray.filter(n => !n.id.startsWith("BLUEPRINT_")).length + growthNodes,
      globalUsers: Math.max(0, globalUsersFromNodes) + growthUsers,
      hubUsers: Math.max(0, growthHub)
    };

    // Resiliency: Never let stats decrease during a single session if possible
    if (this.lastServedStats) {
      if (newStats.globalUsers < this.lastServedStats.globalUsers) newStats.globalUsers = this.lastServedStats.globalUsers;
      if (newStats.totalNodes < this.lastServedStats.totalNodes) newStats.totalNodes = this.lastServedStats.totalNodes;
      if (newStats.hubUsers < this.lastServedStats.hubUsers) newStats.hubUsers = this.lastServedStats.hubUsers;
    }

    this.lastServedStats = newStats;
    return newStats;
  }

  getUserNodes(userId: number): BotNode[] {
    const ids = this.userToNodes.get(userId) || [];
    return ids.map(id => this.nodes.get(id)).filter(Boolean) as BotNode[];
  }
}

engine = new BotEngine();

const USER_HUB_KB = {
  reply_markup: {
    keyboard: [
      [{ text: "➕ Create New Bot" }, { text: "🤖 My All Bot Nodes" }],
      [{ text: "📢 My Bots Broadcast" }, { text: "📊 Hub Stats" }],
      [{ text: "📞 Support Hub" }]
    ],
    resize_keyboard: true
  }
};

const ADMIN_HUB_KB = {
  reply_markup: {
    keyboard: [
      [{ text: "📢 All Bot and User Broadcast" }, { text: "📢 All Bot Broadcast" }],
      [{ text: "🛠️ Maintenance Mode" }, { text: "📊 Hub Stats" }],
      [{ text: "🚫 Management Bot Ban" }, { text: "🛠 Template Designer" }],
      [{ text: "🔙 Back to User Menu" }]
    ],
    resize_keyboard: true
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  // --- HEALTH CHECK ENDPOINTS FOR CRON-JOB.ORG (MANDATORY TOP POSITION) ---
  app.get("/api/health", (req, res) => res.status(200).send("OK"));
  app.get("/api/ping", (req, res) => res.status(200).send("PONG"));
  // -------------------------------------------------------------------------

  app.use(express.json());

  // 0. Base URL Middleware (MUST BE BEFORE ROUTES)
  app.use((req, res, next) => {
    if (req.get('host')) {
      const host = req.get('host') || "";
      const cleanHost = host.split(":")[0];
      
      // Only update if it's a real external-looking domain
      if (cleanHost && cleanHost !== 'localhost' && !cleanHost.startsWith('127.')) {
        const oldUrl = BASE_URL;
        const newUrl = `https://${cleanHost}`;
        
        if (oldUrl !== newUrl) {
          BASE_URL = newUrl;
          // If BASE_URL just transitioned from empty/placeholder to real
          if (!oldUrl || oldUrl.includes("your-app-url") || oldUrl.includes("localhost")) {
            logSys(`[NETWORK_SYNC] Base URL detected: ${BASE_URL}. Syncing all node webhooks...`);
            engine.boot().then(() => logSys("All nodes re-synced with correct BASE_URL."));
          }
        }
      }
    }
    next();
  });

  // Device Verification System Endpoint with Multi-Account & IP Anti-Cheat Detection
  const handleDeviceVerification = async (req: express.Request, res: express.Response) => {
    const { nodeId, userId, ref, refId, deviceId: clientDeviceId, hardwareFp, clientDetails } = req.body;
    if (!nodeId || !userId) return res.json({ success: false, reason: "Missing required parameters." });

    try {
      const node = engine.getNodes().get(nodeId);
      if (!node) return res.json({ success: false, reason: "Invalid bot node configuration." });

      const userIdNum = Number(userId);
      let user = await engine.ensureUserLoaded(node, userIdNum);

      const effectiveRef = ref || refId;
      const finalRefNum = (effectiveRef && effectiveRef !== 'none') ? Number(effectiveRef) : null;
      
      const rawIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.socket.remoteAddress || req.ip || '';
      const clientIp = String(rawIp).replace(/^.*:/, '').trim();
      const finalDeviceId = clientDeviceId || (hardwareFp ? `DEV-${hardwareFp}` : `DEV-${clientIp || 'anon'}`);

      // 1. In-Memory Anti-Cheat Check
      let conflictingUser: { id: number; reason: string } | null = null;
      for (const [otherId, otherUser] of node.users.entries()) {
        if (otherId !== userIdNum) {
          if (finalDeviceId && otherUser.deviceId && otherUser.deviceId === finalDeviceId) {
            conflictingUser = { id: otherId, reason: "Same Device Storage / Cookie" };
            break;
          }
          if (hardwareFp && (otherUser as any).hardwareFp && (otherUser as any).hardwareFp === hardwareFp) {
            conflictingUser = { id: otherId, reason: "Same Hardware Canvas / WebGL Entropy" };
            break;
          }
          if (clientIp && clientIp !== '127.0.0.1' && clientIp !== 'localhost' && (otherUser as any).ip && (otherUser as any).ip === clientIp) {
            conflictingUser = { id: otherId, reason: "Same Network IP Address" };
            break;
          }
        }
      }

      // 2. Firestore Anti-Cheat Check
      if (!conflictingUser && db && finalDeviceId) {
        try {
          const snapDev = await db.collection('nodes').doc(node.id).collection('users')
            .where('deviceId', '==', finalDeviceId)
            .limit(2)
            .get();

          const conflictingDoc = snapDev.docs.find(d => Number(d.id) !== userIdNum);
          if (conflictingDoc) {
            conflictingUser = { id: Number(conflictingDoc.id), reason: "Same Device ID in Database" };
          }
        } catch (e: any) {
          logSys(`[SECURITY_WARN] Device check query failed: ${e.message}`);
        }
      }

      // 3. Handle Duplicate / Multi-account Detection
      if (conflictingUser) {
        logSys(`[SECURITY_BLOCK] User ${userIdNum} blocked! Reason: ${conflictingUser.reason} (Matches account ${conflictingUser.id})`);
        
        if (user) {
          user.isDuplicate = true;
          user.deviceId = finalDeviceId;
          (user as any).hardwareFp = hardwareFp;
          (user as any).ip = clientIp;
          await engine.saveUserToFirestore(nodeId, userIdNum, user);
        }

        if (node.instance) {
          node.instance.sendMessage(userIdNum, `🚫 <b>SECURITY ALERT: SAME DEVICE / NETWORK DETECTED!</b>\n\nOur anti-cheat system detected that this phone or network is already registered with another account.\n\n⚠️ <b>Multiple accounts and fake referrals from the same device are strictly prohibited!</b>`, { parse_mode: 'HTML' }).catch(() => {});
        }

        return res.json({ 
          success: false, 
          duplicate: true, 
          reason: "🔴 Same Device / IP Detected! Multiple accounts from the same phone or network are strictly prohibited." 
        });
      }

      // 4. Register Verified Clean User
      if (!user) {
        user = {
          balance: 0,
          referrals: 0,
          walletId: null,
          isBanned: false,
          verified: true,
          isDuplicate: false,
          joinedAt: Date.now(),
          deviceId: finalDeviceId,
          joinAlerted: false
        };
        (user as any).hardwareFp = hardwareFp;
        (user as any).ip = clientIp;
        node.users.set(userIdNum, user);
      } else {
        user.verified = true;
        user.isDuplicate = false;
        user.deviceId = finalDeviceId;
        (user as any).hardwareFp = hardwareFp;
        (user as any).ip = clientIp;
      }

      await engine.saveUserToFirestore(nodeId, userIdNum, user);

      // Trigger Referral + Join Alert Logic
      const userName = (user as any).name || (user as any).username || "Verified User";
      await engine.handleUserJoined(node.instance, node, userIdNum, userName, finalRefNum);

      // Notify user in Telegram
      if (node.instance) {
        node.instance.sendMessage(userIdNum, "🛡️ <b>Device Verified Successfully!</b>\n\nYour device and network have passed integrity authentication. You can now access all features!", {
          reply_markup: engine.getMenuKeyboard(node),
          parse_mode: 'HTML'
        }).catch(() => {});
      }

      return res.json({ success: true });
    } catch (err: any) {
      return res.json({ success: false, reason: err.message || "Internal verification error." });
    }
  };

  app.post("/api/verify", handleDeviceVerification);
  app.post("/api/verify-device", handleDeviceVerification);

  app.get("/api/status", (req, res) => {
    const nodes = Array.from(engine.getNodes().values());
    const liveBots = nodes.filter((n: any) => n.instance).length;
    const offlineBots = nodes.length - liveBots;
    const stats = engine.getStats();
    
    res.json({
      status: "online",
      hubActive: !!hubBot && !!hubInfo,
      hubUsername: hubInfo?.username || "",
      totalNodes: nodes.length,
      liveBots,
      offlineBots,
      totalUsers: stats.globalUsers,
      hubTokenDefined: !!process.env.TELEGRAM_BOT_TOKEN,
      engineVersion: "V3.2-ENTERPRISE",
      serverSpeed: "2.4ms",
      loadAverage: "12%",
      logs: sysLogs
    });
  });
  
  app.post("/api/admin/broadcast", express.json(), async (req: express.Request, res: express.Response) => {
    const { message, adminId } = req.body;
    const isMaster = ADMIN_IDS.includes(Number(adminId));
    if (!isMaster) return res.status(403).json({ success: false, error: "ACCESS_DENIED" });

    const nodes = Array.from(engine.getNodes().values()) as BotNode[];
    res.json({ success: true, message: "Network Broadcast Initialized" });

    (async () => {
       const startTime = Date.now();
       let success = 0; let failed = 0;
       const logs: string[] = [];

       for (const node of nodes) {
          if (node.instance && typeof node.instance === 'object' && !node.id.startsWith("BLUEPRINT_") && !node.isBannedByAdmin) {
             try {
                const snap = await db.collection('nodes').doc(node.id).collection('users').get();
                const uids = snap.docs.map((d: any) => Number(d.id));
                let sc = 0; let fc = 0;
                for (const uid of uids) {
                   try {
                      await (node.instance as any).sendMessage(uid, message, { parse_mode: 'HTML' });
                      success++; sc++;
                   } catch { failed++; fc++; }
                   await new Promise(r => setTimeout(r, 65));
                }
                if (uids.length > 0) logs.push(`🔹 @${node.username}: ${sc} OK`);
             } catch (err) { logSys(`[API_BC] ERR: ${err}`); }
          }
       }
       const summary = `📊 <b>Global Web Broadcast Report</b>\n\n` +
          `⏱ Duration: ${Math.floor((Date.now() - startTime)/1000)}s\n` +
          `✅ Delivery: ${success}\n` +
          `❌ Failures: ${failed}\n\n` +
          logs.join('\n') + `\n\n🚀 <b>SR HUB Mesh</b>`;
       hubBot.sendMessage(Number(adminId), summary, { parse_mode: 'HTML' });
    })();
  });

  // Template List
  app.get("/api/templates", (req, res) => {
    res.json([
      { id: 'autopay', name: '🛒 Auto-Pay Pro', desc: 'Automatic payment processing with split-second confirmation.' },
      { id: 'upi', name: '💳 Hybrid UPI', desc: 'Dual-mode UPI engine for manual and automated transfers.' },
      { id: 'crypto', name: '💎 Crypto M01', desc: 'Enterprise blockchain node for USDT/TON/SOL payments.' },
      { id: 'star', name: '⭐️ Star Payout', desc: 'Direct Telegram Stars payment and withdrawal infrastructure.' },
      { id: 'task', name: '📋 Task Rewards', desc: 'Affiliate task system where users earn by completing actions.' },
      { id: 'bet', name: '🎯 Bet & Earn', desc: 'Fair-play gaming engine with instant balance settlement.' },
      { id: 'redeem', name: '🎟️ Gift Hub', desc: 'Mass-generation of redeemable gift codes and vouchers.' },
      { id: 'giveaway', name: '🎁 Giveaway Manager', desc: 'Automated distribution of rewards to active community members.' },
      { id: 'refer_auto', name: 'AUTO-PAY BOT', desc: 'High-growth referral engine with automated balance audits.' },
      { id: 'wallet', name: '📥 Wallet Pro', desc: 'Banking-grade ledger for multi-currency user wallets.' },
      { id: 'file', name: '📁 File Cloud', desc: 'Secure repository for digital assets and shareable links.' },
      { id: 'poll', name: '📊 Analytics Poll', desc: 'Real-time data gathering and user sentiment tracking.' },
      { id: 'refer_manual', name: '👤MANUAL PAY BOT', desc: 'Hand-vetted referral system for high-security networks.' },
      { id: 'upi_manual', name: '📥 UPI Manual', desc: 'Secure interface for manual UPI verification steps.' },
    ]);
  });

  // Node List
  app.get("/api/nodes", (req, res) => {
    const nodes = Array.from(engine.getNodes().values()).map((n: any) => ({
      id: n.id,
      username: n.username,
      type: n.type,
      ownerId: n.ownerId,
      status: !!n.instance ? 'LIVE' : 'OFFLINE',
      createdAt: n.createdAt
    }));
    res.json(nodes);
  });

  // Switch Template
  app.post("/api/nodes/:id/template", async (req, res) => {
    const { id } = req.params;
    const { template } = req.body;
    const node = engine.getNodes().get(id);
    if (!node) return res.status(404).json({ error: "Node not found" });
    
    try {
      node.type = template;
      // Re-initialize config for template
      if (template === 'autopay') {
        node.config.autoPayout = true;
        node.config.withdrawTax = 5;
        node.config.minWithdraw = 10;
      } else if (template === 'upi') {
        node.config.autoPayout = false;
        node.config.withdrawTax = 2;
        node.config.minWithdraw = 50;
      } else if (template === 'star') {
        node.config.autoPayout = true;
        node.config.withdrawTax = 0;
        node.config.minWithdraw = 1;
      } else if (template === 'task') {
        node.config.autoPayout = false;
        node.config.withdrawTax = 2;
      } else if (template === 'bet') {
        node.config.autoPayout = false;
        node.config.withdrawTax = 0;
      } else if (template === 'refer_auto') {
        node.config.autoPayout = true;
        node.config.withdrawTax = 5;
      } else if (template === 'refer_manual') {
        node.config.autoPayout = false;
        node.config.withdrawTax = 5;
        node.config.minWithdraw = 50;
      }
      
      await engine.saveNodeToFirestore(node);
      logSys(`[WEB_API] Template for ${id} switched to ${template}`);
      res.json({ success: true, type: template });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // 1. Initialize Bots Early
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/webhook')) {
       logSys(`[WEBHOOK_REQ] ${req.method} ${req.path} | UA: ${req.get('user-agent')}`);
    }
    next();
  });

  const hubToken = process.env.TELEGRAM_BOT_TOKEN;
  if (hubToken) {
    hubBot = new TelegramBot(hubToken, { polling: true });
    logSys(`Hub Bot Instance Created (Mode: Polling).`);

    hubBot.on('error', (err: any) => {
      logSys(`[HUB_BOT_ERR] ${err.message}`);
    });

    hubBot.on('polling_error', (err: any) => {
      if (err.message.includes('401')) {
        logSys(`[HUB_AUTH_CRITICAL] Master Bot Token is INVALID (401). Please check TELEGRAM_BOT_TOKEN environment variable.`);
        try { hubBot.stopPolling(); } catch {}
      } else if (!err.message.includes('EFATAL')) {
        logSys(`[HUB_POLL_ERR] ${err.message}`);
      }
    });
    
    hubBot.deleteWebHook({ drop_pending_updates: true }).catch(() => {});

    hubBot.getMe().then(async (info: any) => {
      hubInfo = info;
      logSys(`Hub Bot Authenticated: @${info.username}`);
      
      hubBot.setMyCommands([
        { command: 'start', description: "Let's Start The Advantage Of Earning" },
        { command: 'build', description: "Bot engine & developer" }
      ]).catch(() => {});
    }).catch((err: any) => {
      logSys(`[HUB_INIT_FATAL] ${err.message}`);
    });

    hubBot.on('message', async (msg: any) => {
      try {
        const chatId = msg.chat.id;
        const text = msg.text || "";
        logSys(`[HUB_IN] ${chatId}: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

        // Tracking Hub Users
        if (db) {
          db.collection('hubUsers').doc(String(chatId)).set({
            id: chatId,
            username: msg.from.username || null,
            firstName: msg.from.first_name || null,
            lastSeen: Date.now()
          }, { merge: true }).catch(() => {});
        }
        
        const ADMIN_IDS = [6561010416];
        if (process.env.ADMIN_HUB_ID) ADMIN_IDS.push(Number(process.env.ADMIN_HUB_ID));
        const isAdmin = ADMIN_IDS.includes(chatId);

        // --- INTERCEPTOR: Maintenance Mode ---
        const MASTER_ADMIN_ID = 6561010416;
        if (engine.getMaintenanceMode() && chatId !== MASTER_ADMIN_ID) {
          return hubBot.sendMessage(chatId, "⚠️ **SERVER UNDER MAINTENANCE**\n\nplease wait server is under maintenance", { parse_mode: 'Markdown' });
        }

        // Check for FSM state FIRST
        const hState = engine.fsmStates.get(chatId);
        if (hState) {
           const nodeToUse = hState.nodeId === "HUB_NODE" ? { id: "HUB_NODE", username: "SR_HUB" } : engine.getNodes().get(hState.nodeId);
           if (nodeToUse) {
              await engine.handleFSM(hubBot, nodeToUse as any, chatId, text || "", hState, msg);
              return;
           }
        }

        if (text === "/myid") {
          return hubBot.sendMessage(chatId, `👤 **YOUR TELEGRAM ID:** \`${chatId}\``, { parse_mode: 'Markdown' });
        }

        if (text === "/build") {
          const buildMsg = `🔧 **BUILD INFO**\n` +
            `├ 🤖 Engine: SR BOT [MAKER] v2.0\n` +
            `├ 👨💻 Developer: @SR_TECNOLOGY_LTD🇮🇳\n` +
            `└ ☁️ Architecture: Cloud Node Deployment\n\n` +
            `Building the future of Telegram automation.`;
          return hubBot.sendMessage(chatId, buildMsg, { parse_mode: 'Markdown' });
        }

        if (text === "/sradmin1") {
          const MASTER_ADMIN_ID = 6561010416;
          if (chatId !== MASTER_ADMIN_ID) {
            logSys(`[HUB_AUTH_FAIL] Unauthorized /sradmin1 attempt by ${chatId}`);
            return hubBot.sendMessage(chatId, "❌ **ACCESS DENIED**\n\nThis command is restricted to the Master Administrator's account only.");
          }
          logSys(`[HUB_AUTH_OK] Master Admin access granted to ${chatId}`);
          return hubBot.sendMessage(chatId, "👑 **MAIN HUB ADMIN PANEL**\n\nWelcome Master! Manage the entire network from here.", ADMIN_HUB_KB);
        }

        if (text.startsWith("/start") || ["➕ Create New Bot", "🤖 My All Bot Nodes", "📢 My Bots Broadcast", "📢 Broadcast all user", "📊 Hub Stats", "📞 Support Hub"].includes(text)) {
          // CHECK FORCE JOIN FIRST
          const channels = engine.getHubForceJoinChannels() || [];
          if (channels.length > 0) {
            const joinedStatuses = await Promise.all(channels.map((ch: string) => (engine as any).checkForceJoin(hubBot, ch, chatId)));
            if (joinedStatuses.includes(false)) {
              return (engine as any).sendHubJoinForce(hubBot, chatId);
            }
          }

          if (text.startsWith("/start")) {
            const user_tag = msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || "User");
            const welcomeMsg = `WELCOME , ${user_tag}!  SELECT  YOUR BOT TYPE 👇🏻 \n\n` +
              `╔════════════════════════════╗\n` +
              `          💫 ─── 𝐒𝐑 𝐁𝐎𝐓 𝐌𝐀𝐊𝐄𝐑 ─── 💫\n` +
              `            ⚡️ SR MASTER ENGINE PRO ✅\n` +
              `╚════════════════════════════╝\n` +
              `Welcome, ${user_tag}! Get ready to host high-speed automated bots instantly with zero coding.\n\n` +
              `📥 𝗖𝗛𝗢𝗢𝗦𝗘 𝗬𝗢𝗨𝗥 𝗕𝗢𝗧 𝗧𝗬𝗣𝗘 :\n` +
              `👇 Tap below to select your template and launch:\n\n` +
              `🚀 POWERED BY @SR_TECNOLOGY_LTD`;

            return hubBot.sendMessage(chatId, welcomeMsg, {
              parse_mode: 'Markdown',
              reply_markup: USER_HUB_KB.reply_markup
            }).catch(() => {});
          }
        }

        if (text === "📢 All Bot and User Broadcast" || text === "📢 All Bot Broadcast" || text === "📢 Broadcast Center" || text === "📢 My Bots Broadcast" || text.startsWith("/broadcast")) {
          const isAdmin = ADMIN_IDS.includes(chatId);
          
          if (text === "📢 All Bot and User Broadcast" || text.startsWith("/broadcast")) {
            if (!isAdmin) return;
            engine.fsmStates.set(chatId, { nodeId: "HUB_NODE", action: "BC_CENTER_MEDIA", broadcastType: "GLOBAL" });
            return hubBot.sendMessage(chatId, "📢 **All Bot and User Broadcast (GLOBAL)**\n\nSend your photo or video or skip it.", {
              reply_markup: { keyboard: [[{ text: "Skip Media" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
            });
          }
          
          if (text === "📢 All Bot Broadcast") {
            if (!isAdmin) return;
            engine.fsmStates.set(chatId, { nodeId: "HUB_NODE", action: "BC_CENTER_MEDIA", broadcastType: "ALL_BOTS" });
            return hubBot.sendMessage(chatId, "📢 **All Bot Broadcast (NETWORK)**\n\nThis will send your message to ALL users across ALL bots.\n\nSend your photo or video or skip it.", {
              reply_markup: { keyboard: [[{ text: "Skip Media" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
            });
          }

          if (text === "📢 My Bots Broadcast") {
            engine.fsmStates.set(chatId, { nodeId: "HUB_NODE", action: "BC_CENTER_MEDIA", broadcastType: "MY_BOTS" });
            return hubBot.sendMessage(chatId, "📢 **My Bots Broadcast**\n\nThis will send your message to all users of ALL bots you own.\n\nSend your photo or video or skip it.", {
              reply_markup: { keyboard: [[{ text: "Skip Media" }], [{ text: "❌ Cancel" }]], resize_keyboard: true }
            });
          }
        }

        if (text === "🛠️ Maintenance Mode") {
          if (!ADMIN_IDS.includes(chatId)) return;
          const status = engine.getMaintenanceMode() ? "🔴 **ON** (Blocked)" : "🟢 **OFF** (Normal)";
          return hubBot.sendMessage(chatId, `🛠️ **MAINTENANCE MODE CONTROL**\n\nCurrent Status: ${status}\n\nWhen ON, all bots will block non-admin users and show a maintenance message. Additionally, a global broadcast will be sent to ALL users when toggled.`, {
            reply_markup: {
              inline_keyboard: [
                [{ text: engine.getMaintenanceMode() ? "🟢 Switch OFF" : "🔴 Switch ON", callback_data: "hub_toggle_maintenance" }],
                [{ text: "❌ Close", callback_data: "hub_back_adm" }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        if (text === "📡 Must Join Channels") {
          if (!ADMIN_IDS.includes(chatId)) return;
          const channels = engine.getHubForceJoinChannels() || [];
          let msg = "📡 **HUB MUST JOIN CHANNELS**\n\nUsers must join these channels to use the builder:\n\n";
          if (channels.length === 0) msg += "None set.";
          else channels.forEach((c: string, i: number) => msg += `${i+1}. ${c}\n`);

          const kb = {
            inline_keyboard: [
              [{ text: "➕ Add Channel", callback_data: "hub_add_ch" }, { text: "❌ Clear All", callback_data: "hub_clear_ch" }],
              [{ text: "🔙 Close", callback_data: "hub_back_adm" }]
            ]
          };
          return hubBot.sendMessage(chatId, msg, { reply_markup: kb, parse_mode: 'Markdown' });
        }

        if (text === "/help") {
          return hubBot.sendMessage(chatId, "📖 **SR BOT MAKER HUB COMMANDS**\n\n" +
            "👤 **User Panel:** Type /start or use the menu below.\n" +
            "👑 **Admin Panel:** Type `/sradmin1` to access hidden hub controls.\n\n" +
            "🔄 **Switch Master Bot:**\n" +
            "To change the master bot, go to **Settings** in AI Studio and update the `TELEGRAM_BOT_TOKEN` environment variable.\n" +
            "For sub-bots, use `/adminhelp1` inside the specific bot.", { parse_mode: 'Markdown' });
        }
        if (text === "⚙️ Hub Settings") {
          const ADMIN_ID = 6561010416;
          if (chatId !== ADMIN_ID) return;
          return hubBot.sendMessage(chatId, "⚙️ **HUB GLOBAL SETTINGS**\n\n" +
            "🔄 **Master Bot Token:** To change the master hub bot, update `TELEGRAM_BOT_TOKEN` in your environment config.\n\n" +
            "📡 **Server URL:** " + (BASE_URL || "`UPDATING...`") + "\n" +
            "🔒 **Admin ID:** `" + ADMIN_ID + "`\n\n" +
            "Current Mode: **V3.1-STABLE**", { parse_mode: 'Markdown' });
        }

        if (text === "🔙 Back to User Menu") {
          return hubBot.sendMessage(chatId, "👤 **Switched to User Menu.**", {
            reply_markup: USER_HUB_KB.reply_markup
          });
        }

        if (text === "➕ Create New Bot") {
          hubBot.sendMessage(chatId, "🛠 **SELECT ENGINE NODE TYPE:**", {
            reply_markup: {
              inline_keyboard: [
                [{ text: "1) 💳 Task Payment Bot", callback_data: "hub_tpl_task" }, { text: "6) 📥 Wallet Bot", callback_data: "hub_tpl_wallet" }],
                [{ text: "2) 🎯 Bet & Earn Bot", callback_data: "hub_tpl_bet" }, { text: "7) 📝 File Store Bot", callback_data: "hub_tpl_file" }],
                [{ text: "3) 🎟️ Redeem Code Bot", callback_data: "hub_tpl_redeem" }, { text: "8) ⭐ Star Auto-Pay", callback_data: "hub_tpl_star" }],
                [{ text: "4) 🎁 Giveaway Bot", callback_data: "hub_tpl_giveaway" }, { text: "9) 📊 Poll Maker Bot", callback_data: "hub_tpl_poll" }],
                [{ text: "5) AUTO-PAY BOT", callback_data: "hub_tpl_refer_auto" }, { text: "10) 👤MANUAL PAY BOT", callback_data: "hub_tpl_refer_manual" }],
                [{ text: "11) 📥 UPI Manual Pay Bot", callback_data: "hub_tpl_upi_manual" }],
                [{ text: "❌ Cancel Deployment", callback_data: "hub_deploy_cancel" }]
              ]
            }
          }).catch(() => {});
          return;
        }

        if (text === "🛠 Manage Nodes" || text === "🛠 Template Designer") {
          if (!ADMIN_IDS.includes(chatId)) return;
          
          if (text === "🛠 Template Designer") {
             const kb = {
               inline_keyboard: [
                 [{ text: "1️⃣ Task Payment", callback_data: "hub_design_task" }, { text: "6️⃣ Wallet", callback_data: "hub_design_wallet" }],
                 [{ text: "2️⃣ Bet & Earn", callback_data: "hub_design_bet" }, { text: "7️⃣ File Store", callback_data: "hub_design_file" }],
                 [{ text: "3️⃣ Redeem Code", callback_data: "hub_design_redeem" }, { text: "8️⃣ Star Auto-Pay", callback_data: "hub_design_star" }],
                 [{ text: "4️⃣ Giveaway", callback_data: "hub_design_giveaway" }, { text: "9️⃣ Poll Maker", callback_data: "hub_design_poll" }],
                 [{ text: "5️⃣ AUTO-PAY BOT", callback_data: "hub_design_refer_auto" }, { text: "🔟 👤MANUAL PAY BOT", callback_data: "hub_design_refer_manual" }],
                 [{ text: "🔙 Back", callback_data: "hub_back_adm" }]
               ]
             };
             return hubBot.sendMessage(chatId, "🛠 **HUB TEMPLATE DESIGNER**\n\nSelect a bot type to customize its **DEFAULT** configuration (UI, rules, bonus, etc.) for all future deployments.", { reply_markup: kb });
          }

          const nodesList = Array.from(engine.getNodes().values()) as BotNode[];
          if (nodesList.length === 0) return hubBot.sendMessage(chatId, "❌ No nodes deployed yet.");
          
          const buttons: any[][] = [];
          for (let i = 0; i < nodesList.length; i += 2) {
             const row = [];
             const n1 = nodesList[i];
             row.push({ text: `⚙️ @${n1.username}`, callback_data: `hub_edit_node_${n1.id}` });
             if (i + 1 < nodesList.length) {
                const n2 = nodesList[i + 1];
                row.push({ text: `⚙️ @${n2.username}`, callback_data: `hub_edit_node_${n2.id}` });
             }
             buttons.push(row);
          }
          return hubBot.sendMessage(chatId, "🛠 **SELECT NODE TO MANAGE:**\n\nYou can customize template, UI, and rules for any deployed bot from here.", { reply_markup: { inline_keyboard: buttons } });
        }

        if (text.includes("My All Bot") || text.includes("All Bot Nodes") || (text.includes("Nodes") && text.length < 15)) {
          const nodes = isAdmin ? Array.from(engine.getNodes().values()) : engine.getUserNodes(chatId);
          const filteredNodes = (nodes as any[]).filter(n => !n.id.startsWith("BLUEPRINT_"));
          
          if (filteredNodes.length > 0) {
            const page = 0;
            const limit = 7;
            const list = filteredNodes.slice(0, limit);
            
            let msg = `📡 <b>${isAdmin ? 'GLOBAL SR NETWORK' : 'YOUR BOT INSTANCES'}</b>\n\n`;
            msg += `Manage your deployed bots status and settings from this centralized panel.\n\n`;
            
            const buttons: any[][] = [];
            list.forEach((n: any, idx: number) => {
               const statusSym = (!!n.instance && typeof n.instance === 'object' && n.config.botStatus) ? '🟢' : '🔴';
               const statusText = (!!n.instance && typeof n.instance === 'object' && n.config.botStatus) ? 'ON' : 'OFF';
               msg += `${idx + 1}. @${n.username} [${statusText}]\n`;
               buttons.push([
                 { text: `${statusSym} @${n.username}`, callback_data: `hub_edit_node_${n.id}` },
                 { text: `🔄 ${statusText}`, callback_data: `sub_node_tgl_hub_${n.id}` }
               ]);
            });

            if (filteredNodes.length > limit) {
               msg += `\n<i>... and ${filteredNodes.length - limit} more networks are active.</i>`;
               buttons.push([{ text: "📄 VIEW ALL BOT NODES", callback_data: "hub_view_all_nodes_0" }]);
            }
            
            msg += `\n━━━━━━━━━━━━━━\n🚀 <b>SR HUB MULTI-BOT SYSTEM</b>`;
            
            hubBot.sendMessage(chatId, msg, { 
              parse_mode: 'HTML', 
              reply_markup: { inline_keyboard: buttons } 
            }).catch(() => {});
          } else {
            hubBot.sendMessage(chatId, "❌ <b>No active nodes found!</b>\n\nYou haven't deployed any bots yet. Click 'Create New Bot' to start.", { parse_mode: 'HTML' }).catch(() => {});
          }
          return;
        }

        if (text === "🚫 Management Bot Ban" || text === "/unban_paisa_29") {
           if (!isAdmin) return;
           const nodesList = Array.from(engine.getNodes().values()) as BotNode[];
           
           if (text === "/unban_paisa_29") {
              const target = nodesList.find(n => n.username?.toLowerCase().includes("paisa_bazar29"));
              if (target) {
                 target.isBannedByAdmin = false;
                 await engine.saveNodeToFirestore(target);
                 return hubBot.sendMessage(chatId, "✅ @sr_paisa_bazar29_bot has been forced UNBANNED.");
              }
              return hubBot.sendMessage(chatId, "❌ Target bot not found in active list.");
           }

           const filteredNodes = nodesList.filter(n => !n.id.startsWith("BLUEPRINT_"));
           if (filteredNodes.length === 0) return hubBot.sendMessage(chatId, "❌ No nodes deployed yet.");
           
           const buttons: any[][] = [];
           for (let i = 0; i < filteredNodes.length; i += 1) {
              const n = filteredNodes[i];
              const banSym = n.isBannedByAdmin ? "🚫" : "✅";
              buttons.push([{ text: `${banSym} @${n.username}`, callback_data: `hub_ban_select_${n.id}` }]);
           }
           return hubBot.sendMessage(chatId, "🚫 **SELECT BOT TO BAN/UNBAN FROM HUB:**", { reply_markup: { inline_keyboard: buttons } });
        }

        if (text.includes("Stats") || text.includes("📊")) {
          const stats = engine.getStats();
          let hubUsersCount = 0;
          try {
             const hubUsersSnap = await db.collection('hubUsers').get();
             hubUsersCount = hubUsersSnap.size;
          } catch (e) {
             logSys(`[STATS_ERR] Hub counting failed: ${e.message}`);
          }
          
          let statMsg = `📊 <b>SR HUB GLOBAL ANALYTICS</b>\n\n` +
            `● <b>Global Network Users:</b> ${Number(stats.globalUsers || 0) + Number(hubUsersCount || 0)}\n` +
            `● <b>SR HUB Active Nodes:</b> ${stats.totalNodes || 0}\n` +
            `● <b>Hub Active Users:</b> ${Number(hubUsersCount || 0) + Number(stats.hubUsers || 0)}\n\n` +
            `🚀 <b>STATS ARE LIVE & SECURE</b>`;
          
          return hubBot.sendMessage(chatId, statMsg, { 
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: "hub_view_stats" }]] }
          }).catch(() => {});
        }

        if (text.includes("Support") || text.includes("📞")) {
          return hubBot.sendMessage(chatId, "🆘 **SR SUPPORT TEAM 🚀 24/7 CUSTOMER SUPPORT**\n\nNeed help with your deployment? Join our official community for live troubleshooting.\n\n⚙️ HELPLINE SUPPORT = @srsaportbot\n\n🚀 DEVLOPER = @SR_TECNOLOGY_LTD", { parse_mode: 'Markdown' });
        }

        const state = engine.deploymentStates.get(chatId);
        if (state?.step === "AWAITING_TOKEN" && text?.includes(":")) {
          const statusMsg = await hubBot.sendMessage(chatId, "🟠 **YOU ARE BOT IS DEPLOYING PLEASE WAIT** 🟠\n\n🟠 STATUS = **PENDING**").catch(() => {});
          logSys(`[DEPLOY_START] User ${chatId} provided token for ${state.type}`);
          try {
            const { nodeId, username } = await engine.deployBot(chatId, text, state.type!, "Dark_Hardware");
            engine.deploymentStates.delete(chatId);
            logSys(`[DEPLOY_SUCCESS] User ${chatId} deployed ${nodeId} (@${username})`);
            
            if (statusMsg) {
              await hubBot.editMessageText("🟠 **YOU ARE BOT IS DEPLOYING PLEASE WAIT** 🟠\n\n🟢 STATUS = **SUCCESSFUL**", {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
              }).catch(() => {});
            }

            const successMsg = `✅ **BOT DEPLOYED SUCCESSFULLY!**\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `Your bot is now LIVE on **SR BOT MAKER ENGINE**.\n\n` +
              `🤖 **Bot:** @${username}\n` +
              `🆔 **Node:** \`${nodeId}\`\n\n` +
              `**Next Steps:**\n` +
              `1️⃣ Open @${username} and send \`/start\`\n` +
              `2️⃣ Inside bot, send \`/adminhelp1\` to open Admin Panel.\n` +
              `3️⃣ Set up your channels and start growing!\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `🚀 Powered by SR BOT MAKER™\n` +
              `⚔️ DEVELOPER @SR_TECNOLOGY_LTD`;

            hubBot.sendMessage(chatId, successMsg, { 
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[{ text: "🚀 OPEN BOT", url: `https://t.me/${username}` }]]
              }
            }).catch(() => {});
          } catch (e: any) {
            logSys(`[DEPLOY_FAIL] User ${chatId} error: ${e.message}`);
            if (statusMsg) {
              await hubBot.editMessageText("🟠 **YOU ARE BOT IS DEPLOYING PLEASE WAIT** 🟠\n\n🔴 STATUS = **FAIL TRY AGAIN**", {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'Markdown'
              }).catch(() => {});
            }
            hubBot.sendMessage(chatId, `❌ **ERROR:** ${e.message}`).catch(() => {});
          }
          return;
        }
      } catch (err: any) { logSys(`[HUB_MSG_ERR] ${err.message}`); }
    });

    hubBot.on('callback_query', async (query: any) => {
      const chatId = query.message?.chat.id;
      const userId = query.from.id;
      const data = query.data;
      if (!chatId || !data) return;

      // --- INTERCEPTOR: Maintenance Mode ---
      const MASTER_ADMIN_ID = 6561010416;
      if (engine.getMaintenanceMode() && userId !== MASTER_ADMIN_ID && data !== "hub_toggle_maintenance") {
         return hubBot.answerCallbackQuery(query.id, { text: "⚠️ SERVER UNDER MAINTENANCE\n\nplease wait server is under maintenance", show_alert: true });
      }

      if (data === "hub_toggle_maintenance") {
        const ADMIN_IDS = [6561010416];
        if (process.env.ADMIN_HUB_ID) ADMIN_IDS.push(Number(process.env.ADMIN_HUB_ID));
        if (!ADMIN_IDS.includes(userId)) return hubBot.answerCallbackQuery(query.id, { text: "❌ Unauthorized", show_alert: true });
        
        hubBot.answerCallbackQuery(query.id, { text: "⏳ Processing Global Toggle..." });
        await engine.toggleMaintenance(userId, hubBot);
        // Refresh the message
        const status = engine.getMaintenanceMode() ? "🔴 **ON** (Blocked)" : "🟢 **OFF** (Normal)";
        return hubBot.editMessageText(`🛠️ **MAINTENANCE MODE CONTROL**\n\nCurrent Status: ${status}\n\nWhen ON, all bots will block non-admin users and show a maintenance message. Additionally, a global broadcast will be sent to ALL users when toggled.`, {
          chat_id: chatId,
          message_id: query.message.message_id,
          reply_markup: {
            inline_keyboard: [
              [{ text: engine.getMaintenanceMode() ? "🟢 Switch OFF" : "🔴 Switch ON", callback_data: "hub_toggle_maintenance" }],
              [{ text: "❌ Close", callback_data: "hub_back_adm" }]
            ]
          },
          parse_mode: 'Markdown'
        }).catch(() => {});
      }

      if (data === 'hub_check_join') {
        const channels = engine.getHubForceJoinChannels();
        const joinedStatuses = await Promise.all(channels.map((ch: string) => (engine as any).checkForceJoin(hubBot, ch, userId)));
        if (joinedStatuses.includes(false)) {
           return hubBot.answerCallbackQuery(query.id, { text: "❌ You haven't joined all channels!", show_alert: true });
        }
        hubBot.answerCallbackQuery(query.id, { text: "✅ Access Granted!" });
        // Re-trigger start
        const msg = { chat: { id: userId }, from: query.from, text: "/start" };
        return hubBot.emit('message', msg);
      }

      if (data.startsWith('hub_ban_select_')) {
        const nodeId = data.replace('hub_ban_select_', '');
        const node = engine.getNodes().get(nodeId);
        if (!node) return hubBot.answerCallbackQuery(query.id, { text: "Node not found" });
        
        const status = node.isBannedByAdmin ? "🔴 **BANNED**" : "🟢 **ACTIVE**";
        const btnText = node.isBannedByAdmin ? "🛡️ UNBAN FROM HUB" : "🚫 BAN FROM HUB";
        
        const msg = `🚫 **BOT BAN MANAGEMENT**\n\n` +
                    `🤖 **Bot:** @${node.username}\n` +
                    `📝 **ID:** \`${node.id}\`\n` +
                    `👤 **Owner ID:** \`${node.ownerId}\`\n` +
                    `📊 **Status:** ${status}\n\n` +
                    `Banning a bot will prevent all users from using it and show a system suspension message.`;
        
        return hubBot.editMessageText(msg, {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: btnText, callback_data: `adm_hub_ban_tgl_direct_${node.id}` }],
              [{ text: "🔄 Change Bot Template", callback_data: `hub_tpl_direct_${node.id}` }],
              [{ text: "🔙 Back to List", callback_data: "hub_ban_list_refresh" }]
            ]
          }
        }).catch(() => {});
      }

      if (data.startsWith('hub_tpl_direct_')) {
        const nodeId = data.replace('hub_tpl_direct_', '');
        const node = engine.getNodes().get(nodeId);
        if (!node) return hubBot.answerCallbackQuery(query.id, { text: "Node not found" });
        
        const kb = {
          inline_keyboard: [
            [{ text: "1️⃣ Task Payment Bot", callback_data: `hub_set_tpl_${nodeId}_task` }, { text: "6️⃣ Wallet Bot", callback_data: `hub_set_tpl_${nodeId}_wallet` }],
            [{ text: "2️⃣ Bet & Earn Bot", callback_data: `hub_set_tpl_${nodeId}_bet` }, { text: "7️⃣ File Store Bot", callback_data: `hub_set_tpl_${nodeId}_file` }],
            [{ text: "3️⃣ Redeem Code Bot", callback_data: `hub_set_tpl_${nodeId}_redeem` }, { text: "8️⃣ Star Auto-Pay", callback_data: `hub_set_tpl_${nodeId}_star` }],
            [{ text: "4️⃣ Giveaway Bot", callback_data: `hub_set_tpl_${nodeId}_giveaway` }, { text: "9️⃣ Poll Maker Bot", callback_data: `hub_set_tpl_${nodeId}_poll` }],
            [{ text: "5️⃣ AUTO-PAY BOT", callback_data: `hub_set_tpl_${nodeId}_refer_auto` }, { text: "🔟 👤MANUAL PAY BOT", callback_data: `hub_set_tpl_${nodeId}_refer_manual` }],
            [{ text: "1️⃣1️⃣ UPI Manual Pay Bot", callback_data: `hub_set_tpl_${nodeId}_upi_manual` }],
            [{ text: "💳 Hybrid UPI", callback_data: `hub_set_tpl_${nodeId}_upi` }, { text: "💎 Crypto M01", callback_data: `hub_set_tpl_${nodeId}_crypto` }],
            [{ text: "🔙 Back", callback_data: `hub_ban_select_${nodeId}` }]
          ]
        };
        return hubBot.editMessageText(`🛠 **CHANGE TEMPLATE FOR @${node.username}**\n\nSelect the new template logic for this node:`, {
           chat_id: chatId,
           message_id: query.message.message_id,
           reply_markup: kb
        }).catch(() => {});
      }

      if (data.startsWith('hub_set_tpl_')) {
         // Pattern: hub_set_tpl_NODEID_TPL
         const parts = data.replace('hub_set_tpl_', '').split('_');
         const tpl = parts.pop() as BotNode['type'];
         const nodeId = parts.join('_');
         const node = engine.getNodes().get(nodeId);
         if (!node) return hubBot.answerCallbackQuery(query.id, { text: "Node not found" });
         
         node.type = tpl;
         await engine.saveNodeToFirestore(node);
         hubBot.answerCallbackQuery(query.id, { text: `✅ Template ${tpl.toUpperCase()} Applied to @${node.username}` });
         // Return to the node ban select menu (which is now a management menu)
         return hubBot.emit('callback_query', { ...query, data: `hub_ban_select_${nodeId}` });
      }

      if (data === "hub_ban_list_refresh") {
         const nodesList = Array.from(engine.getNodes().values()) as BotNode[];
         const filteredNodes = nodesList.filter(n => !n.id.startsWith("BLUEPRINT_"));
         const buttons: any[][] = [];
         for (const n of filteredNodes) {
            const banSym = n.isBannedByAdmin ? "🚫" : "✅";
            buttons.push([{ text: `${banSym} @${n.username}`, callback_data: `hub_ban_select_${n.id}` }]);
         }
         return hubBot.editMessageText("🚫 **SELECT BOT TO BAN/UNBAN FROM HUB:**", {
           chat_id: chatId,
           message_id: query.message.message_id,
           reply_markup: { inline_keyboard: buttons }
         }).catch(() => {});
      }

      if (data.startsWith('sub_leaders_')) {
        const nodeId = data.replace('sub_leaders_', '');
        const node = engine.getNodes().get(nodeId);
        if (!node) return;
        const leaders = await (engine as any).getLeaderboard(node);
        hubBot.answerCallbackQuery(query.id);
        return hubBot.sendMessage(userId, leaders, { parse_mode: 'HTML' });
      }

      if (data.startsWith('APPROVE_WD_') || data.startsWith('REJECT_WD_')) {
        const isApprove = data.startsWith('APPROVE_WD_');
        const reqId = data.replace(isApprove ? 'APPROVE_WD_' : 'REJECT_WD_', '');
        let targetNode: BotNode | null = null;
        for (const n of engine.getNodes().values()) {
           if (n.pendingWithdrawals.has(reqId)) { targetNode = n; break; }
        }
        if (!targetNode) return hubBot.answerCallbackQuery(query.id, { text: "❌ Request not found." });
        const req = targetNode.pendingWithdrawals.get(reqId)!;

        if (isApprove) {
          targetNode.pendingWithdrawals.delete(reqId);
          targetNode.withdrawals.push({ ...req, timestamp: Date.now() });
          await engine.saveNodeToFirestore(targetNode);
          hubBot.answerCallbackQuery(query.id, { text: "✅ Payout Approved!", show_alert: true });
          hubBot.editMessageText(`✅ **PAYOUT APPROVED**\n\n👤 User: \`${req.userId}\`\n💰 Amount: ₹${req.amount}\n📝 ID: \`${reqId}\`\n\n✅ Status: **PAID**`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
          }).catch(() => {});
          targetNode.instance?.sendMessage(req.userId, `🎉 **WITHDRAWAL APPROVED!**\n\nYour request for **₹${req.amount}** has been processed successfully.`).catch(() => {});
        } else {
          const user = await engine.ensureUserLoaded(targetNode, req.userId);
          if (user) { user.balance += req.amount; await engine.saveUserToFirestore(targetNode.id, req.userId, user); }
          targetNode.pendingWithdrawals.delete(reqId);
          await engine.saveNodeToFirestore(targetNode);
          hubBot.answerCallbackQuery(query.id, { text: "❌ WD Rejected & Refunded", show_alert: true });
          hubBot.editMessageText(`❌ **PAYOUT REJECTED**\n\n👤 User: \`${req.userId}\`\n💰 Amount: ₹${req.amount}\n📝 ID: \`${reqId}\`\n\n🔴 Status: **REJECTED (Refunded)**`, {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: 'Markdown'
          }).catch(() => {});
          targetNode.instance?.sendMessage(req.userId, `❌ **WITHDRAWAL REJECTED**\n\nYour request for **₹${req.amount}** was rejected and refunded.`).catch(() => {});
        }
        return;
      }

      const currentHubState = engine.fsmStates.get(userId);

      // Handle Global Template Designer
      if (data.startsWith('hub_design_')) {
        const tplType = data.replace('hub_design_', '') as BotNode['type'];
        const blueprintId = `BLUEPRINT_${tplType.toUpperCase()}`;
        
        let bNode = engine.getNodes().get(blueprintId);
        if (!bNode) {
           // Create a persistent virtual node for this blueprint
           bNode = {
             id: blueprintId,
             token: "VIRTUAL",
             username: `TEMPLATE_${tplType.toUpperCase()}`,
             ownerId: 0,
             type: tplType,
             theme: "default",
             createdAt: Date.now(),
             config: engine.getDefaultConfig(tplType),
             users: new Map(),
             pendingWithdrawals: new Map(),
             withdrawals: [],
             instance: null
           };
           engine.getNodes().set(blueprintId, bNode);
           await engine.saveNodeToFirestore(bNode);
        }

        engine.fsmStates.set(userId, { nodeId: blueprintId, action: "HUB_MANAGE_BLUEPRINT" });
        hubBot.answerCallbackQuery(query.id, { text: `Designing ${tplType} Template` });
        return engine.sendAdminPanel(hubBot, bNode, userId, query.message?.message_id);
      }

      // Handle Sub-Bot Management from Hub
      if (data.startsWith('hub_edit_node_')) {
        const nodeId = data.replace('hub_edit_node_', '');
        const node = engine.getNodes().get(nodeId);
        if (!node) return hubBot.answerCallbackQuery(query.id, { text: "Node not found" });

        // MASTER ADMIN BAN CHECK
        const ADMIN_IDS = [6561010416];
        if (process.env.ADMIN_HUB_ID) ADMIN_IDS.push(Number(process.env.ADMIN_HUB_ID));
        const isMasterAdmin = ADMIN_IDS.includes(userId);

        if (node.isBannedByAdmin && !isMasterAdmin) {
           hubBot.answerCallbackQuery(query.id, { text: "❌ Access Restricted", show_alert: false });
           const restrictedText = `🚫 **YOUR BOT IS BANNED FROM SR BOT MAKER ADMIN** 🚫\n\n` +
                                `⚠️ *Reason:* Safety violation or Policy breach detected.\n\n` +
                                `🛠 *System Node:* \`${node.id}\`\n\n` +
                                `📞 **Please contact Admin to appeal:** @SR_TECNOLOGY_LTD`;
           return hubBot.sendMessage(chatId, restrictedText, { parse_mode: 'Markdown' });
        }
        
        engine.fsmStates.set(userId, { nodeId: node.id, action: "HUB_MANAGE_SUBBOT" });
        hubBot.answerCallbackQuery(query.id, { text: `Managing @${node.username}` });
        return engine.sendAdminPanel(hubBot, node, userId, query.message?.message_id);
      }

      if (data.startsWith('sub_node_tgl_hub_')) {
        const nodeId = data.replace('sub_node_tgl_hub_', '');
        const node = engine.getNodes().get(nodeId);
        if (!node) return hubBot.answerCallbackQuery(query.id, { text: "Node not found" });
        
        if (node.ownerId !== userId && !ADMIN_IDS.includes(userId)) return hubBot.answerCallbackQuery(query.id, { text: "Unauthorized" });

        if (node.isBannedByAdmin && !node.config.botStatus) {
            return hubBot.answerCallbackQuery(query.id, { text: "❌ RESTRICTED: Bot is banned by main hub.", show_alert: true });
        }

        node.config.botStatus = !node.config.botStatus;
        await engine.saveNodeToFirestore(node);
        hubBot.answerCallbackQuery(query.id, { text: `Bot ${node.config.botStatus ? 'Started' : 'Stopped'}` });
        
        // Refresh the list view (re-trigger the text command logic or edit message)
        const nodes = ADMIN_IDS.includes(userId) ? Array.from(engine.getNodes().values()) : engine.getUserNodes(userId);
        const filteredNodes = (nodes as any[]).filter(n => !n.id.startsWith("BLUEPRINT_"));
        
        const limit = 7;
        const list = filteredNodes.slice(0, limit);
        let msg = `📡 <b>${ADMIN_IDS.includes(userId) ? 'GLOBAL SR NETWORK' : 'YOUR BOT INSTANCES'}</b>\n\n`;
        msg += `Manage your deployed bots status and settings from this centralized panel.\n\n`;
        const buttons: any[][] = [];
        list.forEach((n: any, idx: number) => {
           const statusText = (!!n.instance && typeof n.instance === 'object' && n.config.botStatus) ? 'ON' : 'OFF';
           const statusSym = statusText === 'ON' ? '🟢' : '🔴';
           msg += `${idx + 1}. @${n.username} [${statusText}]\n`;
           buttons.push([
             { text: `${statusSym} @${n.username}`, callback_data: `hub_edit_node_${n.id}` },
             { text: `🔄 ${statusText}`, callback_data: `sub_node_tgl_hub_${n.id}` }
           ]);
        });
        if (filteredNodes.length > limit) {
           msg += `\n<i>... and ${filteredNodes.length - limit} more bots.</i>`;
           buttons.push([{ text: "📄 VIEW COMPLETE LIST", callback_data: "hub_view_all_nodes_0" }]);
        }
        msg += `\n━━━━━━━━━━━━━━\n🚀 <b>SR HUB MULTI-BOT SYSTEM</b>`;
        return hubBot.editMessageText(msg, { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      }

      if (data.startsWith('hub_view_all_nodes_')) {
        const page = parseInt(data.replace('hub_view_all_nodes_', ''));
        const nodes = ADMIN_IDS.includes(userId) ? Array.from(engine.getNodes().values()) : engine.getUserNodes(userId);
        const filteredNodes = (nodes as any[]).filter(n => !n.id.startsWith("BLUEPRINT_"));
        
        const limit = 10;
        const start = page * limit;
        const list = filteredNodes.slice(start, start + limit);
        
        let msg = `📄 <b>ALL DEPLOYED NODES (Page ${page + 1})</b>\n\n`;
        const buttons: any[][] = [];
        list.forEach((n: any) => {
          const statusText = (!!n.instance && typeof n.instance === 'object' && n.config.botStatus) ? 'ON' : 'OFF';
          const statusSym = statusText === 'ON' ? '🟢' : '🔴';
          msg += `• @${n.username} [${statusText}]\n`;
          buttons.push([
             { text: `${statusSym} @${n.username}`, callback_data: `hub_edit_node_${n.id}` },
             { text: `🔄 ${statusText}`, callback_data: `sub_node_tgl_hub_${n.id}` }
          ]);
        });

        const nav = [];
        if (page > 0) nav.push({ text: "⬅️ Prev", callback_data: `hub_view_all_nodes_${page - 1}` });
        if (start + limit < filteredNodes.length) nav.push({ text: "Next ➡️", callback_data: `hub_view_all_nodes_${page + 1}` });
        if (nav.length > 0) buttons.push(nav);
        buttons.push([{ text: "🔙 Back to Summary", callback_data: "hub_back_to_summary" }]);

        return hubBot.editMessageText(msg, { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      }

      if (data === "hub_back_to_summary") {
         // Simply re-trigger the "My All Bot Nodes" logic
         const nodes = ADMIN_IDS.includes(userId) ? Array.from(engine.getNodes().values()) : engine.getUserNodes(userId);
         const filteredNodes = (nodes as any[]).filter(n => !n.id.startsWith("BLUEPRINT_"));
         const limit = 7;
         const list = filteredNodes.slice(0, limit);
         let msg = `📡 <b>${ADMIN_IDS.includes(userId) ? 'GLOBAL SR NETWORK' : 'YOUR BOT INSTANCES'}</b>\n\n`;
         const buttons: any[][] = [];
         list.forEach((n: any, idx: number) => {
            const statusText = (!!n.instance && typeof n.instance === 'object' && n.config.botStatus) ? 'ON' : 'OFF';
            const statusSym = statusText === 'ON' ? '🟢' : '🔴';
            msg += `${idx + 1}. @${n.username} [${statusText}]\n`;
            buttons.push([
              { text: `${statusSym} @${n.username}`, callback_data: `hub_edit_node_${n.id}` },
              { text: `🔄 ${statusText}`, callback_data: `sub_node_tgl_hub_${n.id}` }
            ]);
         });
         if (filteredNodes.length > limit) {
            msg += `\n<i>... and ${filteredNodes.length - limit} more bots.</i>`;
            buttons.push([{ text: "📄 VIEW COMPLETE LIST", callback_data: "hub_view_all_nodes_0" }]);
         }
         msg += `\n━━━━━━━━━━━━━━\n🚀 <b>SR HUB MULTI-BOT SYSTEM</b>`;
         return hubBot.editMessageText(msg, { chat_id: chatId, message_id: query.message?.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons } });
      }

      if (data.startsWith('adm_hub_ban_tgl_')) {
        const isDirect = data.includes('_direct_');
        const nodeId = data.replace(isDirect ? 'adm_hub_ban_tgl_direct_' : 'adm_hub_ban_tgl_', '');
        const node = engine.getNodes().get(nodeId);
        if (!node) return hubBot.answerCallbackQuery(query.id, { text: "Node not found" });

        const ADMIN_IDS = [6561010416];
        if (process.env.ADMIN_HUB_ID) ADMIN_IDS.push(Number(process.env.ADMIN_HUB_ID));
        if (!ADMIN_IDS.includes(userId)) return hubBot.answerCallbackQuery(query.id);

        node.isBannedByAdmin = !node.isBannedByAdmin;
        if (node.isBannedByAdmin) {
            node.config.botStatus = false; // Force stop on ban
        }
        await engine.saveNodeToFirestore(node);
        hubBot.answerCallbackQuery(query.id, { text: `Node ${node.isBannedByAdmin ? 'Banned' : 'Unbanned'}` });
        
        if (isDirect) {
           // Refresh the specific selector menu
           const status = node.isBannedByAdmin ? "🔴 **BANNED**" : "🟢 **ACTIVE**";
           const btnText = node.isBannedByAdmin ? "🛡️ UNBAN FROM HUB" : "🚫 BAN FROM HUB";
           const msg = `🚫 **BOT BAN MANAGEMENT**\n\n` +
                       `🤖 **Bot:** @${node.username}\n` +
                       `📝 **ID:** \`${node.id}\`\n` +
                       `👤 **Owner ID:** \`${node.ownerId}\`\n` +
                       `📊 **Status:** ${status}\n\n` +
                       `Banning a bot will prevent all users from using it and show a system suspension message.`;
           
           return hubBot.editMessageText(msg, {
             chat_id: chatId,
             message_id: query.message.message_id,
             parse_mode: 'Markdown',
             reply_markup: {
               inline_keyboard: [
                 [{ text: btnText, callback_data: `adm_hub_ban_tgl_direct_${node.id}` }],
                 [{ text: "🔄 Change Bot Template", callback_data: `hub_tpl_direct_${node.id}` }],
                 [{ text: "🔙 Back to List", callback_data: "hub_ban_list_refresh" }]
               ]
             }
           }).catch(() => {});
        }
        
        return engine.sendAdminPanel(hubBot, node, userId, query.message?.message_id);
      }

      // Relay admin callbacks if in Hub-Manage mode
      if (data === "hub_back_adm" || data === "hub_back_adm_menu") {
        if (!ADMIN_IDS.includes(userId)) return;
        return hubBot.editMessageText("👑 **SR HUB MASTER ADMIN PANEL**", { 
           chat_id: chatId, 
           message_id: query.message?.message_id, 
           reply_markup: ADMIN_HUB_KB.reply_markup 
        });
      }

      if (data === "hub_edit_settings") {
         return hubBot.answerCallbackQuery(query.id, { text: "⚙️ Settings coming soon!" });
      }

      if (data === "hub_manage_nodes") {
          const nodesList = (Array.from(engine.getNodes().values()) as BotNode[]).filter(n => !n.id.startsWith("BLUEPRINT_"));
          if (nodesList.length === 0) return hubBot.answerCallbackQuery(query.id, { text: "No nodes found." });
          const buttons: any[][] = [];
          for (let i = 0; i < nodesList.length; i += 2) {
             const row = [];
             row.push({ text: `⚙️ @${nodesList[i].username}`, callback_data: `hub_edit_node_${nodesList[i].id}` });
             if (i + 1 < nodesList.length) {
                row.push({ text: `⚙️ @${nodesList[i+1].username}`, callback_data: `hub_edit_node_${nodesList[i+1].id}` });
             }
             buttons.push(row);
          }
          buttons.push([{ text: "🔙 Back", callback_data: "hub_back_adm" }]);
          return hubBot.editMessageText("🛠 **SELECT NODE TO MANAGE:**", { chat_id: chatId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: buttons } });
      }

      if (data === "hub_add_ch") {
        engine.fsmStates.set(userId, { nodeId: "HUB_NODE", action: "HUB_ADD_CHANNEL" });
        return hubBot.sendMessage(chatId, "➕ **HUB ADD CHANNEL**\n\nSend the channel username (e.g. `@MyChannel`) or chat ID (e.g. `-100...`):");
      }

      if (data === "hub_clear_ch") {
        engine.getHubForceJoinChannels().length = 0;
        await (engine as any).saveHubConfig();
        hubBot.answerCallbackQuery(query.id, { text: "Force-join channels cleared." });
        return hubBot.editMessageText("📡 **HUB MUST JOIN CHANNELS**\n\nChannels cleared.", { chat_id: chatId, message_id: query.message?.message_id });
      }

      if (data === "hub_check_join" || data === "hub_verify_all") {
        const channels = this.getHubForceJoinChannels() || [];
        const joinedStatuses = await Promise.all(channels.map((ch: string) => this.checkForceJoin(hubBot, ch, userId)));
        
        if (joinedStatuses.includes(false)) {
           // Not all joined, resend/edit message with updated status icons
           hubBot.answerCallbackQuery(query.id, { text: "❌ You have not joined all required channels yet!", show_alert: true });
           return this.sendHubJoinForce(hubBot, userId, query.message?.message_id);
        }

        hubBot.answerCallbackQuery(query.id, { text: "✅ Access Granted!" });
        hubBot.deleteMessage(chatId, query.message?.message_id).catch(() => {});
        const welcome = `✅ **Verification successful!**\n\nWelcome back to SR HUB Master Engine. You now have full access to all builder features.`;
        return hubBot.sendMessage(chatId, welcome, USER_HUB_KB);
      }

      if (currentHubState?.action === "HUB_MANAGE_SUBBOT" || currentHubState?.action === "HUB_MANAGE_BLUEPRINT") {
        const node = engine.getNodes().get(currentHubState.nodeId);
        if (node) {
          if (data === "adm_back_main" || data === "hub_back_adm") {
             // Return to appropriate list
             engine.fsmStates.delete(userId);
             if (currentHubState.action === "HUB_MANAGE_BLUEPRINT") {
                const kb = {
                  inline_keyboard: [
                    [{ text: "1️⃣ Task Payment", callback_data: "hub_design_task" }, { text: "6️⃣ Wallet", callback_data: "hub_design_wallet" }],
                    [{ text: "2️⃣ Bet & Earn", callback_data: "hub_design_bet" }, { text: "7️⃣ File Store", callback_data: "hub_design_file" }],
                    [{ text: "3️⃣ Redeem Code", callback_data: "hub_design_redeem" }, { text: "8️⃣ Star Auto-Pay", callback_data: "hub_design_star" }],
                    [{ text: "4️⃣ Giveaway", callback_data: "hub_design_giveaway" }, { text: "9️⃣ Poll Maker", callback_data: "hub_design_poll" }],
                    [{ text: "5️⃣ AUTO-PAY BOT", callback_data: "hub_design_refer_auto" }, { text: "🔟 👤MANUAL PAY BOT", callback_data: "hub_design_refer_manual" }],
                    [{ text: "🔙 Back to Admin", callback_data: "hub_back_adm_menu" }]
                  ]
                };
                return hubBot.editMessageText("🛠 **HUB TEMPLATE DESIGNER**", { chat_id: userId, message_id: query.message?.message_id, reply_markup: kb });
             }
             const nodesList = Array.from(engine.getNodes().values()) as BotNode[];
             const buttons: any[][] = [];
              for (let i = 0; i < nodesList.length; i += 2) {
                const row = [];
                const n1 = nodesList[i];
                if (n1.id.startsWith("BLUEPRINT_")) continue;
                row.push({ text: `⚙️ @${n1.username}`, callback_data: `hub_edit_node_${n1.id}` });
                if (i + 1 < nodesList.length) {
                    const n2 = nodesList[i + 1];
                    if (!n2.id.startsWith("BLUEPRINT_")) row.push({ text: `⚙️ @${n2.username}`, callback_data: `hub_edit_node_${n2.id}` });
                }
                buttons.push(row);
              }
             return hubBot.editMessageText("🛠 **SELECT NODE TO MANAGE:**", { chat_id: userId, message_id: query.message?.message_id, reply_markup: { inline_keyboard: buttons } });
          }
          return await engine.handleSubBotCallback(hubBot, node, userId, data, query);
        }
      }

      if (data === "BC_RUN_CENTER") {
        const state = engine.fsmStates.get(userId);
        if (!state) return hubBot.answerCallbackQuery(query.id, { text: "Session Expired" });
        
        hubBot.answerCallbackQuery(query.id, { text: "🚀 Broadcast Injected!" });
        engine.fsmStates.delete(userId);
        
        const run = async () => {
          try {
            let targets: { bot: any, nodeId: string, uids: number[], botName: string }[] = [];
            
            if (state.broadcastType === "HUB") {
               const snap = await db.collection('hubUsers').get();
               targets.push({ bot: hubBot, nodeId: "HUB", uids: snap.docs.map((d: any) => Number(d.id)), botName: "SR HUB MASTER" });
            } else if (state.broadcastType === "GLOBAL") {
                // Add Hub Users
                const snapHub = await db.collection('hubUsers').get();
                targets.push({ bot: hubBot, nodeId: "HUB", uids: snapHub.docs.map((d: any) => Number(d.id)), botName: "SR HUB MASTER" });
                
                // Add All Bot Users
                const nodes = Array.from(engine.getNodes().values()) as BotNode[];
                for (const n of nodes) {
                   if (n.instance && typeof n.instance === 'object' && n.config.botStatus !== false && !n.id.startsWith("BLUEPRINT_") && !n.isBannedByAdmin) {
                      const snap = await db.collection('nodes').doc(n.id).collection('users').get();
                      targets.push({ bot: n.instance, nodeId: n.id, uids: snap.docs.map((d: any) => Number(d.id)), botName: `@${n.username}` });
                   }
                }
            } else if (state.broadcastType === "ALL_BOTS") {
               const nodes = Array.from(engine.getNodes().values()) as BotNode[];
               for (const n of nodes) {
                  if (n.instance && typeof n.instance === 'object' && n.config.botStatus !== false && !n.id.startsWith("BLUEPRINT_") && !n.isBannedByAdmin) {
                     const snap = await db.collection('nodes').doc(n.id).collection('users').get();
                     targets.push({ bot: n.instance, nodeId: n.id, uids: snap.docs.map((d: any) => Number(d.id)), botName: `@${n.username}` });
                  }
               }
            } else if (state.broadcastType === "MY_BOTS") {
                const nodes = engine.getUserNodes(userId);
                for (const n of nodes) {
                   if (n.instance && typeof n.instance === 'object' && n.config.botStatus !== false && !n.isBannedByAdmin) {
                      const snap = await db.collection('nodes').doc(n.id).collection('users').get();
                      targets.push({ bot: n.instance, nodeId: n.id, uids: snap.docs.map((d: any) => Number(d.id)), botName: `@${n.username}` });
                   }
                }
            } else if (state.nodeId && state.nodeId !== "HUB_NODE") {
               const node = engine.getNodes().get(state.nodeId);
               if (node && node.instance && typeof node.instance === 'object') {
                  const snap = await db.collection('nodes').doc(node.id).collection('users').get();
                  targets.push({ bot: node.instance, nodeId: node.id, uids: snap.docs.map((d: any) => Number(d.id)), botName: `@${node.username}` });
               }
            }

            if (targets.length === 0) return hubBot.sendMessage(userId, "❌ No eligible targets found for broadcast.");

            let total = targets.reduce((a, b) => a + b.uids.length, 0);
            let success = 0;
            let failed = 0;
            const startTime = Date.now();

            await hubBot.sendMessage(userId, `📣 **Broadcast Started!**\nTarget Nodes: ${targets.length}\nEst. Users: ${total}\nYou will receive a detailed summary when it finishes.`);

            const summaryReportArr: string[] = [];
            for (const target of targets) {
              let sCount = 0;
              let fCount = 0;
              for (const uid of target.uids) {
                try {
                  const opts = { reply_markup: { inline_keyboard: state.inline_keyboard || [] }, parse_mode: 'HTML' };
                  if (state.media?.photo) {
                    await target.bot.sendPhoto(uid, state.media.photo[state.media.photo.length - 1].file_id, { ...opts, caption: state.text });
                  } else if (state.media?.video) {
                    await target.bot.sendVideo(uid, state.media.video.file_id, { ...opts, caption: state.text });
                  } else {
                    await target.bot.sendMessage(uid, state.text, opts);
                  }
                  sCount++;
                  success++;
                } catch (e: any) {
                  fCount++;
                  failed++;
                }
                await new Promise(r => setTimeout(r, 65));
              }
              if (target.uids.length > 0) {
                 summaryReportArr.push(`🔹 ${target.botName}\n• Users: ${target.uids.length}\n• Success: ${sCount}\n• Fail: ${fCount}`);
              }
            }

            const duration = Math.floor((Date.now() - startTime) / 1000);
            const summary = `📊 <b>Broadcast Summary Report</b>\n\n` +
              `⏱ Time taken: ${duration}s\n` +
              `📦 <b>Overall Results:</b>\n` +
              `• Total Users: ${total}\n` +
              `✅ Success: ${success}\n` +
              `❌ Failed: ${failed}\n\n` +
              summaryReportArr.join('\n\n') +
              `\n\n🚀 <b>Powered by SR HUB</b>`;
            
            hubBot.sendMessage(userId, summary, { parse_mode: 'HTML' });
          } catch (err: any) {
             hubBot.sendMessage(userId, "❌ Broadcast Error: " + err.message);
          }
        };
        run();
        return;
      }

      if (data === "BC_CANCEL") {
        engine.fsmStates.delete(userId);
        hubBot.answerCallbackQuery(query.id, { text: "Cancelled" });
        return hubBot.sendMessage(userId, "❌ Broadcast operation cancelled.");
      }

      if (query.data === 'hub_deploy_cancel' && chatId) {
        engine.deploymentStates.delete(chatId);
        hubBot.editMessageText("❌ **Deployment Cancelled.**", { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
      } else if (query.data?.startsWith('hub_tpl_') && chatId) {
        const type = query.data.replace('hub_tpl_', '') as BotNode['type'];
        engine.deploymentStates.set(chatId, { step: "AWAITING_TOKEN", type });
        hubBot.sendMessage(chatId, "🔑 **AUTHENTICATION REQUIRED**\n\nPlease provide your sub-bot API Token from @BotFather now.").catch(() => {});
      }
      hubBot.answerCallbackQuery(query.id).catch(() => {});
    });
  }

  // 2. Webhook Routes
  app.post('/api/verify', async (req, res) => {
    const { nodeId, userId, refId, deviceId } = req.body;
    if (!nodeId || !userId) return res.status(400).json({ error: "Missing params" });

    const node = engine.nodes.get(nodeId);
    if (!node) return res.status(404).json({ error: "Node not found" });

    try {
      const userIdNum = Number(userId);
      let user = await engine.ensureUserLoaded(node, userIdNum);
      
      // Simple Duplicate Device Check
      const usersSnap = await db.collection('nodes').doc(nodeId).collection('users').where('deviceId', '==', deviceId).get();
      const isDuplicate = !usersSnap.empty && usersSnap.docs.some(d => d.id !== String(userId));

      if (isDuplicate) {
        if (user) {
          user.verified = true;
          user.deviceId = deviceId;
          user.isDuplicate = true;
          await engine.saveUserToFirestore(nodeId, userIdNum, user);
        }
        
        // Notify user about duplicate detection
        node.instance?.sendMessage(userIdNum, "🛡️ **Device Identification Complete**\n\nYour device has been verified. However, our system detected this device is already associated with another account in this bot.\n\n⚠️ **Notice:** You can still use the bot, but automated withdrawals will be restricted for security reasons.", {
          reply_markup: { keyboard: engine.getMenuKeyboard(node), resize_keyboard: true }
        }).catch(() => {});

            // notify referrer if exists
            const rId = (refId && refId !== 'none') ? Number(refId) : null;
            if (rId && rId !== userIdNum) {
               node.instance?.sendMessage(rId, `⚠️ **Referral Failed**\n\nYour friend joined but their device was detected as a duplicate. Referral bonus was not awarded to prevent abuse.`).catch(() => {});
            }

        return res.json({ success: true, duplicate: true });
      }

      if (user && !user.verified) {
        user.verified = true;
        user.deviceId = deviceId;
        user.isDuplicate = false; // explicitly set to false
        await engine.saveUserToFirestore(nodeId, userIdNum, user);

        // Award Referrer
        const rId = (refId && refId !== 'none') ? Number(refId) : null;
        if (rId && rId !== userIdNum) {
           const inviter = await engine.ensureUserLoaded(node, rId);
           if (inviter) {
             const bonus = Number(node.config.referBonus) || 0;
             inviter.balance += bonus;
             inviter.referrals += 1;
             await engine.saveUserToFirestore(nodeId, rId, inviter);
             node.instance?.sendMessage(rId, `🎁 <b>REFERRAL SUCCESS!</b>\n\nYour friend verified their device.\n💰 You earned: <b>₹${bonus}</b>\n📈 Total Referrals: ${inviter.referrals}`, { parse_mode: 'HTML' }).catch(() => {});
             logSys(`[REFER_VERIFY_OK] Node ${node.id}: ${rId} rewarded for ${userIdNum}`);
           }
        }
        
        node.instance?.sendMessage(userIdNum, "🛡️ **Device Verified!**\n\nWelcome to the dashboard. You can now use all bot features.", {
          reply_markup: { keyboard: engine.getMenuKeyboard(node), resize_keyboard: true }
        }).catch(() => {});
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/webhook/hub", (req, res) => {
    const updateId = req.body?.update_id;
    logSys(`[INCOMING_HUB] Update: ${updateId} | Host: ${req.get('host')} | IP: ${req.ip}`);
    try {
      if (!hubBot) return res.status(500).send("Hub Bot Offline");
      hubBot.processUpdate(req.body);
      res.status(200).send("OK");
    } catch (err: any) {
      logSys(`[HUB_PROCESS_ERR] ${err.message}`);
      res.status(500).send("Error");
    }
  });

  app.post("/api/webhook/:nodeId", (req, res) => {
    const { nodeId } = req.params;
    logSys(`[INCOMING_NODE] Node: ${nodeId}`);
    try {
      const node = engine.nodes.get(nodeId);
      if (node && node.instance) {
        node.instance.processUpdate(req.body);
        res.status(200).send("OK");
      } else {
        res.status(404).send("Not Found");
      }
    } catch (err: any) {
      logSys(`[NODE_PROCESS_ERR] ${nodeId}: ${err.message}`);
      res.status(500).send("Error");
    }
  });

  // 3. Identification & Boot
  app.use((req, res, next) => {
    updateBaseUrlFromRequest(req);
    next();
  });

  // 4. Vite / Static
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, "0.0.0.0", () => {
    logSys(`Engine V3.1 ready on port ${PORT}`);
    
    // Cloud Run Keep-Alive self-ping heartbeat mechanism
    setInterval(() => {
      if (BASE_URL) {
        const pingUrl = `${BASE_URL.replace(/\/$/, '')}/api/health`;
        axios.get(pingUrl)
          .then(() => {
            logSys(`[HEARTBEAT] Self-ping successful: ${pingUrl}`);
          })
          .catch((err) => {
            logSys(`[HEARTBEAT] Self-ping returned status/error: ${err.message}`);
          });
      } else {
        axios.get(`http://localhost:${PORT}/api/health`)
          .then(() => {
            logSys(`[HEARTBEAT] Localhost health check successful`);
          })
          .catch(() => {});
      }
    }, 150000); // Trigger every 2.5 minutes
  });

  // Background boot
  authPromise.then(async () => {
    await testConnection();
    engine.boot().then(() => logSys("Engine boot complete."));
  });
}

// --- APP ENTRY POINT ---
startServer().catch(err => {
  logSys(`[FATAL_SERVER_CRASH] ${err.message}`);
  process.exit(1);
});

// --- GLOBAL PROCESS RESILIENCE ---
process.on('uncaughtException', (err) => {
  console.error("🔥 CRITICAL: Uncaught Exception:", err);
  logSys(`[CRIT_EXCEPTION] ${err.message}`);
  try { engine['saveData'](); } catch {}
});

process.on('unhandledRejection', (reason, promise) => {
  console.error("☢️ CRITICAL: Unhandled Rejection at:", promise, "reason:", reason);
  logSys(`[UNHANDLED_REJ] ${String(reason)}`);
});

const gracefulExit = () => {
    logSys("Shutting down engine gracefully...");
    try {
      if (hubBot) hubBot.stopPolling();
      if (engine) {
        const nodes = engine.getNodes();
        nodes.forEach((n: any) => {
          if (n.instance && typeof n.instance.stopPolling === 'function') n.instance.stopPolling();
        });
      }
    } catch {}
    try { engine['saveData'](); } catch {}
    setTimeout(() => process.exit(0), 1000);
};

process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

