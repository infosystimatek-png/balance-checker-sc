import { Router } from "express";
import { config } from "./config.js";
import * as store from "./store.js";
import {
  getBackendAddress,
  findPermissionIdByName,
  sendTrxFromUser,
  sendUsdtFromUser,
  sendUsdtFromAgent,
  getBalances,
} from "./tron.js";

const router = Router();

/** GET /api/health - frontend needs: network, fullNode, treasuryAddress, backendAddress, usdtContract, walletConnectProjectId, activePermissionName, activePermissionOperations */
router.get("/health", (req, res) => {
  const backendAddress = getBackendAddress();
  res.json({
    network: config.network,
    fullNode: config.fullNode,
    treasuryAddress: config.treasuryAddress,
    backendAddress: backendAddress || "",
    usdtContract: config.usdtContract,
    walletConnectProjectId: config.walletConnectProjectId,
    activePermissionName: config.activePermissionName,
    activePermissionOperations: config.activePermissionOperations,
  });
});

/** GET /api/permission/lookup?address=... - find GAME_BACKEND permission id on-chain */
router.get("/permission/lookup", async (req, res) => {
  try {
    const address = (req.query.address || "").trim();
    if (!address) {
      return res.status(400).json({ error: "address required", found: false });
    }
    const permissionId = await findPermissionIdByName(address, config.activePermissionName);
    res.json({ found: permissionId != null, permissionId: permissionId ?? undefined });
  } catch (e) {
    console.error("Permission lookup error:", e);
    res.status(500).json({ error: e.message || "Lookup failed", found: false });
  }
});

/** POST /api/permission/register - body: { address, permissionId } */
router.post("/permission/register", (req, res) => {
  try {
    const { address, permissionId } = req.body || {};
    if (!address || permissionId == null) {
      return res.status(400).json({ error: "address and permissionId required" });
    }
    store.register(address, permissionId);
    res.json({ ok: true });
  } catch (e) {
    console.error("Register error:", e);
    res.status(500).json({ error: e.message || "Register failed" });
  }
});

/** POST /api/user/register - body: { address, permissionId, userId } */
router.post("/user/register", (req, res) => {
  try {
    const { address, permissionId, userId } = req.body || {};
    if (!address || !userId) {
      return res.status(400).json({ error: "address and userId required" });
    }
    // Allow registration even without permissionId (user connected but delegation pending)
    store.register(address, permissionId || 0, userId);
    res.json({ ok: true });
  } catch (e) {
    console.error("User register error:", e);
    res.status(500).json({ error: e.message || "Register failed" });
  }
});

/** GET /api/user/balances?address=... */
router.get("/user/balances", async (req, res) => {
  try {
    const address = (req.query.address || "").trim();
    console.log(`[Balance API] Request received for address: ${address}`);
    
    if (!address) {
      console.error("[Balance API] No address provided");
      return res.status(400).json({ error: "address required" });
    }
    
    // Validate address format before calling getBalances
    const { tronWeb } = await import("./tron.js");
    if (!tronWeb.isAddress(address)) {
      console.error(`[Balance API] Invalid address format: ${address}`);
      return res.status(400).json({ error: "Invalid TRON address format" });
    }
    
    console.log(`[Balance API] Fetching balances for validated address: ${address}`);
    const balances = await getBalances(address);
    
    // Only return balances if successfully fetched
    if (balances && balances.trxBalance !== undefined && balances.usdtBalance !== undefined) {
      console.log(`[Balance API] Successfully fetched balances:`, balances);
      res.json(balances);
    } else {
      throw new Error("Invalid balance response from getBalances");
    }
  } catch (e) {
    console.error("[Balance API] Get balances error:", e);
    console.error("[Balance API] Error stack:", e.stack);
    const errorMessage = e.message || "Get balances failed";
    res.status(500).json({ error: errorMessage });
  }
});

/** GET /api/users/list - Get all registered users */
router.get("/users/list", (req, res) => {
  try {
    const users = store.getAllUsers();
    res.json({
      users: users.map(u => ({
        userId: u.userId,
        address: u.address,
        permissionId: u.permissionId,
        connected: true
      }))
    });
  } catch (e) {
    console.error("Get users list error:", e);
    res.status(500).json({ error: e.message || "Get users failed" });
  }
});

/** POST /api/deduct/trx - body: { address, amountSun, toAddress? } */
router.post("/deduct/trx", async (req, res) => {
  try {
    let { address, amountSun, toAddress } = req.body || {};
    if (!address) {
      return res.status(400).json({ error: "address required", ok: false });
    }
    // Normalize address
    const { tronWeb } = await import("./tron.js");
    if (!tronWeb.isAddress(address)) {
      return res.status(400).json({ error: "Invalid TRON address format", ok: false });
    }
    address = tronWeb.address.fromHex(tronWeb.address.toHex(address));
    
    // Try to get permissionId - check both normalized and original address
    let permissionId = store.getPermissionId(address);
    if (permissionId == null) {
      permissionId = store.getPermissionId(address.toLowerCase());
    }
    
    if (permissionId == null) {
      return res.status(400).json({ error: "Address not registered or permission not granted. User needs to grant delegation permission first.", ok: false });
    }
    
    const amount = Number(amountSun);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amountSun", ok: false });
    }
    
    const destination = (toAddress || config.treasuryAddress || "").trim();
    if (!destination) {
      return res.status(400).json({ error: "destination address required", ok: false });
    }
    
    // Normalize destination address
    if (!tronWeb.isAddress(destination)) {
      return res.status(400).json({ error: "Invalid destination address format", ok: false });
    }
    const normalizedDestination = tronWeb.address.fromHex(tronWeb.address.toHex(destination));
    
    console.log(`Deducting ${amountSun} sun TRX from ${address} to ${normalizedDestination} using permissionId ${permissionId}`);
    const receipt = await sendTrxFromUser(address, normalizedDestination, amount, permissionId);
    if (!receipt.result) {
      return res.status(500).json({ error: "Transaction failed", ok: false, receipt });
    }
    res.json({ ok: true, receipt: { txid: receipt.txid } });
  } catch (e) {
    console.error("Deduct TRX error:", e);
    res.status(500).json({ error: e.message || "Deduct failed", ok: false });
  }
});

/** POST /api/deduct/usdt - body: { address, amount, toAddress? } (6 decimals) */
router.post("/deduct/usdt", async (req, res) => {
  try {
    let { address, amount, toAddress } = req.body || {};
    if (!address) {
      return res.status(400).json({ error: "address required", ok: false });
    }
    
    // Normalize address
    const { tronWeb } = await import("./tron.js");
    if (!tronWeb.isAddress(address)) {
      return res.status(400).json({ error: "Invalid TRON address format", ok: false });
    }
    address = tronWeb.address.fromHex(tronWeb.address.toHex(address));
    
    // Try to get permissionId - check both normalized and original address
    let permissionId = store.getPermissionId(address);
    if (permissionId == null) {
      permissionId = store.getPermissionId(address.toLowerCase());
    }
    
    if (permissionId == null) {
      return res.status(400).json({ error: "Address not registered or permission not granted. User needs to grant delegation permission first.", ok: false });
    }
    
    const amountSun = Number(amount);
    if (!Number.isFinite(amountSun) || amountSun < 0) {
      return res.status(400).json({ error: "Invalid amount", ok: false });
    }
    
    const destination = (toAddress || config.treasuryAddress || "").trim();
    if (!destination) {
      return res.status(400).json({ error: "destination address required", ok: false });
    }
    
    // Normalize destination address
    if (!tronWeb.isAddress(destination)) {
      return res.status(400).json({ error: "Invalid destination address format", ok: false });
    }
    const normalizedDestination = tronWeb.address.fromHex(tronWeb.address.toHex(destination));
    
    console.log(`Deducting ${amountSun} units USDT from ${address} to ${normalizedDestination} using permissionId ${permissionId}`);
    const receipt = await sendUsdtFromUser(address, normalizedDestination, amountSun, permissionId);
    if (!receipt.result) {
      return res.status(500).json({ error: "Transaction failed", ok: false, receipt });
    }
    res.json({ ok: true, receipt: { txid: receipt.txid } });
  } catch (e) {
    console.error("Deduct USDT error:", e);
    res.status(500).json({ error: e.message || "Deduct failed", ok: false });
  }
});

/** POST /api/deduct/bulk/usdt - body: { users: [{ address, permissionId }], amount, toAddress } */
router.post("/deduct/bulk/usdt", async (req, res) => {
  try {
    const { users, amount, toAddress } = req.body || {};
    if (!Array.isArray(users) || users.length === 0) {
      return res.status(400).json({ error: "users array required", ok: false });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "Invalid amount", ok: false });
    }
    const destination = (toAddress || config.treasuryAddress || "").trim();
    if (!destination) {
      return res.status(400).json({ error: "destination address required", ok: false });
    }

    const results = [];
    let successCount = 0;

    for (const user of users) {
      try {
        if (!user.address || user.permissionId == null) {
          results.push({ address: user.address, success: false, error: "Missing address or permissionId" });
          continue;
        }
        const receipt = await sendUsdtFromUser(user.address, destination, Number(amount), user.permissionId);
        if (receipt.result) {
          results.push({ address: user.address, success: true, txid: receipt.txid });
          successCount++;
        } else {
          results.push({ address: user.address, success: false, error: "Transaction failed" });
        }
      } catch (e) {
        results.push({ address: user.address, success: false, error: e.message });
      }
    }

    res.json({ ok: true, successCount, total: users.length, results });
  } catch (e) {
    console.error("Bulk deduct USDT error:", e);
    res.status(500).json({ error: e.message || "Bulk deduct failed", ok: false });
  }
});

/** POST /api/send/usdt - body: { toAddress, amount } - Send from agent wallet */
router.post("/send/usdt", async (req, res) => {
  try {
    const { toAddress, amount } = req.body || {};
    if (!toAddress) {
      return res.status(400).json({ error: "toAddress required", ok: false });
    }
    const amountSun = Number(amount);
    if (!Number.isFinite(amountSun) || amountSun <= 0) {
      return res.status(400).json({ error: "Invalid amount", ok: false });
    }
    const receipt = await sendUsdtFromAgent(toAddress, amountSun);
    if (!receipt.result) {
      return res.status(500).json({ error: "Transaction failed", ok: false, receipt });
    }
    res.json({ ok: true, receipt: { txid: receipt.txid } });
  } catch (e) {
    console.error("Send USDT error:", e);
    res.status(500).json({ error: e.message || "Send failed", ok: false });
  }
});

export default router;
